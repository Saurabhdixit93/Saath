import bwipjs from 'bwip-js';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { toJulianDay } from './env.js';

export type BcbpBarcodeFormat = 'pdf417' | 'qrcode' | 'azteccode';

export interface BcbpLegOptions {
  pnr: string;
  from: string;
  to: string;
  carrier: string;
  flightNo: string;
  /** Either numeric Julian day (1..366) or ISO date string `YYYY-MM-DD`. */
  julianDate: number | string;
  compartment?: string;
  seatNo: string;
  seqNo?: string;
  passengerStatus?: string;
  variableFieldSizeHex?: string;
}

export interface BcbpBuildOptions extends BcbpLegOptions {
  passengerName?: string;
  electronicTicket?: string;
  legs?: BcbpLegOptions[];
}

function padRight(value: string, length: number): string {
  return value.toUpperCase().slice(0, length).padEnd(length, ' ');
}

function formatCarrier(carrier: string): string {
  return padRight(carrier.trim(), 3);
}

function formatFlightNo(flightNo: string, carrier?: string): string {
  let cleaned = flightNo.trim().toUpperCase();
  const normalizedCarrier = carrier?.trim().toUpperCase();
  if (normalizedCarrier && cleaned.startsWith(normalizedCarrier)) {
    const remainder = cleaned.slice(normalizedCarrier.length).replace(/^[\s-]+/, '');
    if (/^\d+[A-Z]?$/.test(remainder)) {
      cleaned = remainder;
    }
  } else {
    const prefixed = /^(?:[A-Z][A-Z0-9]|[A-Z0-9][A-Z])[\s-]?(\d+[A-Z]?)$/.exec(cleaned);
    if (prefixed?.[1]) {
      cleaned = prefixed[1];
    }
  }

  const match = /^(\d+)([A-Z]?)$/.exec(cleaned);
  if (!match?.[1]) {
    throw new Error(
      `Invalid BCBP flightNo "${flightNo}": expected 1-4 digits with optional single-letter suffix`,
    );
  }
  if (match[1].length > 4) {
    throw new Error(
      `Invalid BCBP flightNo "${flightNo}": numeric flight number exceeds 4 digits`,
    );
  }
  const digits = match[1].padStart(4, '0');
  const suffix = match[2] || ' ';
  return `${digits}${suffix}`;
}

function formatJulian(julianDate: number | string): string {
  const dayNum =
    typeof julianDate === 'number' ? julianDate : toJulianDay(julianDate);
  if (!Number.isFinite(dayNum) || !Number.isInteger(dayNum) || dayNum < 1 || dayNum > 366) {
    throw new Error(
      `Invalid BCBP julianDate "${String(julianDate)}" (resolved to ${String(dayNum)}); expected integer in 1..366`,
    );
  }
  return String(dayNum).padStart(3, '0');
}

function formatSeatNo(seatNo: string): string {
  const cleaned = seatNo.trim().toUpperCase();
  const match = /^(\d+)([A-Z])$/.exec(cleaned);
  if (match?.[1] && match[2]) {
    return `${match[1].padStart(3, '0').slice(-3)}${match[2]}`;
  }
  return cleaned.padStart(4, '0').slice(-4);
}

function formatSeqNo(seqNo = '42'): string {
  const cleaned = seqNo.trim().toUpperCase();
  if (/^\d{1,4}$/.test(cleaned)) {
    return `${cleaned.padStart(4, '0')} `;
  }
  return padRight(cleaned, 5);
}

function buildLegBlock(leg: BcbpLegOptions): string {
  const pnr = padRight(leg.pnr, 7);
  const from = padRight(leg.from, 3);
  const to = padRight(leg.to, 3);
  const carrier = formatCarrier(leg.carrier);
  const flightNo = formatFlightNo(leg.flightNo, leg.carrier);
  const julian = formatJulian(leg.julianDate);
  const compartment = padRight(leg.compartment ?? 'Y', 1);
  const seat = formatSeatNo(leg.seatNo);
  const seq = formatSeqNo(leg.seqNo);
  const status = padRight(leg.passengerStatus ?? '1', 1);
  const varSize = (leg.variableFieldSizeHex ?? '00').toUpperCase().padStart(2, '0').slice(-2);

  return `${pnr}${from}${to}${carrier}${flightNo}${julian}${compartment}${seat}${seq}${status}${varSize}`;
}

/**
 * Builds an IATA Resolution 792 compliant BCBP string.
 * Single-leg output is exactly 60 characters; each extra leg adds 37 characters.
 */
export function buildBcbpString(opts: BcbpBuildOptions): string {
  const allLegs: BcbpLegOptions[] = [
    {
      pnr: opts.pnr,
      from: opts.from,
      to: opts.to,
      carrier: opts.carrier,
      flightNo: opts.flightNo,
      julianDate: opts.julianDate,
      compartment: opts.compartment,
      seatNo: opts.seatNo,
      seqNo: opts.seqNo,
      passengerStatus: opts.passengerStatus,
      variableFieldSizeHex: opts.variableFieldSizeHex,
    },
    ...(opts.legs ?? []),
  ];

  const legCount = String(allLegs.length);
  const name = padRight(opts.passengerName ?? 'SHARMA/NEHA', 20);
  const eTicket = padRight(opts.electronicTicket ?? 'E', 1);
  const header = `M${legCount}${name}${eTicket}`;

  return `${header}${allLegs.map(buildLegBlock).join('')}`;
}

