import { Suspense } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SwapCardDTO } from "@saath/contracts";
import enMessages from "../messages/en.json";
import { AppHeader } from "../src/components/AppHeader";
import { AuthProvider, useAuth } from "../src/components/AuthProvider";
import { SwapCard } from "../src/components/SwapCard";
import SwapCardPage from "../src/app/[locale]/swaps/[id]/card/page";
import PublicVerifySwapCardPage from "../src/app/[locale]/v/[code]/page";
import { runAxe } from "../vitest.setup";

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/swaps/s1/card",
  Link: ({ children, href, ...props }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

const SAMPLE_CARD: SwapCardDTO = {
  proposal_id: "0193632e-0000-7000-8000-000000000020",
  public_code: "SW-7Q2K9M",
  signature: "ZmFrZXNpZw",
  public_key: "-----BEGIN PUBLIC KEY-----\nTEST\n-----END PUBLIC KEY-----",
  alg: "Ed25519",
  service: "IR 12951",
  date: "2026-12-01",
  mode: "train",
  revoked: false,
  revoked_reason: null,
  confirmed_at: "2026-11-25T10:00:00Z",
  qr_url: "http://localhost:3000/v/SW-7Q2K9M",
  tte_note: "Subject to TTE approval",
  participants: [
    {
      alias: "Passenger B3-UB #111",
      from_seat: "B3-11 UB",
      to_seat: "B3-20 LB",
      gives_seat: "B3-11 UB",
      gets_seat: "B3-20 LB",
      decided_at: "2026-11-25T10:00:00Z",
    },
    {
      alias: "Passenger B3-LB #222",
      from_seat: "B3-20 LB",
      to_seat: "B3-11 UB",
      gives_seat: "B3-20 LB",
      gets_seat: "B3-11 UB",
      decided_at: "2026-11-25T10:00:00Z",
    },
  ],
};

describe("SwapCard & Public Verify", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
  });

  it("renders SwapCard QR SVG, syncs <html lang>, keeps Hindi button unique with AppHeader, and passes axe", async () => {
    const header = btoa(JSON.stringify({ alg: "EdDSA", typ: "JWT" }));
    const payload = btoa(
      JSON.stringify({ sub: "user-1", kind: "user", exp: Math.floor(Date.now() / 1000) + 900 })
    );
    window.sessionStorage.setItem("saath_access", `${header}.${payload}.sig`);
    window.sessionStorage.setItem("saath_auth_kind", "user");
    const user = userEvent.setup();
    const onDownloadPng = vi.fn(async () => {});
    document.documentElement.lang = "en";

    const { container, unmount } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AuthProvider>
          <AppHeader />
          <SwapCard card={SAMPLE_CARD} onDownloadPng={onDownloadPng} />
        </AuthProvider>
      </NextIntlClientProvider>
    );

    expect(screen.getByText(/SAATH SWAP CARD/)).toBeInTheDocument();
    expect(screen.getByText(/#SW-7Q2K9M/)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /QR code for SW-7Q2K9M/i })).toBeInTheDocument();
    expect(screen.getByText(/Subject to TTE approval/i)).toBeInTheDocument();

    // Must uniquely resolve to SwapCard toggle (without colliding with LanguageSwitcher)
    const hindiBtn = screen.getByRole("button", { name: /हिंदी|हिं|Hindi/i });
    await user.click(hindiBtn);
    expect(document.documentElement.lang).toBe("hi");
    expect(screen.getByText(/साथ स्वैप कार्ड/)).toBeInTheDocument();
    expect(screen.getByText(/IR 12951 · 2026-12-01/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /PNG डाउनलोड करें/i }));
    expect(onDownloadPng).toHaveBeenCalledWith("hi");
    expect(await runAxe(container)).toHaveNoViolations();
    unmount();
    expect(document.documentElement.lang).toBe("en");
  });

  it("AuthProvider prefers valid non-anon localStorage JWT over anon sessionStorage JWT", async () => {
    const header = btoa(JSON.stringify({ alg: "EdDSA", typ: "JWT" }));
    const exp = Math.floor(Date.now() / 1000) + 900;
    const anonPayload = btoa(JSON.stringify({ sub: "anon:abc", kind: "anon", exp }));
    const userPayload = btoa(JSON.stringify({ sub: "user-99", kind: "user", exp }));
    const anonJwt = `${header}.${anonPayload}.sig`;
    const userJwt = `${header}.${userPayload}.sig`;

    window.sessionStorage.setItem("saath_access", anonJwt);
    window.sessionStorage.setItem("saath_auth_kind", "anon");
    window.localStorage.setItem("saath_access_token", userJwt);

    function AuthProbe() {
      const { authKind, accessToken } = useAuth();
      return <div data-testid="auth-probe">{`${authKind}:${accessToken}`}</div>;
    }

    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AuthProvider>
          <AuthProbe />
        </AuthProvider>
      </NextIntlClientProvider>
    );

    await waitFor(() =>
      expect(screen.getByTestId("auth-probe")).toHaveTextContent(`user:${userJwt}`)
    );
  });

  it("hydrates SwapCardPage offline from localStorage when network fails", async () => {
    const header = btoa(JSON.stringify({ alg: "EdDSA", typ: "JWT" }));
    const payload = btoa(
      JSON.stringify({ sub: "user-1", kind: "user", exp: Math.floor(Date.now() / 1000) + 900 })
    );
    window.sessionStorage.setItem("saath_access", `${header}.${payload}.sig`);
    window.sessionStorage.setItem("saath_auth_kind", "user");
    window.localStorage.setItem(
      "saath:swap-card:0193632e-0000-7000-8000-000000000020",
      JSON.stringify(SAMPLE_CARD)
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("Network offline");
      })
    );

    await act(async () => {
      render(
        <NextIntlClientProvider locale="en" messages={enMessages}>
          <AuthProvider>
            <Suspense fallback={<div>loading</div>}>
              <SwapCardPage
                params={Promise.resolve({ id: "0193632e-0000-7000-8000-000000000020" })}
              />
            </Suspense>
          </AuthProvider>
        </NextIntlClientProvider>
      );
    });

    await waitFor(() =>
      expect(screen.getByText(/#SW-7Q2K9M/)).toBeInTheDocument()
    );
    expect(screen.getByText(/offline cached Swap Card/i)).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("renders public verify page for valid, revoked, and 404 states", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/SW-VALID1")) {
        return new Response(
          JSON.stringify({
            public_code: "SW-VALID1",
            valid: true,
            revoked: false,
            service: "IR 12951",
            date: "2026-12-01",
            mode: "train",
            seats: "B3-11 UB ⇄ B3-20 LB",
            confirmed_at: "2026-11-25T10:00:00Z",
            signature_verified: true,
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.endsWith("/SW-REVOKED")) {
        return new Response(
          JSON.stringify({
            public_code: "SW-REVOKED",
            valid: false,
            revoked: true,
            service: "IR 12951",
            date: "2026-12-01",
            mode: "train",
            seats: "B3-11 UB ⇄ B3-20 LB",
            confirmed_at: "2026-11-25T10:00:00Z",
            signature_verified: true,
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({
          type: "https://saath.app/problems/swap_card_not_found",
          title: "Swap Card Not Found",
          status: 404,
          detail: "No Swap Card found.",
          code: "swap_card_not_found",
        }),
        { status: 404, headers: { "content-type": "application/problem+json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");

    let r1!: ReturnType<typeof render>;
    await act(async () => {
      r1 = render(
        <QueryClientProvider client={new QueryClient()}>
          <NextIntlClientProvider locale="en" messages={enMessages}>
            <Suspense fallback={<div>loading</div>}>
              <PublicVerifySwapCardPage params={Promise.resolve({ code: "SW-VALID1" })} />
            </Suspense>
          </NextIntlClientProvider>
        </QueryClientProvider>
      );
    });
    await waitFor(() => expect(screen.getByText(/Valid Swap Card/i)).toBeInTheDocument());
    expect(await runAxe(r1.container)).toHaveNoViolations();
    r1.unmount();

    let r2!: ReturnType<typeof render>;
    await act(async () => {
      r2 = render(
        <QueryClientProvider client={new QueryClient()}>
          <NextIntlClientProvider locale="en" messages={enMessages}>
            <Suspense fallback={<div>loading</div>}>
              <PublicVerifySwapCardPage params={Promise.resolve({ code: "SW-REVOKED" })} />
            </Suspense>
          </NextIntlClientProvider>
        </QueryClientProvider>
      );
    });
    await waitFor(() => expect(screen.getByText(/Revoked \/ Invalidated/i)).toBeInTheDocument());
    r2.unmount();

    await act(async () => {
      render(
        <QueryClientProvider client={new QueryClient()}>
          <NextIntlClientProvider locale="en" messages={enMessages}>
            <Suspense fallback={<div>loading</div>}>
              <PublicVerifySwapCardPage params={Promise.resolve({ code: "SW-ZZZZ99" })} />
            </Suspense>
          </NextIntlClientProvider>
        </QueryClientProvider>
      );
    });
    await waitFor(() => expect(screen.getByText(/Swap Card not found/i)).toBeInTheDocument());
    vi.unstubAllGlobals();
  });
});
