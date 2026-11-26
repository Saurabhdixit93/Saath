import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi, beforeEach } from "vitest";
import enMessages from "../messages/en.json";
import { AuthProvider } from "../src/components/AuthProvider";
import { HomeTabs } from "../src/components/HomeTabs";
import { runAxe } from "../vitest.setup";

const pushMock = vi.fn();

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn() }),
  usePathname: () => "/",
  Link: ({ children, href, ...props }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

describe("HomeTabs", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
    pushMock.mockReset();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.endsWith("/v1/journeys/verify")) {
          return new Response(
            JSON.stringify({
              journey: {
                id: "0193632e-0000-7000-8000-000000000101",
                mode: "train",
                carrier_code: "IR",
                service_no: "12951",
                service_date: "2026-11-27",
                chart_state: "pending",
                match_version: 0,
              },
              booking: {
                id: "0193632e-0000-7000-8000-000000000102",
                trust_tier: "verified_provider",
                claim_conflict_flagged: false,
              },
              seat_holders: [],
              party_id: "0193632e-0000-7000-8000-000000000103",
              trust_tier: "verified_provider",
              chart: { state: "pending" },
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        return new Response(
          JSON.stringify({ access: "anon.jwt", token_type: "bearer", expires_in: 7200 }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      })
    );
  });

  it("extracts 10-digit PNR from IRCTC SMS, verifies journey, switches tabs via keyboard, and passes axe", async () => {
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
    await waitFor(() =>
      expect(pushMock).toHaveBeenCalledWith(
        "/journeys/0193632e-0000-7000-8000-000000000101"
      )
    );

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
