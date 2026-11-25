import { describe, expect, it } from "vitest";
import {
  AIRCRAFT_LAYOUTS,
  resolveAircraftLayout,
  validateAndClassifyFlightSeat,
} from "../src/lib/aircraftLayouts";

describe("aircraftLayouts", () => {
  it("validates and classifies seats across seeded Indian carriers and generic widebodies", () => {
    expect(Object.keys(AIRCRAFT_LAYOUTS)).toContain("6E:A320neo");
    expect(Object.keys(AIRCRAFT_LAYOUTS)).toContain("AI:B787-8");
    expect(Object.keys(AIRCRAFT_LAYOUTS)).toContain("generic:3-4-3");

    const exitWin = validateAndClassifyFlightSeat("6E:A320neo", "12A");
    expect(exitWin.seatType).toBe("WS");
    expect(exitWin.isExitRow).toBe(true);

    const mid = validateAndClassifyFlightSeat("6E:A320neo", "14B");
    expect(mid.seatType).toBe("MS");
    expect(mid.isExitRow).toBe(false);

    const aisle = validateAndClassifyFlightSeat("6E:A320neo", "14C");
    expect(aisle.seatType).toBe("AS");

    expect(resolveAircraftLayout(null, "QP").layoutRef).toBe("QP:737-MAX-8");
    expect(resolveAircraftLayout("6e:a320neo").layoutRef).toBe("6E:A320neo");
    expect(resolveAircraftLayout("737 MAX 8").layoutRef).toBe("QP:737-MAX-8");
    expect(resolveAircraftLayout("6E:ATR72").layoutRef).toBe("6E:ATR72-600");
    expect(resolveAircraftLayout("3-3").layoutRef).toBe("generic:3-3");
    expect(() => validateAndClassifyFlightSeat("6E:ATR72-600", "20A")).toThrow();
    expect(() => validateAndClassifyFlightSeat("6E:A320neo", "99A")).toThrow();
  });
});
