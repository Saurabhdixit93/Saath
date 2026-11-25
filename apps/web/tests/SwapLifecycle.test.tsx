import { Suspense } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import enMessages from "../messages/en.json";
import { AuthProvider } from "../src/components/AuthProvider";
import SwapDetailPage from "../src/app/[locale]/swaps/[id]/page";
import InboxPage from "../src/app/[locale]/inbox/page";
import { runAxe } from "../vitest.setup";

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/inbox",
  Link: ({ children, href, ...props }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

function seedUserSession() {
  const header = btoa(JSON.stringify({ alg: "EdDSA", typ: "JWT" }));
  const payload = btoa(
    JSON.stringify({ sub: "user-1", kind: "user", exp: Math.floor(Date.now() / 1000) + 900 })
  );
  window.sessionStorage.setItem("saath_access", `${header}.${payload}.sig`);
  window.sessionStorage.setItem("saath_auth_kind", "user");
}

describe("Swap lifecycle & Inbox confirmation", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
  });

  it("handles accept 409 conflict refresh, decline, and post-journey confirmation in Inbox", async () => {
    seedUserSession();
    const user = userEvent.setup();
    let swapStatus = "pending";
    let version = 0;

    const makeSwapPayload = () => ({
      id: "0193632e-0000-7000-8000-000000000010",
      journey_instance_id: "0193632e-0000-7000-8000-000000000001",
      kind: "pair",
      status: swapStatus,
      version,
      expires_at: "2026-12-01T12:00:00Z",
      created_at: "2026-12-01T06:00:00Z",
      confirmed_at: swapStatus === "confirmed" ? "2026-12-01T06:05:00Z" : null,
      note: null,
      decline_reason: null,
      service: "IR 12951",
      date: "2026-12-01",
      mode: "train",
      you_give: "B3-11 UB",
      you_get_summary: "B3 LB",
      participants: [
        {
          alias: "Passenger B3-UB #111",
          decision: swapStatus === "confirmed" ? "accepted" : "pending",
          decided_at: null,
          post_confirm: null,
          is_me: true,
          gives_seat: "B3-11 UB",
          gets_seat: swapStatus === "confirmed" ? "B3-20 LB" : "B3 LB",
          gives_coach: "B3",
          gets_coach: "B3",
          gives_seat_type: "UB",
          gets_seat_type: "LB",
        },
        {
          alias: "Passenger B3-LB #222",
          decision: "accepted",
          decided_at: null,
          post_confirm: null,
          is_me: false,
          gives_seat: swapStatus === "confirmed" ? "B3-20 LB" : "B3 LB",
          gets_seat: swapStatus === "confirmed" ? "B3-11 UB" : "B3 UB",
          gives_coach: "B3",
          gets_coach: "B3",
          gives_seat_type: "LB",
          gets_seat_type: "UB",
        },
      ],
      swap_card_code: swapStatus === "confirmed" ? "SW-7Q2K9M" : null,
      can_accept: swapStatus === "pending",
      can_cancel: swapStatus === "pending",
      can_confirm_completion: swapStatus === "confirmed",
      my_post_confirm: null,
    });

    let acceptAttempts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.endsWith("/v1/swaps/0193632e-0000-7000-8000-000000000010") && (!init?.method || init.method === "GET")) {
        return new Response(JSON.stringify(makeSwapPayload()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/accept")) {
        acceptAttempts += 1;
        if (acceptAttempts === 1) {
          version = 1;
          return new Response(
            JSON.stringify({
              type: "https://saath.app/problems/version_conflict",
              title: "Swap Updated",
              status: 409,
              detail: "Version conflict",
              code: "version_conflict",
            }),
            { status: 409, headers: { "content-type": "application/problem+json" } }
          );
        }
        swapStatus = "confirmed";
        version = 2;
        return new Response(JSON.stringify(makeSwapPayload()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/v1/swaps?state=all")) {
        return new Response(JSON.stringify({ items: [makeSwapPayload()] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/confirm-completion")) {
        swapStatus = "completed";
        return new Response(JSON.stringify(makeSwapPayload()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container, unmount } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AuthProvider>
          <Suspense fallback={<div>loading</div>}>
            <SwapDetailPage
              params={Promise.resolve({ id: "0193632e-0000-7000-8000-000000000010" })}
            />
          </Suspense>
        </AuthProvider>
      </NextIntlClientProvider>
    );

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Accept swap" })).toBeInTheDocument()
    );
    await user.click(screen.getByRole("button", { name: "Accept swap" }));
    await waitFor(() =>
      expect(screen.getByText(/This swap changed/i)).toBeInTheDocument()
    );

    await user.click(screen.getByRole("button", { name: "Accept swap" }));
    await waitFor(() =>
      expect(screen.getByText(/your swap is confirmed/i)).toBeInTheDocument()
    );
    expect(await runAxe(container)).toHaveNoViolations();
    unmount();

    // Render InboxPage for post-journey confirmation
    const inboxRender = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AuthProvider>
          <InboxPage />
        </AuthProvider>
      </NextIntlClientProvider>
    );

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Yes, swapped" })).toBeInTheDocument()
    );
    await user.click(screen.getByRole("button", { name: "Yes, swapped" }));
    await waitFor(() =>
      expect(screen.getByText(/Confirmed! Thank you/i)).toBeInTheDocument()
    );
    expect(await runAxe(inboxRender.container)).toHaveNoViolations();
    vi.unstubAllGlobals();
  });
});
