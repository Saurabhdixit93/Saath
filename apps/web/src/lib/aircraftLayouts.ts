export type FlightSeatType = "WS" | "MS" | "AS";

export interface AircraftLayoutSpec {
  layoutRef: string;
  carrierCode: string;
  aircraftName: string;
  configuration: string;
  rows: number;
  columns: string[];
  aisleAfterIndices: number[];
  exitRows: number[];
  premiumRows: number[];
  excludedSeats: string[];
  totalSeats: number;
}

export interface AircraftSeatInfo {
  seatNo: string;
  row: number;
  col: number;
  letter: string;
  seatType: FlightSeatType;
  isExitRow: boolean;
  isPremium: boolean;
}

function makeLayout(spec: Omit<AircraftLayoutSpec, "totalSeats">): AircraftLayoutSpec {
  return {
    ...spec,
    totalSeats: spec.rows * spec.columns.length - spec.excludedSeats.length,
  };
}

export const AIRCRAFT_LAYOUTS: Record<string, AircraftLayoutSpec> = {
  "6E:A320neo": makeLayout({
    layoutRef: "6E:A320neo",
    carrierCode: "6E",
    aircraftName: "IndiGo Airbus A320neo (186)",
    configuration: "3-3",
    rows: 31,
    columns: ["A", "B", "C", "D", "E", "F"],
    aisleAfterIndices: [2],
    exitRows: [12, 13],
    premiumRows: [1, 12, 13],
    excludedSeats: [],
  }),
  "6E:A321neo": makeLayout({
    layoutRef: "6E:A321neo",
    carrierCode: "6E",
    aircraftName: "IndiGo Airbus A321neo (222)",
    configuration: "3-3",
    rows: 37,
    columns: ["A", "B", "C", "D", "E", "F"],
    aisleAfterIndices: [2],
    exitRows: [17, 18, 28],
    premiumRows: [1, 17, 18, 28],
    excludedSeats: [],
  }),
  "6E:ATR72-600": makeLayout({
    layoutRef: "6E:ATR72-600",
    carrierCode: "6E",
    aircraftName: "IndiGo ATR 72-600 (78)",
    configuration: "2-2",
    rows: 20,
    columns: ["A", "C", "D", "F"],
    aisleAfterIndices: [1],
    exitRows: [1, 19],
    premiumRows: [1],
    excludedSeats: ["20A", "20C"],
  }),
  "QP:737-MAX-8": makeLayout({
    layoutRef: "QP:737-MAX-8",
    carrierCode: "QP",
    aircraftName: "Akasa Air Boeing 737 MAX 8 (189)",
    configuration: "3-3",
    rows: 32,
    columns: ["A", "B", "C", "D", "E", "F"],
    aisleAfterIndices: [2],
    exitRows: [15, 16],
    premiumRows: [1, 15, 16],
    excludedSeats: ["32A", "32B", "32C"],
  }),
  "IX:737-8": makeLayout({
    layoutRef: "IX:737-8",
    carrierCode: "IX",
    aircraftName: "Air India Express Boeing 737-8 (189)",
    configuration: "3-3",
    rows: 32,
    columns: ["A", "B", "C", "D", "E", "F"],
    aisleAfterIndices: [2],
    exitRows: [15, 16],
    premiumRows: [1, 15, 16],
    excludedSeats: ["32A", "32B", "32C"],
  }),
  "IX:737-8-176": makeLayout({
    layoutRef: "IX:737-8-176",
    carrierCode: "IX",
    aircraftName: "Air India Express Boeing 737-8 (176)",
    configuration: "3-3",
    rows: 30,
    columns: ["A", "B", "C", "D", "E", "F"],
    aisleAfterIndices: [2],
    exitRows: [14, 15],
    premiumRows: [1, 14, 15],
    excludedSeats: ["30A", "30B", "30C", "1C"],
  }),
  "AI:A320neo": makeLayout({
    layoutRef: "AI:A320neo",
    carrierCode: "AI",
    aircraftName: "Air India Airbus A320neo (180)",
    configuration: "3-3",
    rows: 30,
    columns: ["A", "B", "C", "D", "E", "F"],
    aisleAfterIndices: [2],
    exitRows: [12, 13],
    premiumRows: [1, 2, 3, 12, 13],
    excludedSeats: [],
  }),
  "AI:A321neo": makeLayout({
    layoutRef: "AI:A321neo",
    carrierCode: "AI",
    aircraftName: "Air India Airbus A321neo (222)",
    configuration: "3-3",
    rows: 37,
    columns: ["A", "B", "C", "D", "E", "F"],
    aisleAfterIndices: [2],
    exitRows: [17, 18, 28],
    premiumRows: [1, 2, 3, 17, 18, 28],
    excludedSeats: [],
  }),
  "AI:B787-8": makeLayout({
    layoutRef: "AI:B787-8",
    carrierCode: "AI",
    aircraftName: "Air India Boeing 787-8 Dreamliner",
    configuration: "3-3-3",
    rows: 32,
    columns: ["A", "B", "C", "D", "E", "G", "H", "J", "K"],
    aisleAfterIndices: [2, 5],
    exitRows: [12, 24],
    premiumRows: [1, 2, 3, 12, 24],
    excludedSeats: [],
  }),
  "AI:B777-300ER": makeLayout({
    layoutRef: "AI:B777-300ER",
    carrierCode: "AI",
    aircraftName: "Air India Boeing 777-300ER",
    configuration: "3-3-3",
    rows: 42,
    columns: ["A", "B", "C", "D", "E", "G", "H", "J", "K"],
    aisleAfterIndices: [2, 5],
    exitRows: [16, 30],
    premiumRows: [1, 2, 3, 16, 30],
    excludedSeats: [],
  }),
  "SG:737-800": makeLayout({
    layoutRef: "SG:737-800",
    carrierCode: "SG",
    aircraftName: "SpiceJet Boeing 737-800 (189)",
    configuration: "3-3",
    rows: 32,
    columns: ["A", "B", "C", "D", "E", "F"],
    aisleAfterIndices: [2],
    exitRows: [16, 17],
    premiumRows: [1, 16, 17],
    excludedSeats: ["32A", "32B", "32C"],
  }),
  "SG:737-MAX-8": makeLayout({
    layoutRef: "SG:737-MAX-8",
    carrierCode: "SG",
    aircraftName: "SpiceJet Boeing 737 MAX 8 (189)",
    configuration: "3-3",
    rows: 32,
    columns: ["A", "B", "C", "D", "E", "F"],
    aisleAfterIndices: [2],
    exitRows: [15, 16],
    premiumRows: [1, 15, 16],
    excludedSeats: ["32A", "32B", "32C"],
  }),
  "generic:3-3": makeLayout({
    layoutRef: "generic:3-3",
    carrierCode: "GEN",
    aircraftName: "Generic Narrowbody (3-3)",
    configuration: "3-3",
    rows: 32,
    columns: ["A", "B", "C", "D", "E", "F"],
    aisleAfterIndices: [2],
    exitRows: [12, 13],
    premiumRows: [1],
    excludedSeats: [],
  }),
  "generic:2-2": makeLayout({
    layoutRef: "generic:2-2",
    carrierCode: "GEN",
    aircraftName: "Generic Regional Turboprop (2-2)",
    configuration: "2-2",
    rows: 20,
    columns: ["A", "C", "D", "F"],
    aisleAfterIndices: [1],
    exitRows: [1, 19],
    premiumRows: [1],
    excludedSeats: [],
  }),
  "generic:3-3-3": makeLayout({
    layoutRef: "generic:3-3-3",
    carrierCode: "GEN",
    aircraftName: "Generic Widebody (3-3-3)",
    configuration: "3-3-3",
    rows: 40,
    columns: ["A", "B", "C", "D", "E", "G", "H", "J", "K"],
    aisleAfterIndices: [2, 5],
    exitRows: [16, 28],
    premiumRows: [1, 16, 28],
    excludedSeats: [],
  }),
  "generic:3-4-3": makeLayout({
    layoutRef: "generic:3-4-3",
    carrierCode: "GEN",
    aircraftName: "Generic High-Density Widebody (3-4-3)",
    configuration: "3-4-3",
    rows: 44,
    columns: ["A", "B", "C", "D", "E", "F", "G", "H", "J", "K"],
    aisleAfterIndices: [2, 6],
    exitRows: [17, 31],
    premiumRows: [1, 17, 31],
    excludedSeats: [],
  }),
  "generic:2-4-2": makeLayout({
    layoutRef: "generic:2-4-2",
    carrierCode: "GEN",
    aircraftName: "Generic Widebody (2-4-2)",
    configuration: "2-4-2",
    rows: 36,
    columns: ["A", "C", "D", "E", "F", "G", "H", "K"],
    aisleAfterIndices: [1, 5],
    exitRows: [15, 27],
    premiumRows: [1, 15, 27],
    excludedSeats: [],
  }),
  "generic:1-2": makeLayout({
    layoutRef: "generic:1-2",
    carrierCode: "GEN",
    aircraftName: "Generic Regional Jet (1-2)",
    configuration: "1-2",
    rows: 24,
    columns: ["A", "D", "F"],
    aisleAfterIndices: [0],
    exitRows: [1, 12],
    premiumRows: [1],
    excludedSeats: [],
  }),
};

