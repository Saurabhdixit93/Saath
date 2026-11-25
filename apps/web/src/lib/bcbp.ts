export interface BcbpLegPreview {
  legIndex: number;
  fromIata: string;
  toIata: string;
  carrierCode: string;
  flightNo: string;
  seatNo: string;
}

export function previewBcbp(raw: string): { numLegs: number; legs: BcbpLegPreview[] } | null {
  const trimmed = raw ? raw.trimStart().replace(/[\r\n\t]+$/, "") : "";
  if (!trimmed || trimmed.length < 60 || trimmed[0] !== "M") {
    return null;
  }
  const numLegs = Number.parseInt(trimmed[1] ?? "", 10);
  if (!Number.isInteger(numLegs) || numLegs < 1 || numLegs > 4) {
    return null;
  }

  const normalizeFlight = (carrier: string, flt: string) => {
    const c = carrier.trim().toUpperCase();
    const digits = flt.trim().toUpperCase().replace(/^0+/, "");
    return `${c}${digits}`;
  };

  const normalizeSeat = (seat: string) => {
    const m = seat.trim().toUpperCase().match(/^0*([1-9][0-9]{0,2}[A-K])$/);
    return m ? m[1]! : seat.trim().toUpperCase();
  };

  const legs: BcbpLegPreview[] = [
    {
      legIndex: 0,
      fromIata: trimmed.slice(30, 33).trim().toUpperCase(),
      toIata: trimmed.slice(33, 36).trim().toUpperCase(),
      carrierCode: trimmed.slice(36, 39).trim().toUpperCase(),
      flightNo: normalizeFlight(trimmed.slice(36, 39), trimmed.slice(39, 44)),
      seatNo: normalizeSeat(trimmed.slice(48, 52)),
    },
  ];

  const leg1Var = Number.parseInt(trimmed.slice(58, 60), 16);
  if (Number.isNaN(leg1Var)) {
    return { numLegs: 1, legs };
  }

  let cursor = 60 + leg1Var;
  for (let i = 1; i < numLegs && cursor + 37 <= trimmed.length; i += 1) {
    const block = trimmed.slice(cursor, cursor + 37);
    const varLen = Number.parseInt(block.slice(35, 37), 16);
    legs.push({
      legIndex: i,
      fromIata: block.slice(7, 10).trim().toUpperCase(),
      toIata: block.slice(10, 13).trim().toUpperCase(),
      carrierCode: block.slice(13, 16).trim().toUpperCase(),
      flightNo: normalizeFlight(block.slice(13, 16), block.slice(16, 21)),
      seatNo: normalizeSeat(block.slice(25, 29)),
    });
    cursor += 37 + (Number.isNaN(varLen) ? 0 : varLen);
  }

  return { numLegs: legs.length, legs };
}

export async function decodeBoardingPassFromImageData(imageData: ImageData): Promise<string | null> {
  const { readBarcodesFromImageData } = await import("zxing-wasm/reader");
  const results = await readBarcodesFromImageData(imageData, {
    formats: ["PDF417", "QRCode", "Aztec"],
    tryHarder: true,
    maxNumberOfSymbols: 3,
  });
  for (const res of results) {
    if (res.text && res.text.startsWith("M") && res.text.length >= 60) {
      return res.text;
    }
  }
  return results[0]?.text ?? null;
}

export async function decodeBoardingPassFromFile(file: File): Promise<string | null> {
  if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/build/pdf.worker.min.mjs",
      import.meta.url
    ).toString();
    const buffer = await file.arrayBuffer();
    const doc = await pdfjs.getDocument({ data: buffer }).promise;
    const page = await doc.getPage(1);
    const viewport = page.getViewport({ scale: 2.0 });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return null;
    }
    await page.render({ canvasContext: ctx, viewport }).promise;
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return decodeBoardingPassFromImageData(imageData);
  }

  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    return null;
  }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return decodeBoardingPassFromImageData(imageData);
}
