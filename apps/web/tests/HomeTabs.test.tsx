import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi, beforeEach } from "vitest";
import enMessages from "../messages/en.json";
import { AuthProvider } from "../src/components/AuthProvider";
import { HomeTabs } from "../src/components/HomeTabs";
import { runAxe } from "../vitest.setup";

describe("HomeTabs", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ access: "anon.jwt", token_type: "bearer", expires_in: 7200 }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
    );
  });

  it("extracts 10-digit PNR from IRCTC SMS, switches tabs via keyboard, and passes axe", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AuthProvider>
          <HomeTabs />
        </AuthProvider>
      </NextIntlClientProvider>
    );

    const pnrInput = screen.getByLabelText("10-digit PNR or IRCTC SMS") as HTMLInputElement;
    fireEvent.paste(pnrInput, {
      clipboardData: {
        getData: () => "IRCTC: PNR 4512890341 Train 12951 DOJ 25-11-26 B3-42",
      },
    });
    expect(pnrInput.value).toBe("4512890341");
    expect(screen.getByText(/Extracted 10-digit PNR 4512890341/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Verify →" }));
    expect(await screen.findByText(/PNR 4512890341 looks valid/)).toBeInTheDocument();

    const trainTab = screen.getByRole("tab", { name: "Train" });
    trainTab.focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Flight" })).toHaveAttribute("aria-selected", "true");

    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Bus" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Bus seat swaps are coming in v1.1")).toBeInTheDocument();

    expect(await runAxe(container)).toHaveNoViolations();

    // Verify PNR keyword priority over earlier 10-digit helpline number
    await user.click(screen.getByRole("tab", { name: "Train" }));
    const pnrInputAfter = screen.getByLabelText("10-digit PNR or IRCTC SMS") as HTMLInputElement;
    fireEvent.paste(pnrInputAfter, {
      clipboardData: {
        getData: () => "Helpline 1800111139. PNR:4512890341 Train 12951",
      },
    });
    expect(pnrInputAfter.value).toBe("4512890341");

    vi.unstubAllGlobals();
  });
});
