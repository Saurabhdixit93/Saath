import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import type { CoachMapResponse } from "@saath/contracts";
import enMessages from "../messages/en.json";
import { CoachBerthMap } from "../src/components/CoachBerthMap";
import { CoachMap } from "../src/components/CoachMap";
import { runAxe } from "../vitest.setup";

function makeMap(travelClass: string, coach: string): CoachMapResponse {
  return {
    journey_id: "0193632e-0000-7000-8000-000000000001",
    mode: "train",
    coach,
    travel_class: travelClass,
    layout_ref: `IR:${travelClass}:72`,
    match_version: 2,
    coaches: [coach, "B4"],
    seats: [
      {
        seat_no: "11",
        bay: 2,
        seat_type: "UB",
        is_side: false,
        is_exit_row: false,
        is_premium: false,
        state: "mine",
        card_id: null,
        alias: null,
      },
      {
        seat_no: "12",
        bay: 2,
        seat_type: "LB",
        is_side: false,
        is_exit_row: false,
        is_premium: false,
        state: "match",
        card_id: "mc_1",
        alias: "Passenger B3-LB #A1B",
      },
    ],
  };
}

describe("CoachMap", () => {
  it("renders ARIA berth labels, role=option keyboard nav, legend, and passes axe across classes", async () => {
    const user = userEvent.setup();
    const onSelectMatchSeat = vi.fn();

    for (const [cls, coach] of [
      ["3A", "B3"],
      ["2A", "A1"],
      ["1A", "H1"],
      ["3E", "M1"],
      ["CC", "C1"],
    ] as const) {
      const { container, unmount } = render(
        <NextIntlClientProvider locale="en" messages={enMessages}>
          <CoachMap
            mapData={makeMap(cls, coach)}
            onSelectMatchSeat={onSelectMatchSeat}
          />
        </NextIntlClientProvider>
      );

      expect(screen.getByRole("listbox")).toBeInTheDocument();
      const mineOption = screen.getByRole("option", {
        name: new RegExp(`Coach ${coach}, berth 11`, "i"),
      });
      expect(mineOption).toBeInTheDocument();
      expect(screen.getByText("Your seat")).toBeInTheDocument();
      expect(screen.getByText("Match")).toBeInTheDocument();
      expect(await runAxe(container)).toHaveNoViolations();
      unmount();
    }

    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <CoachMap
          mapData={makeMap("3A", "B3")}
          onSelectMatchSeat={onSelectMatchSeat}
        />
      </NextIntlClientProvider>
    );

    const firstOption = screen.getByRole("option", {
      name: /Coach B3, berth 1, Lower Berth/i,
    });
    firstOption.focus();
    await user.keyboard("{ArrowRight}");
    const secondOption = screen.getByRole("option", {
      name: /Coach B3, berth 2, Middle Berth/i,
    });
    expect(secondOption).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onSelectMatchSeat).toHaveBeenCalled();

    // Geometry-aware ArrowUp / ArrowDown in 3A (berth 1 LB -> ArrowUp -> berth 2 MB)
    firstOption.focus();
    await user.keyboard("{ArrowUp}");
    expect(secondOption).toHaveFocus();
  });

  it("renders interactive CoachBerthMap with role=listbox and role=option", async () => {
    const user = userEvent.setup();
    const onToggleSeat = vi.fn();
    const { container } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <CoachBerthMap
          travelClass="CC"
          coachLabel="C1"
          mySeats={["1"]}
          selectedSeats={["6"]}
          onToggleSeat={onToggleSeat}
        />
      </NextIntlClientProvider>
    );

    expect(screen.getByRole("listbox")).toBeInTheDocument();
    const seat1 = screen.getByRole("option", { name: /Seat 1 WS bay 1/i });
    seat1.focus();
    await user.keyboard("{ArrowDown}");
    const seat6 = screen.getByRole("option", { name: /Seat 6 WS bay 2/i });
    expect(seat6).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onToggleSeat).toHaveBeenCalledWith("6");
    expect(await runAxe(container)).toHaveNoViolations();
  });
});
