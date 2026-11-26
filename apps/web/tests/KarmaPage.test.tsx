import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import enMessages from "../messages/en.json";
import hiMessages from "../messages/hi.json";
import { AuthProvider } from "../src/components/AuthProvider";
import KarmaPage from "../src/app/[locale]/karma/page";
import { runAxe } from "../vitest.setup";

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/karma",
  Link: ({ children, href, ...props }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

function seedUserSession() {
  const header = btoa(JSON.stringify({ alg: "EdDSA", typ: "JWT" }));
  const payload = btoa(
    JSON.stringify({
      sub: "0193632e-0000-7000-8000-000000000777",
      kind: "user",
      exp: Math.floor(Date.now() / 1000) + 900,
    })
  );
  window.sessionStorage.setItem("saath_access", `${header}.${payload}.sig`);
  window.sessionStorage.setItem("saath_auth_kind", "user");
}

function makeMePayload(optIn: boolean) {
  return {
    id: "0193632e-0000-7000-8000-000000000777",
    display_alias: "HelpfulRail21",
    gender_self: "undisclosed",
    locale: "en",
    women_only_default: false,
    reliability_accepted: 3,
    reliability_completed: 2,
    status: "active",
    leaderboard_opt_in: optIn,
    notification_channels: {
      push: true,
      whatsapp: true,
      sms: true,
      quiet_hours_enabled: true,
    },
    created_at: "2026-11-20T10:00:00Z",
  };
}

describe("KarmaPage", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
  });

  it("renders unauthenticated sign-in prompt and passes axe", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ access: "anon.jwt", token_type: "bearer", expires_in: 7200 }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
    );

    const { container } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AuthProvider>
          <KarmaPage />
        </AuthProvider>
      </NextIntlClientProvider>
    );

    await waitFor(() =>
      expect(
        screen.getByText(/Verify your phone to view your Karma wallet/i)
      ).toBeInTheDocument()
    );
    expect(screen.getByRole("button", { name: /Verify phone number/i })).toBeInTheDocument();
    expect(await runAxe(container)).toHaveNoViolations();
    vi.unstubAllGlobals();
  });

  it("renders wallet, badges, leaderboard opt-in toggle, history, and disabled rewards 403 fallback", async () => {
    seedUserSession();
    const user = userEvent.setup();
    let optIn = false;
    let patchBody: Record<string, unknown> | null = null;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        const method =
          input instanceof Request ? input.method : (init?.method ?? "GET");

        if (url.endsWith("/v1/me") && method === "GET") {
          return new Response(JSON.stringify(makeMePayload(optIn)), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.endsWith("/v1/me") && method === "PATCH") {
          const raw =
            input instanceof Request
              ? await input.clone().text()
              : String(init?.body ?? "{}");
          patchBody = JSON.parse(raw || "{}") as Record<string, unknown>;
          optIn = Boolean(patchBody.leaderboard_opt_in);
          return new Response(JSON.stringify(makeMePayload(optIn)), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.endsWith("/v1/karma")) {
          return new Response(
            JSON.stringify({
              balance: 150,
              pending: 50,
              redeemed_points: 30,
              available_balance: 120,
              history: [
                {
                  id: 2,
                  proposal_id: "0193632e-0000-7000-8000-000000000099",
                  delta: 150,
                  points: 150,
                  state: "credited",
                  reason: "swap_completed",
                  created_at: "2026-11-25T10:00:00Z",
                },
                {
                  id: 1,
                  proposal_id: "0193632e-0000-7000-8000-000000000098",
                  delta: -75,
                  points: 75,
                  state: "reversed",
                  reason: "dispute:no",
                  created_at: "2026-11-24T10:00:00Z",
                },
              ],
              badges: [
                {
                  code: "first_swap",
                  title: "First Swap",
                  description: "Completed your first verified seat swap on Saath.",
                  earned_at: "2026-11-25T10:00:00Z",
                },
              ],
              leaderboard: optIn
                ? [
                    {
                      rank: 1,
                      display_alias: "HelpfulRail21",
                      points: 150,
                      swaps_completed: 2,
                    },
                  ]
                : [],
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        if (url.endsWith("/v1/karma/rewards")) {
          return new Response(
            JSON.stringify({
              type: "https://saath.app/problems/rewards_disabled",
              title: "Rewards Catalogue Disabled",
              status: 403,
              detail: "The Karma rewards catalogue is not enabled.",
              code: "rewards_disabled",
            }),
            { status: 403, headers: { "content-type": "application/problem+json" } }
          );
        }
        return new Response(JSON.stringify({}), { status: 200 });
      })
    );

    const { container } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AuthProvider>
          <KarmaPage />
        </AuthProvider>
      </NextIntlClientProvider>
    );

    await waitFor(() => expect(screen.getByText("150 pts")).toBeInTheDocument());
    expect(screen.getByText("50 pts")).toBeInTheDocument();
    expect(screen.getByText("120 pts")).toBeInTheDocument();
    expect(screen.getByText("First Swap")).toBeInTheDocument();
    // First-time badge unlock highlight fires even when localStorage has no prior entry
    expect(screen.getByText("Newly unlocked!")).toBeInTheDocument();
    expect(screen.getByTestId("karma-badge-first_swap")).toHaveClass(
      "karma-badge-unlock"
    );
    expect(
      window.localStorage.getItem(
        "saath_seen_badges_0193632e-0000-7000-8000-000000000777"
      )
    ).toBe(JSON.stringify(["first_swap"]));
    expect(screen.getByText("Senior Saviour")).toBeInTheDocument();
    expect(screen.getByText("Ten Swaps")).toBeInTheDocument();
    expect(screen.getByText("+150")).toBeInTheDocument();
    expect(screen.getByText("-75")).toBeInTheDocument();
    expect(screen.getByText(/Rewards catalogue coming in v1.1/i)).toBeInTheDocument();

    const toggle = screen.getByRole("switch", { name: /Appear on leaderboard/i });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    await user.click(toggle);

    await waitFor(() => expect(patchBody).toEqual({ leaderboard_opt_in: true }));
    await waitFor(() => expect(screen.getByText("HelpfulRail21")).toBeInTheDocument());
    expect(await runAxe(container)).toHaveNoViolations();
    vi.unstubAllGlobals();
  });

  it("renders enabled rewards catalogue and redeems reward item", async () => {
    seedUserSession();
    const user = userEvent.setup();
    let redeemed = false;
    let redeemBody: Record<string, unknown> | null = null;
    let releaseRedeem: () => void = () => {};

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;

        if (url.endsWith("/v1/me")) {
          return new Response(JSON.stringify(makeMePayload(true)), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.endsWith("/v1/karma")) {
          return new Response(
            JSON.stringify({
              balance: 150,
              pending: 0,
              redeemed_points: redeemed ? 80 : 0,
              available_balance: redeemed ? 70 : 150,
              history: [],
              badges: [],
              leaderboard: [],
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        if (url.endsWith("/v1/karma/rewards")) {
          return new Response(
            JSON.stringify({
              enabled: true,
              items: [
                {
                  code: "chai_voucher",
                  title_en: "Station Chai Voucher",
                  title_hi: "स्टेशन चाय वाउचर",
                  description_en: "Hot masala chai at partner stalls.",
                  description_hi: "पार्टनर स्टॉल पर गरम मसाला चाय।",
                  cost_points: 80,
                  stock: redeemed ? 1 : 2,
                },
                {
                  code: "snack_voucher",
                  title_en: "Station Snack Box",
                  title_hi: "स्टेशन स्नैक बॉक्स",
                  description_en: "Light travel snack combo.",
                  description_hi: "हल्का यात्रा स्नैक कॉम्बो।",
                  cost_points: 60,
                  stock: 5,
                },
              ],
              redemptions: redeemed
                ? [
                    {
                      id: "0193632e-0000-7000-8000-000000000555",
                      reward_code: "chai_voucher",
                      points_spent: 80,
                      status: "pending",
                      created_at: "2026-11-26T10:00:00Z",
                    },
                  ]
                : [],
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        if (url.endsWith("/v1/karma/rewards/redeem")) {
          const raw =
            input instanceof Request
              ? await input.clone().text()
              : String(init?.body ?? "{}");
          redeemBody = JSON.parse(raw || "{}") as Record<string, unknown>;
          await new Promise<void>((resolve) => {
            releaseRedeem = resolve;
          });
          redeemed = true;
          return new Response(
            JSON.stringify({
              id: "0193632e-0000-7000-8000-000000000555",
              reward_code: "chai_voucher",
              points_spent: 80,
              status: "pending",
              created_at: "2026-11-26T10:00:00Z",
            }),
            { status: 201, headers: { "content-type": "application/json" } }
          );
        }
        return new Response(JSON.stringify({}), { status: 200 });
      })
    );

    const { container } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AuthProvider>
          <KarmaPage />
        </AuthProvider>
      </NextIntlClientProvider>
    );

    await waitFor(() =>
      expect(screen.getByText("Station Chai Voucher")).toBeInTheDocument()
    );
    const redeemButtons = screen.getAllByRole("button", { name: "Redeem" });
    const [firstRedeemBtn, secondRedeemBtn] = redeemButtons;
    if (!firstRedeemBtn || !secondRedeemBtn) {
      throw new Error("Expected 2 redeem buttons");
    }
    await user.click(firstRedeemBtn);

    await waitFor(() =>
      expect(firstRedeemBtn).toHaveAttribute("aria-busy", "true")
    );
    expect(secondRedeemBtn).not.toHaveAttribute("aria-busy", "true");
    releaseRedeem();

    await waitFor(() => expect(redeemBody).toEqual({ reward_code: "chai_voucher" }));
    await waitFor(() => expect(screen.getByText("70 pts")).toBeInTheDocument());
    expect(await runAxe(container)).toHaveNoViolations();
    vi.unstubAllGlobals();
  });

  it("renders Hindi locale with Devanagari text, Latin digits, and passes axe", async () => {
    seedUserSession();
    window.localStorage.setItem(
      "saath_seen_badges_0193632e-0000-7000-8000-000000000777",
      JSON.stringify(["first_swap"])
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;

        if (url.endsWith("/v1/me")) {
          return new Response(JSON.stringify(makeMePayload(false)), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.endsWith("/v1/karma")) {
          return new Response(
            JSON.stringify({
              balance: 125,
              pending: 0,
              redeemed_points: 0,
              available_balance: 125,
              history: [],
              badges: [
                {
                  code: "first_swap",
                  title: "पहली अदला-बदली",
                  description: "साथ पर अपना पहला सत्यापित सीट स्वैप पूरा किया।",
                  earned_at: "2026-11-25T10:00:00Z",
                },
              ],
              leaderboard: [],
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        if (url.endsWith("/v1/karma/rewards")) {
          return new Response(
            JSON.stringify({
              type: "https://saath.app/problems/rewards_disabled",
              title: "Disabled",
              status: 403,
              detail: "Disabled",
              code: "rewards_disabled",
            }),
            { status: 403, headers: { "content-type": "application/problem+json" } }
          );
        }
        return new Response(JSON.stringify({}), { status: 200 });
      })
    );

    const { container } = render(
      <NextIntlClientProvider locale="hi" messages={hiMessages}>
        <AuthProvider>
          <KarmaPage />
        </AuthProvider>
      </NextIntlClientProvider>
    );

    await waitFor(() => expect(screen.getByText("पहली अदला-बदली")).toBeInTheDocument());
    expect(screen.getByText("कर्म और बैज")).toBeInTheDocument();
    expect(screen.getByText(/25\s+नव॰\s+2026\s+को अनलॉक/)).toBeInTheDocument();
    expect(screen.getAllByText(/125 अंक/).length).toBeGreaterThanOrEqual(1);
    expect(container.textContent).not.toMatch(/[०-९]/);
    expect(await runAxe(container)).toHaveNoViolations();
    vi.unstubAllGlobals();
  });
});
