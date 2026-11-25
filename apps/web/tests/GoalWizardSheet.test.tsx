import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import enMessages from "../messages/en.json";
import { GoalWizardSheet } from "../src/components/GoalWizardSheet";
import { runAxe } from "../vitest.setup";

describe("GoalWizardSheet", () => {
  it("walks through all 3 wizard steps, submits women_only + goal payload, and passes axe", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => {});
    const onClose = vi.fn();

    const { container } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <GoalWizardSheet
          open={true}
          onClose={onClose}
          mode="train"
          members={[
            {
              id: "sh-1",
              pax_seq: 1,
              coach: "B5",
              seat_no: "11",
              seat_type: "UB",
              bay: 2,
              age_band: "senior",
              gender_band: "F",
            },
          ]}
          onSubmit={onSubmit}
        />
      </NextIntlClientProvider>
    );

    expect(await runAxe(container)).toHaveNoViolations();

    // Step 1 -> Step 2
    await user.click(screen.getByRole("button", { name: "Next" }));
    // Step 2: pick Lower berth -> Step 3
    await user.click(screen.getByRole("button", { name: "Lower berth" }));
    await user.click(screen.getByRole("button", { name: "Next" }));

    // Step 3: enable women_only & submit
    await user.click(screen.getByLabelText(/Women-only swaps/i));
    await user.click(screen.getByRole("button", { name: "Save swap goal" }));

    expect(onSubmit).toHaveBeenCalledWith({
      goal_type: "lower",
      movers: ["sh-1"],
      preferred_seats: [],
      constraints: {
        women_only: true,
        no_middle: false,
        same_coach_only: false,
        verified_only: false,
      },
      standing_offer: null,
    });
  });
});
