import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import type { MatchCardDTO } from "@saath/contracts";
import enMessages from "../messages/en.json";
import { MatchCard } from "../src/components/MatchCard";
import { RequestSwapSheet } from "../src/components/RequestSwapSheet";
import { runAxe } from "../vitest.setup";

const PAIR_CARD: MatchCardDTO = {
  card_id: "mc_pair_1",
  kind: "pair",
  score: 92,
  label: "Perfect swap",
  you_give: "B3-11 UB",
  you_get: { coach: "B3", seat_type: "LB", bay: 3 },
  others: [
    {
      alias: "Passenger B3-LB #A1B",
      trust: "verified_provider",
      reliability: "6/6",
      responds_in: "~5m",
    },
  ],
  reasons: ["Frees a lower berth for a senior passenger", "Same coach and nearby bay"],
  reason_codes: ["frees_lower_for_senior", "nearby_bay"],
  segment: { overlap: "full" },
  karma_preview: { you: 50 },
};

const CYCLE3_CARD: MatchCardDTO = {
  card_id: "mc_cycle_3",
  kind: "cycle3",
  score: 86,
  label: "Perfect swap",
  you_give: "B3-11 UB",
  you_get: { coach: "B3", seat_type: "LB", bay: 2 },
  others: [
    {
      alias: "Passenger B3-LB #C2D",
      trust: "verified_provider",
      reliability: "New",
      responds_in: "~5m",
    },
    {
      alias: "Passenger B3-LB #E3F",
      trust: "verified_doc",
      reliability: "3/3",
      responds_in: "~10m",
    },
  ],
  reasons: ["3-way verified cycle swap"],
  reason_codes: ["3_way_cycle"],
  segment: { overlap: "full" },
  karma_preview: { you: 60 },
};

describe("MatchCard & RequestSwapSheet", () => {
  it("renders pair and cycle3 MatchCards with CycleSwapDiagram, privacy line, and passes axe", async () => {
    const user = userEvent.setup();
    const onRequest = vi.fn();

    const { container } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <main>
          <MatchCard card={PAIR_CARD} mode="train" onRequestSwap={onRequest} />
          <MatchCard card={CYCLE3_CARD} mode="train" onRequestSwap={onRequest} />
        </main>
      </NextIntlClientProvider>
    );

    expect(screen.getByText("92% match")).toBeInTheDocument();
    expect(screen.getAllByText(/name stays private/i).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/All 3 must accept/i)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Cycle swap diagram/i })).toBeInTheDocument();

    await user.click(screen.getAllByRole("button", { name: "Request swap" })[0]!);
    expect(onRequest).toHaveBeenCalledWith(PAIR_CARD);
    expect(await runAxe(container)).toHaveNoViolations();
  });

  it("submits RequestSwapSheet note cleanly", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => {});
    const onClose = vi.fn();

    const { container } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <RequestSwapSheet
          open={true}
          card={PAIR_CARD}
          onClose={onClose}
          onSubmit={onSubmit}
        />
      </NextIntlClientProvider>
    );

    await user.type(screen.getByLabelText(/Optional note/i), "Senior parent travelling");
    await user.click(screen.getByRole("button", { name: "Send swap request" }));
    expect(onSubmit).toHaveBeenCalledWith("mc_pair_1", "Senior parent travelling");
    expect(await runAxe(container)).toHaveNoViolations();
  });
});
