const LABELED_PNR_REGEX = /\bPNR\s*(?:NO\.?|NUMBER)?\s*[:\-]?\s*([0-9]{10})\b/i;
const TEN_DIGIT_PNR_REGEX = /\b([0-9]{10})\b/;

export interface PnrParseResult {
  pnr: string | null;
  extractedFromSms: boolean;
  isValid: boolean;
}

export function parsePnrInput(raw: string): PnrParseResult {
  const trimmed = raw.trim();
  if (/^[0-9]{10}$/.test(trimmed)) {
    return { pnr: trimmed, extractedFromSms: false, isValid: true };
  }

  // Prefer explicit PNR-labeled match before falling back to any 10-digit number
  const labeledMatch = trimmed.match(LABELED_PNR_REGEX);
  if (labeledMatch && labeledMatch[1]) {
    return { pnr: labeledMatch[1], extractedFromSms: true, isValid: true };
  }

  // Extract 10-digit PNR from pasted IRCTC SMS / ticket snippet
  const match = trimmed.match(TEN_DIGIT_PNR_REGEX);
  if (match && match[1]) {
    return { pnr: match[1], extractedFromSms: true, isValid: true };
  }

  return { pnr: null, extractedFromSms: false, isValid: false };
}
