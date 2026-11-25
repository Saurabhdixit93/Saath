import { describe, expect, it } from "vitest";
import {
  buildCoachLayout,
  normalizeCoachClass,
  seatToBayAndType,
} from "../src/lib/coachLayouts";

describe("coachLayouts parity with Python geometry", () => {
  it("computes exact capacities and bay/type mappings for all 8 rail classes", () => {
    const expected: Record<string, number> = {
      "1A": 24,
      "2A": 48,
      "3A": 72,
      "3E": 83,
      SL: 72,
      CC: 78,
      EC: 56,
      "2S": 108,
    };
    for (const [cls, cap] of Object.entries(expected)) {
      const spec = buildCoachLayout(cls);
      expect(spec.capacity).toBe(cap);
      expect(spec.slots.length).toBe(cap);
      expect(spec.layoutRef).toBe(`IR:${cls}:${cap}`);
    }

    expect(seatToBayAndType("3A", 7)).toEqual({ bay: 1, seatType: "SL", isSide: true });
    expect(seatToBayAndType("3E", 82)).toEqual({ bay: 10, seatType: "SL", isSide: true });
    expect(seatToBayAndType("3E", 83)).toEqual({ bay: 10, seatType: "SU", isSide: true });
    expect(seatToBayAndType("1A", 5)).toEqual({ bay: 2, seatType: "LB", isSide: false });
    expect(seatToBayAndType("CC", 76)).toEqual({ bay: 16, seatType: "WS", isSide: false });
    expect(seatToBayAndType("EC", 2)).toEqual({ bay: 1, seatType: "AS", isSide: false });
    expect(seatToBayAndType("2S", 108)).toEqual({ bay: 18, seatType: "WS", isSide: false });
    expect(normalizeCoachClass(null, "B5")).toBe("3A");
    expect(normalizeCoachClass(null, "H1")).toBe("1A");

    // 1A cabin notation & strict seat validation parity with geometry.py
    expect(seatToBayAndType("1A", "A-1")).toEqual({ bay: 1, seatType: "LB", isSide: false });
    expect(seatToBayAndType("1A", "B-2")).toEqual({ bay: 2, seatType: "UB", isSide: false });
    expect(() => seatToBayAndType("1A", "B-3")).toThrow();
    expect(() => seatToBayAndType("3A", "12abc")).toThrow();
    expect(() => seatToBayAndType("3A", "-1")).toThrow();
    expect(() => seatToBayAndType("3A", "0")).toThrow();
  });
});