const LAYOUT_ALIASES: Record<string, string> = {
  "737 MAX 8": "QP:737-MAX-8",
  "QP:737 MAX 8": "QP:737-MAX-8",
  "SG:737 MAX 8": "SG:737-MAX-8",
  "6E:ATR72": "6E:ATR72-600",
  "3-3": "generic:3-3",
  "2-2": "generic:2-2",
  "3-3-3": "generic:3-3-3",
  "3-4-3": "generic:3-4-3",
  "2-4-2": "generic:2-4-2",
  "1-2": "generic:1-2",
};

const LOWER_LAYOUT_KEYS: Record<string, string> = Object.fromEntries(
  Object.keys(AIRCRAFT_LAYOUTS).map((k) => [k.toLowerCase(), k])
);
const LOWER_ALIASES: Record<string, string> = Object.fromEntries(
  Object.entries(LAYOUT_ALIASES).map(([k, v]) => [k.toLowerCase(), v])
);

const CARRIER_DEFAULT_LAYOUT: Record<string, string> = {
  "6E": "6E:A320neo",
  QP: "QP:737-MAX-8",
  IX: "IX:737-8",
  AI: "AI:A320neo",
  SG: "SG:737-800",
};

export function resolveAircraftLayout(layoutRef?: string | null, carrierCode = ""): AircraftLayoutSpec {
  if (layoutRef) {
    const lowered = layoutRef.trim().toLowerCase();
    const canonical = LOWER_ALIASES[lowered] ?? LOWER_LAYOUT_KEYS[lowered];
    if (canonical && canonical in AIRCRAFT_LAYOUTS) {
      return AIRCRAFT_LAYOUTS[canonical]!;
    }
  }
  const carrierDefault = CARRIER_DEFAULT_LAYOUT[carrierCode.trim().toUpperCase()];
  if (carrierDefault && carrierDefault in AIRCRAFT_LAYOUTS) {
    return AIRCRAFT_LAYOUTS[carrierDefault]!;
  }
  return AIRCRAFT_LAYOUTS["generic:3-3"]!;
}