export type MalformedBcbpKind =
  | 'short'
  | 'bad_format'
  | 'bad_leg_count'
  | 'bad_julian'
  | 'non_numeric_julian'
  | 'bad_hex_size'
  | 'bad_seat_format'
  | 'empty';

/**
 * Generates deterministic malformed IATA Resolution 792 vectors for negative testing.
 */
export function buildMalformedBcbp(kind: MalformedBcbpKind): string {
  const valid = buildBcbpString({
    passengerName: 'SHARMA/NEHA',
    pnr: 'K9P2QX',
    from: 'DEL',
    to: 'BOM',
    carrier: '6E',
    flightNo: '2134',
    julianDate: 330,
    seatNo: '14C',
    seqNo: '42',
  });

  switch (kind) {
    case 'empty':
      return '';
    case 'short':
      return valid.slice(0, 44);
    case 'bad_format':
      return `X${valid.slice(1)}`;
    case 'bad_leg_count':
      return `M9${valid.slice(2)}`;
    case 'bad_julian':
      return `${valid.slice(0, 44)}999${valid.slice(47)}`;
    case 'non_numeric_julian':
      return `${valid.slice(0, 44)}ABC${valid.slice(47)}`;
    case 'bad_hex_size':
      return `${valid.slice(0, 58)}ZZ`;
    case 'bad_seat_format':
      return `${valid.slice(0, 48)}XXXX${valid.slice(52)}`;
  }
}

/**
 * Generates a syntactically valid BCBP string whose seat does not exist on the aircraft layout.
 */
export function buildInvalidSeatBcbp(
  overrides: Partial<BcbpBuildOptions> = {},
): string {
  return buildBcbpString({
    passengerName: 'SHARMA/NEHA',
    pnr: 'K9P2QX',
    from: 'DEL',
    to: 'BOM',
    carrier: '6E',
    flightNo: '2134',
    julianDate: 330,
    seatNo: '99Z',
    seqNo: '42',
    ...overrides,
  });
}

/**
 * Renders a real scannable barcode PNG buffer (`pdf417`, `qrcode`, or `azteccode`) using `bwip-js`.
 */
export async function generateBcbpPng(
  bcbpString: string,
  format: BcbpBarcodeFormat = 'pdf417',
): Promise<Buffer> {
  const baseOpts: Parameters<typeof bwipjs.toBuffer>[0] = {
    bcid: format,
    text: bcbpString,
    scale: format === 'pdf417' ? 3 : 5,
    paddingwidth: 12,
    paddingheight: 12,
    backgroundcolor: 'FFFFFF',
    barcolor: '000000',
  };

  if (format === 'pdf417') {
    baseOpts.height = 12;
  }

  return bwipjs.toBuffer(baseOpts);
}

/**
 * Generates a real boarding pass PDF embedding a scannable `bwip-js` barcode PNG via `pdf-lib`.
 */
export async function generateBcbpPdf(
  bcbpString: string,
  format: BcbpBarcodeFormat = 'pdf417',
  metadata: { title?: string; subtitle?: string } = {},
): Promise<Buffer> {
  const pngBuffer = await generateBcbpPng(bcbpString, format);
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595, 420]);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontMono = await pdfDoc.embedFont(StandardFonts.Courier);
  const pngImage = await pdfDoc.embedPng(pngBuffer);

  const title = metadata.title ?? 'BOARDING PASS / E-TICKET';
  const subtitle =
    metadata.subtitle ??
    `PNR ${bcbpString.slice(23, 30).trim()}  ${bcbpString.slice(30, 33)} -> ${bcbpString.slice(33, 36)}  SEAT ${bcbpString.slice(48, 52).trim()}`;

  page.drawRectangle({
    x: 24,
    y: 24,
    width: 547,
    height: 372,
    borderColor: rgb(0.85, 0.82, 0.78),
    borderWidth: 1,
    color: rgb(1, 1, 1),
  });

  page.drawText(title, {
    x: 42,
    y: 356,
    size: 16,
    font: fontBold,
    color: rgb(0.11, 0.1, 0.09),
  });

  page.drawText(subtitle, {
    x: 42,
    y: 330,
    size: 11,
    font: fontMono,
    color: rgb(0.25, 0.25, 0.25),
  });

  const maxWidth = 500;
  const maxHeight = 200;
  const dims = pngImage.scaleToFit(maxWidth, maxHeight);

  page.drawImage(pngImage, {
    x: 42,
    y: 90,
    width: dims.width,
    height: dims.height,
  });

  const bytes = await pdfDoc.save();
  return Buffer.from(bytes);
}
