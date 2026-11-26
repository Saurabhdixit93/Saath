import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import enMessages from "../messages/en.json";
import { AuthProvider } from "../src/components/AuthProvider";
import { InviteLandingClient } from "../src/app/[locale]/j/[token]/InviteLandingClient";
import { runAxe } from "../vitest.setup";

const pushMock = vi.fn();

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn() }),
  usePathname: () => "/j/test",
  Link: ({ children, href, ...props }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

describe("InviteLandingClient", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
    pushMock.mockReset();
  });

  it("renders valid seat invite, submits verify with invite_token + open_to_help, and passes axe", async () => {
    const user = userEvent.setup();
    let verifyBody: Record<string, unknown> | null = null;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.endsWith("/v1/journeys/verify")) {
          verifyBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
          return new Response(
            JSON.stringify({
              journey: {
                id: "0193632e-0000-7000-8000-000000000901",
                mode: "train",
                carrier_code: "IR",
                service_no: "12951",
                service_date: "2026-11-28",
                chart_state: "pending",
                match_version: 1,
              },
              booking: {
                id: "0193632e-0000-7000-8000-000000000902",
                trust_tier: "verified_provider",
                claim_conflict_flagged: false,
              },
              seat_holders: [],
              party_id: "0193632e-0000-7000-8000-000000000903",
              party: { id: "0193632e-0000-7000-8000-000000000903" },
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

    const { container } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AuthProvider>
          <InviteLandingClient
            token="tok_valid_1234"
            invite={{
              valid: true,
              mode: "train",
              carrier_code: "IR",
              service_no: "12951",
              service_date: "2026-11-28",
              target_coach: "B5",
              target_seat_no: "11",
              expires_at: "2026-12-01T00:00:00Z",
              conversions_count: 1,
            }}
          />
        </AuthProvider>
      </NextIntlClientProvider>
    );

    expect(screen.getByText(/Coach B5 · Seat 11/)).toBeInTheDocument();
    const pnrInput = screen.getByRole("textbox");
    await user.type(pnrInput, "2415678902");
    await user.click(screen.getByRole("button", { name: /Verify & see matches/i }));

    await waitFor(() =>
      expect(pushMock).toHaveBeenCalledWith(
        "/journeys/0193632e-0000-7000-8000-000000000901"
      )
    );
    expect(verifyBody).toEqual({
      mode: "train",
      pnr: "2415678902",
      invite_token: "tok_valid_1234",
      open_to_help: true,
    });
    expect(await runAxe(container)).toHaveNoViolations();
    vi.unstubAllGlobals();
  });

  it("renders graceful expired/invalid fallback with Home link and passes axe", async () => {
    const { container } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AuthProvider>
          <InviteLandingClient token="expired_tok" invite={null} />
        </AuthProvider>
      </NextIntlClientProvider>
    );

    expect(screen.getByText(/Invite link expired or invalid/i)).toBeInTheDocument();
    const homeLink = screen.getByRole("link", { name: /Verify your PNR on Home/i });
    expect(homeLink).toHaveAttribute("href", "/");
    expect(await runAxe(container)).toHaveNoViolations();
  });
});
