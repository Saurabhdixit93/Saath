import zlib from 'node:zlib';

export const EXPECTED_DPDP_EXPORT_FILES = [
  'profile.json',
  'consents.json',
  'journeys.json',
  'parties.json',
  'swaps.json',
  'messages.json',
  'karma.json',
  'badges.json',
] as const;

export interface ZipEntry {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  data: Buffer;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;

/**
 * Minimal standard-library ZIP reader using the Central Directory + `node:zlib`.
 * Supports STORE (0) and DEFLATE (8) entries without external dependencies.
 */
export function parseZipEntries(buffer: Buffer): Map<string, ZipEntry> {
  if (buffer.byteLength < 22) {
    throw new Error(`Invalid ZIP buffer: length ${buffer.byteLength} < 22`);
  }

  const minOffset = Math.max(0, buffer.byteLength - 65557);
  let eocdOffset = -1;
  for (let offset = buffer.byteLength - 22; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) {
      eocdOffset = offset;
      break;
    }
  }

  if (eocdOffset === -1) {
    throw new Error('ZIP End of Central Directory (EOCD) signature not found');
  }

  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirOffset = buffer.readUInt32LE(eocdOffset + 16);

  if (centralDirOffset >= buffer.byteLength) {
    throw new Error(`Invalid ZIP central directory offset: ${centralDirOffset}`);
  }

  const entries = new Map<string, ZipEntry>();
  let cursor = centralDirOffset;

  for (let i = 0; i < totalEntries; i += 1) {
    if (cursor + 46 > buffer.byteLength) {
      throw new Error(`Truncated ZIP central directory header at entry ${i}`);
    }
    const sig = buffer.readUInt32LE(cursor);
    if (sig !== CENTRAL_DIR_SIGNATURE) {
      throw new Error(
        `Unexpected ZIP central directory signature 0x${sig.toString(16)} at offset ${cursor}`,
      );
    }

    const compressionMethod = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const fileNameLen = buffer.readUInt16LE(cursor + 28);
    const extraLen = buffer.readUInt16LE(cursor + 30);
    const commentLen = buffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);

    const nameStart = cursor + 46;
    const name = buffer.subarray(nameStart, nameStart + fileNameLen).toString('utf8');

    if (localHeaderOffset + 30 > buffer.byteLength) {
      throw new Error(`Truncated local file header for "${name}"`);
    }
    const localSig = buffer.readUInt32LE(localHeaderOffset);
    if (localSig !== LOCAL_HEADER_SIGNATURE) {
      throw new Error(
        `Unexpected local file header signature 0x${localSig.toString(16)} for "${name}"`,
      );
    }

    const localNameLen = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressedSize;

    if (dataEnd > buffer.byteLength) {
      throw new Error(`Truncated entry payload for "${name}"`);
    }

    const compressedData = buffer.subarray(dataStart, dataEnd);
    let data: Buffer;
    if (compressionMethod === 0) {
      data = Buffer.from(compressedData);
    } else if (compressionMethod === 8) {
      data = zlib.inflateRawSync(compressedData);
    } else {
      throw new Error(`Unsupported ZIP compression method ${compressionMethod} for "${name}"`);
    }

    if (uncompressedSize !== 0xffffffff && data.byteLength !== uncompressedSize) {
      throw new Error(
        `Uncompressed size mismatch for "${name}": expected ${uncompressedSize}, got ${data.byteLength}`,
      );
    }

    entries.set(name, {
      name,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      data,
    });

    cursor += 46 + fileNameLen + extraLen + commentLen;
  }

  return entries;
}

/**
 * Parses a DPDP export ZIP buffer, ensures all 8 expected JSON files exist and parse cleanly,
 * and returns the decoded JSON map keyed by filename.
 */
export function parseDpdpExportZip(buffer: Buffer): Record<string, unknown> {
  const entries = parseZipEntries(buffer);
  const parsed: Record<string, unknown> = {};

  for (const fileName of EXPECTED_DPDP_EXPORT_FILES) {
    const entry =
      entries.get(fileName) ??
      Array.from(entries.values()).find((e) => e.name.endsWith(`/${fileName}`));
    if (!entry) {
      throw new Error(
        `DPDP export ZIP missing "${fileName}". Present entries: ${Array.from(entries.keys()).join(', ')}`,
      );
    }
    const text = entry.data.toString('utf8');
    try {
      parsed[fileName] = JSON.parse(text) as unknown;
    } catch (err) {
      throw new Error(
        `DPDP export entry "${fileName}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return parsed;
}
