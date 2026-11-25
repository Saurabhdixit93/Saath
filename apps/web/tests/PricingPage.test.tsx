import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi, beforeEach } from "vitest";
import enMessages from "../messages/en.json";
import { AuthProvider } from "../src/components/AuthProvider";
import PricingPage from "../src/app/[locale]/pricing/page";
import { runAxe } from "../vitest.setup";

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/pricing",
  Link: ({ children, href, ...props }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

describe("PricingPage", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
  });

  it("renders R3 plans, completes sandbox ₹199 checkout, activates entitlement, and passes axe", async () => {
    // Seed an authenticated user session
    const header = btoa(JSON.stringify({ alg: "EdDSA", typ: "JWT" }));
    const payload = btoa(
      JSON.stringify({ sub: "user-1", kind: "user", exp: Math.floor(Date.now() / 1000) + 900 })
    );
    window.sessionStorage.setItem("saath_access", `${header}.${payload}.sig`);
    window.sessionStorage.setItem("saath_auth_kind", "user");

    let unlocked = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.endsWith("/v1/pricing/plans")) {
        return new Response(
          JSON.stringify({
            anti_seat_sale_guarantee: true,
            plans: [
              {
                code: "free_passenger",
                name: "Free Passenger",
                price_inr_paise: 0,
                currency: "INR",
                billing_type: "free",
                max_party_members: 4,
                organiser_dashboard: false,
                summary_export: false,
                b2b_api: false,
                widget_access: false,
                priority_seat_bump: false,
              },
              {
                code: "group_organiser_pass",
                name: "Group-Organiser Trip Pass",
                price_inr_paise: 19900,
                currency: "INR",
                billing_type: "per_trip",
                scope: "journey_or_party",
                max_party_members: 50,
                organiser_dashboard: true,
                summary_export: true,
                b2b_api: false,
                widget_access: false,
                priority_seat_bump: false,
              },
              {
                code: "b2b_partner",
                name: "B2B / API Partner",
                price_inr_paise: 0,
                currency: "INR",
                billing_type: "b2b",
                scope: "partner",
                max_party_members: 50,
                organiser_dashboard: true,
                summary_export: true,
                b2b_api: true,
                widget_access: true,
                priority_seat_bump: false,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.endsWith("/v1/me/entitlements")) {
        return new Response(
          JSON.stringify({
            entitlements: unlocked
              ? [
                  {
                    id: "ent-1",
                    plan_code: "group_organiser_pass",
                    features: { max_party_members: 50 },
                    status: "active",
                    valid_from: "2026-11-25T15:00:00Z",
                    created_at: "2026-11-25T15:00:00Z",
                  },
                ]
              : [],
            b2b_api_keys: [],
            free_party_limit: 4,
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.endsWith("/v1/journeys")) {
        return new Response(
          JSON.stringify({
            items: [
              {
                journey: {
                  id: "ji-1",
                  mode: "train",
                  carrier_code: "IR",
                  service_no: "12951",
                  service_date: "2026-11-27",
                  chart_state: "pending",
                  match_version: 0,
                },
                booking: {
                  id: "bk-1",
                  trust_tier: "verified_provider",
                  claim_conflict_flagged: false,
                },
                party_id: "pt-1",
                member_count: 2,
                seat_holders: [],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.endsWith("/v1/billing/checkout")) {
        return new Response(
          JSON.stringify({
            order_id: "ord-1",
            plan_code: "group_organiser_pass",
            provider: "sandbox",
            provider_order_id: "order_sbx_1",
            amount_paise: 19900,
            currency: "INR",
            checkout_mode: "sandbox",
            status: "created",
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.endsWith("/v1/billing/sandbox/complete")) {
        unlocked = true;
        return new Response(
          JSON.stringify({
            ok: true,
            order_id: "ord-1",
            status: "paid",
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response("{}", { status: 404 });
    });

    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    const { container } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AuthProvider>
          <PricingPage />
        </AuthProvider>
      </NextIntlClientProvider>
    );

    expect(await screen.findByText("Group-Organiser Trip Pass")).toBeInTheDocument();
    expect(await runAxe(container)).toHaveNoViolations();

    await user.click(screen.getByRole("button", { name: "Unlock Group-Organiser Pass (₹199)" }));
    await user.click(screen.getByRole("button", { name: "Proceed to pay ₹199" }));
    const payBtn = await screen.findByRole("button", { name: "Complete Sandbox Payment (₹199)" });
    await user.click(payBtn);

    await waitFor(() =>
      expect(screen.getByText(/group_organiser_pass · Active/)).toBeInTheDocument()
    );

    // B2B Partner checkout CTA uses B2B label instead of ₹199
    await user.click(screen.getByRole("button", { name: "Activate B2B Partner" }));
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).queryByRole("button", { name: "Proceed to pay ₹199" })
    ).not.toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "Activate B2B Partner" })
    ).toBeInTheDocument();
    vi.unstubAllGlobals();
  });
});
