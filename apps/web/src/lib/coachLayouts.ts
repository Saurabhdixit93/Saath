export type CoachClass = "1A" | "2A" | "3A" | "3E" | "SL" | "CC" | "EC" | "2S";
export type RailSeatType = "LB" | "MB" | "UB" | "SL" | "SM" | "SU" | "WS" | "MS" | "AS";

export interface BerthSlot {
  seatNo: number;
  label: string;
  bay: number;
  seatType: RailSeatType;
  isSide: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CoachLayoutSpec {
  travelClass: CoachClass;
  capacity: number;
  bayCount: number;
  layoutRef: string;
  slots: BerthSlot[];
  viewBoxWidth: number;
  viewBoxHeight: number;
}

const VALID_CLASSES = new Set<CoachClass>(["1A", "2A", "3A", "3E", "SL", "CC", "EC", "2S"]);

const DEFAULT_CAPACITY: Record<CoachClass, number> = {
  "1A": 24,
  "2A": 48,
  "3A": 72,
  "3E": 83,
  SL: 72,
  CC: 78,
  EC: 56,
  "2S": 108,
};

const SUPPORTED_VARIANTS: Record<CoachClass, number[]> = {
  "1A": [24, 18],
  "2A": [48, 54],
  "3A": [72, 64],
  "3E": [83],
  SL: [72, 80],
  CC: [78],
  EC: [56],
  "2S": [108],
};

const MOD8_TYPES: RailSeatType[] = ["LB", "MB", "UB", "LB", "MB", "UB", "SL", "SU"];
const MOD6_2A_TYPES: RailSeatType[] = ["LB", "UB", "LB", "UB", "SL", "SU"];
const MOD9_3E_TYPES: RailSeatType[] = ["LB", "MB", "UB", "LB", "MB", "UB", "SL", "SM", "SU"];
const MOD5_CC_TYPES: RailSeatType[] = ["WS", "MS", "AS", "AS", "WS"];
const MOD4_EC_TYPES: RailSeatType[] = ["WS", "AS", "AS", "WS"];
const MOD6_2S_TYPES: RailSeatType[] = ["WS", "MS", "AS", "AS", "MS", "WS"];

export function normalizeCoachClass(travelClass?: string | null, coachCode?: string | null): CoachClass {
  if (travelClass) {
    const upper = travelClass.trim().toUpperCase() as CoachClass;
    if (VALID_CLASSES.has(upper)) {
      return upper;
    }
  }
  if (coachCode) {
    const prefix = coachCode.trim().toUpperCase().slice(0, 1);
    const map: Record<string, CoachClass> = {
      H: "1A",
      A: "2A",
      B: "3A",
      M: "3E",
      S: "SL",
      C: "CC",
      E: "EC",
      D: "2S",
    };
    if (prefix in map) {
      return map[prefix]!;
    }
  }
  return "3A";
}

export function defaultCapacityForClass(travelClass: CoachClass): number {
  return DEFAULT_CAPACITY[travelClass];
}

export function parseRailSeatNumber(rawSeat: number | string, travelClass: string): number {
  if (typeof rawSeat === "number") {
    if (!Number.isInteger(rawSeat)) {
      throw new Error(`Invalid rail seat number: ${rawSeat}`);
    }
    return rawSeat;
  }
  const cleaned = String(rawSeat).trim().toUpperCase();
  if (/^[1-9][0-9]*$/.test(cleaned)) {
    return Number.parseInt(cleaned, 10);
  }
  if (normalizeCoachClass(travelClass) === "1A") {
    const m = cleaned.match(/^([A-H])-([1-4])$/);
    if (m) {
      const counts = [4, 2, 4, 2, 4, 2, 4, 2];
      const cabinIdx = m[1]!.charCodeAt(0) - "A".charCodeAt(0);
      const berthIdx = Number.parseInt(m[2]!, 10);
      const capInCabin = counts[cabinIdx]!;
      if (berthIdx >= 1 && berthIdx <= capInCabin) {
        const offset = counts.slice(0, cabinIdx).reduce((a, b) => a + b, 0);
        return offset + berthIdx;
      }
      throw new Error(`Invalid 1A cabin berth ${rawSeat}: cabin ${m[1]} has ${capInCabin} berths`);
    }
  }
  throw new Error(`Invalid rail seat number: ${rawSeat}`);
}

export function seatToBayAndType(
  travelClass: string,
  seatNo: number | string,
  capacity?: number
): { bay: number; seatType: RailSeatType; isSide: boolean } {
  const cls = normalizeCoachClass(travelClass);
  const cap = capacity ?? DEFAULT_CAPACITY[cls];
  if (!SUPPORTED_VARIANTS[cls].includes(cap)) {
    throw new Error(`Unsupported capacity ${cap} for class ${cls}`);
  }

  const s = parseRailSeatNumber(seatNo, cls);
  if (!Number.isInteger(s) || s < 1 || s > cap) {
    throw new Error(`Seat ${seatNo} out of range 1..${cap} for class ${cls}`);
  }

  if (cls === "3A" || cls === "SL") {
    const bay = Math.floor((s - 1) / 8) + 1;
    const pos = (s - 1) % 8;
    return { bay, seatType: MOD8_TYPES[pos]!, isSide: pos >= 6 };
  }
  if (cls === "2A") {
    const bay = Math.floor((s - 1) / 6) + 1;
    const pos = (s - 1) % 6;
    return { bay, seatType: MOD6_2A_TYPES[pos]!, isSide: pos >= 4 };
  }
  if (cls === "1A") {
    const baySizes = cap === 18 ? [4, 2, 4, 2, 4, 2] : [4, 2, 4, 2, 4, 2, 4, 2];
    let running = 0;
    for (let i = 0; i < baySizes.length; i += 1) {
      const size = baySizes[i]!;
      if (s <= running + size) {
        const pos = s - running;
        return { bay: i + 1, seatType: pos % 2 === 1 ? "LB" : "UB", isSide: false };
      }
      running += size;
    }
    throw new Error(`Seat ${s} out of 1A range`);
  }
  if (cls === "3E") {
    if (s <= 81) {
      const bay = Math.floor((s - 1) / 9) + 1;
      const pos = (s - 1) % 9;
      return { bay, seatType: MOD9_3E_TYPES[pos]!, isSide: pos >= 6 };
    }
    return { bay: 10, seatType: s === 82 ? "SL" : "SU", isSide: true };
  }
  if (cls === "CC") {
    if (s <= 75) {
      const bay = Math.floor((s - 1) / 5) + 1;
      const pos = (s - 1) % 5;
      return { bay, seatType: MOD5_CC_TYPES[pos]!, isSide: false };
    }
    const row16: RailSeatType[] = ["WS", "MS", "AS"];
    return { bay: 16, seatType: row16[s - 76]!, isSide: false };
  }
  if (cls === "EC") {
    const bay = Math.floor((s - 1) / 4) + 1;
    const pos = (s - 1) % 4;
    return { bay, seatType: MOD4_EC_TYPES[pos]!, isSide: false };
  }
  // 2S
  const bay = Math.floor((s - 1) / 6) + 1;
  const pos = (s - 1) % 6;
  return { bay, seatType: MOD6_2S_TYPES[pos]!, isSide: false };
}

export function buildCoachLayout(travelClass: string, capacity?: number): CoachLayoutSpec {
  const cls = normalizeCoachClass(travelClass);
  const cap = capacity ?? DEFAULT_CAPACITY[cls];
  const slots: BerthSlot[] = [];

  const padX = 16;
  const padY = 16;
  const cellW = 54;
  const cellH = 34;
  const gap = 6;
  const aisle = 28;
  let maxBay = 1;

  for (let s = 1; s <= cap; s += 1) {
    const { bay, seatType, isSide } = seatToBayAndType(cls, s, cap);
    if (bay > maxBay) maxBay = bay;

    if (cls === "CC" || cls === "EC" || cls === "2S") {
      const rowY = padY + (bay - 1) * (cellH + 10);
      let pos = 0;
      let leftCount = 3;
      if (cls === "CC") {
        pos = s <= 75 ? (s - 1) % 5 : s - 76;
        leftCount = 3;
      } else if (cls === "EC") {
        pos = (s - 1) % 4;
        leftCount = 2;
      } else {
        pos = (s - 1) % 6;
        leftCount = 3;
      }
      const colX =
        pos < leftCount
          ? padX + pos * (cellW + gap)
          : padX + leftCount * (cellW + gap) + aisle + (pos - leftCount) * (cellW + gap);
      slots.push({
        seatNo: s,
        label: String(s),
        bay,
        seatType,
        isSide,
        x: colX,
        y: rowY,
        width: cellW,
        height: cellH,
      });
      continue;
    }

    if (cls === "1A") {
      const bayH = cellH * 2 + gap * 2;
      const bayY = padY + (bay - 1) * (bayH + 14);
      const baySizes = cap === 18 ? [4, 2, 4, 2, 4, 2] : [4, 2, 4, 2, 4, 2, 4, 2];
      const offset = baySizes.slice(0, bay - 1).reduce((a, b) => a + b, 0);
      const pos = s - offset - 1;
      const col = Math.floor(pos / 2);
      const tier = pos % 2;
      slots.push({
        seatNo: s,
        label: String(s),
        bay,
        seatType,
        isSide: false,
        x: padX + col * (cellW + gap),
        y: bayY + (1 - tier) * (cellH + gap),
        width: cellW,
        height: cellH,
      });
      continue;
    }

    if (cls === "2A") {
      const bayH = cellH * 2 + gap;
      const bayY = padY + (bay - 1) * (bayH + 16);
      const pos = (s - 1) % 6;
      let x: number;
      let y: number;
      if (pos < 4) {
        const col = Math.floor(pos / 2);
        const tier = pos % 2;
        x = padX + col * (cellW + gap);
        y = bayY + (1 - tier) * (cellH + gap);
      } else {
        x = padX + 2 * (cellW + gap) + aisle;
        y = bayY + (1 - (pos - 4)) * (cellH + gap);
      }
      slots.push({
        seatNo: s,
        label: String(s),
        bay,
        seatType,
        isSide,
        x,
        y,
        width: cellW,
        height: cellH,
      });
      continue;
    }

    if (cls === "3E") {
      const bayH = cellH * 3 + gap * 2;
      const bayY = padY + (bay - 1) * (bayH + 16);
      let x: number;
      let y: number;
      if (s <= 81) {
        const pos = (s - 1) % 9;
        if (pos < 6) {
          const col = Math.floor(pos / 3);
          const tier = pos % 3;
          x = padX + col * (cellW + gap);
          y = bayY + (2 - tier) * (cellH + gap);
        } else {
          const tier = pos - 6;
          x = padX + 2 * (cellW + gap) + aisle;
          y = bayY + (2 - tier) * (cellH + gap);
        }
      } else {
        const tier = s - 82;
        x = padX + 2 * (cellW + gap) + aisle;
        y = bayY + (2 - tier) * (cellH + gap);
      }
      slots.push({
        seatNo: s,
        label: String(s),
        bay,
        seatType,
        isSide,
        x,
        y,
        width: cellW,
        height: cellH,
      });
      continue;
    }

    // 3A & SL
    const bayH = cellH * 3 + gap * 2;
    const bayY = padY + (bay - 1) * (bayH + 16);
    const pos = (s - 1) % 8;
    let x: number;
    let y: number;
    if (pos < 6) {
      const col = Math.floor(pos / 3);
      const tier = pos % 3;
      x = padX + col * (cellW + gap);
      y = bayY + (2 - tier) * (cellH + gap);
    } else {
      const tier = pos - 6;
      x = padX + 2 * (cellW + gap) + aisle;
      y = bayY + (2 - tier) * (cellH + gap * 2);
    }
    slots.push({
      seatNo: s,
      label: String(s),
      bay,
      seatType,
      isSide,
      x,
      y,
      width: cellW,
      height: cellH,
    });
  }

  const maxX = Math.max(...slots.map((sl) => sl.x + sl.width), 240) + 16;
  const maxY = Math.max(...slots.map((sl) => sl.y + sl.height), 240) + 16;
  return {
    travelClass: cls,
    capacity: cap,
    bayCount: maxBay,
    layoutRef: `IR:${cls}:${cap}`,
    slots,
    viewBoxWidth: maxX,
    viewBoxHeight: maxY,
  };
}