export function seatTypeForColumn(spec: AircraftLayoutSpec, colIdx: number): FlightSeatType {
  if (colIdx === 0 || colIdx === spec.columns.length - 1) {
    return "WS";
  }
  if (spec.aisleAfterIndices.includes(colIdx) || spec.aisleAfterIndices.includes(colIdx - 1)) {
    return "AS";
  }
  return "MS";
}

export function validateAndClassifyFlightSeat(
  layoutRef: string | null | undefined,
  seatNo: string,
  carrierCode = ""
): AircraftSeatInfo {
  const spec = resolveAircraftLayout(layoutRef, carrierCode);
  const match = seatNo.trim().toUpperCase().match(/^0*([1-9][0-9]{0,2})([A-K])$/);
  if (!match) {
    throw new Error(`Invalid flight seat number: ${seatNo}`);
  }
  const row = Number.parseInt(match[1]!, 10);
  const letter = match[2]!;
  const normalized = `${row}${letter}`;

  if (row < 1 || row > spec.rows || !spec.columns.includes(letter) || spec.excludedSeats.includes(normalized)) {
    throw new Error(`Seat ${normalized} does not exist on ${spec.layoutRef}`);
  }

  const col = spec.columns.indexOf(letter);
  return {
    seatNo: normalized,
    row,
    col,
    letter,
    seatType: seatTypeForColumn(spec, col),
    isExitRow: spec.exitRows.includes(row),
    isPremium: spec.premiumRows.includes(row),
  };
}
