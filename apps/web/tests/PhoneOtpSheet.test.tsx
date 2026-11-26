import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi, beforeEach } from "vitest";
import enMessages from "../messages/en.json";
import { AuthProvider } from "../src/components/AuthProvider";
import { PhoneOtpSheet } from "../src/components/PhoneOtpSheet";
import { runAxe } from "../vitest.setup";

describe("PhoneOtpSheet", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
  });

  it("validates +91 mobile number, submits OTP start + verify, and passes axe", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/v1/auth/anonymous")) {
        return new Response(
          JSON.stringify({ access: "anon.jwt", token_type: "bearer", expires_in: 7200 }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.endsWith("/v1/auth/otp/start")) {
        return new Response(
          JSON.stringify({ request_id: "req-123", resend_after: 30 }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.endsWith("/v1/auth/otp/verify")) {
        return new Response(
          JSON.stringify({
            access: "user.jwt",
            refresh: "refresh-token-1234567890",
            expires_in: 900,
            user: {
              id: "user-1",
              display_alias: null,
              gender_self: "undisclosed",
              locale: "en",
              women_only_default: false,
              reliability_accepted: 0,
              reliability_completed: 0,
              status: "active",
              created_at: "2026-11-25T14:00:00Z",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response("{}", { status: 404 });
    });

    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const onClose = vi.fn();

    const { container } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AuthProvider>
          <PhoneOtpSheet open={true} onClose={onClose} />
        </AuthProvider>
      </NextIntlClientProvider>
    );

    const phoneInput = screen.getByLabelText("Indian mobile number");
    await user.type(phoneInput, "1234567890");
    await user.click(screen.getByRole("button", { name: "Send 6-digit code" }));
    expect(screen.getByRole("alert")).toHaveTextContent("valid 10-digit Indian mobile");

    await user.clear(phoneInput);
    await user.type(phoneInput, "9876543210");
    expect(await runAxe(container)).toHaveNoViolations();

    await user.click(screen.getByRole("button", { name: "Send 6-digit code" }));

    const otpInput = await screen.findByLabelText("6-digit verification code");
    expect(screen.getByRole("button", { name: /Resend in/i })).toBeDisabled();

    await user.type(otpInput, "123456");
    await user.click(screen.getByRole("button", { name: "Verify & continue" }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    vi.unstubAllGlobals();
  });

  it("strips +91 prefix cleanly on paste and clears expired anon JWTs", async () => {
    // Expired 3-part anon JWT (exp in the past: 2020-01-01)
    const header = btoa(JSON.stringify({ alg: "EdDSA", typ: "JWT" }));
    const payload = btoa(JSON.stringify({ sub: "anon:old", kind: "anon", exp: 1577836800 }));
    const expiredAnonJwt = `${header}.${payload}.sig`;
    window.sessionStorage.setItem("saath_access", expiredAnonJwt);
    window.sessionStorage.setItem("saath_auth_kind", "anon");

    const seenVerifyAuthHeaders: Array<string | null> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      const url = req.url;
      if (url.endsWith("/v1/auth/anonymous")) {
        return new Response(
          JSON.stringify({ access: "fresh-anon.jwt", token_type: "bearer", expires_in: 7200 }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.endsWith("/v1/auth/otp/start")) {
        return new Response(
          JSON.stringify({ request_id: "req-paste", resend_after: 30 }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.endsWith("/v1/auth/otp/verify")) {
        seenVerifyAuthHeaders.push(req.headers.get("Authorization"));
        return new Response(
          JSON.stringify({
            access: "user.jwt",
            refresh: "refresh-token-1234567890",
            expires_in: 900,
            user: {
              id: "user-1",
              display_alias: null,
              gender_self: "undisclosed",
              locale: "en",
              women_only_default: false,
              reliability_accepted: 0,
              reliability_completed: 0,
              status: "active",
              created_at: "2026-11-25T14:00:00Z",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response("{}", { status: 404 });
    });

    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const onClose = vi.fn();

    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AuthProvider>
          <PhoneOtpSheet open={true} onClose={onClose} />
        </AuthProvider>
      </NextIntlClientProvider>
    );

    const phoneInput = screen.getByLabelText("Indian mobile number") as HTMLInputElement;
    await user.click(phoneInput);
    await user.paste("+919876543210");
    expect(phoneInput.value).toBe("9876543210");

    await user.click(screen.getByRole("button", { name: "Send 6-digit code" }));
    const otpInput = await screen.findByLabelText("6-digit verification code");
    await user.type(otpInput, "654321");
    await user.click(screen.getByRole("button", { name: "Verify & continue" }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(seenVerifyAuthHeaders[0]).not.toBe(`Bearer ${expiredAnonJwt}`);
    vi.unstubAllGlobals();
  });

  it("resets cloudflare turnstile token and maps turnstile_failed & messaging_unavailable", async () => {
    const { publicEnv } = await import("../src/lib/env");
    const prevMode = publicEnv.NEXT_PUBLIC_TURNSTILE_MODE;
    const prevKey = publicEnv.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
    publicEnv.NEXT_PUBLIC_TURNSTILE_MODE = "cloudflare";
    publicEnv.NEXT_PUBLIC_TURNSTILE_SITE_KEY = "test-site-key";

    let renderCount = 0;
    let latestCallback: ((tok: string) => void) | null = null;
    window.turnstile = {
      render: (_el, opts) => {
        renderCount += 1;
        latestCallback = opts.callback;
        setTimeout(() => opts.callback(`cf-token-${renderCount}`), 0);
        return `widget-${renderCount}`;
      },
      remove: vi.fn(),
    };

    let attempt = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/v1/auth/anonymous")) {
        return new Response(
          JSON.stringify({ access: "anon.jwt", token_type: "bearer", expires_in: 7200 }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.endsWith("/v1/auth/otp/start")) {
        attempt += 1;
        if (attempt === 1) {
          return new Response(
            JSON.stringify({
              type: "https://saath.app/problems/turnstile_failed",
              title: "Bot Check Failed",
              status: 403,
              detail: "Bot check failed.",
              code: "turnstile_failed",
            }),
            { status: 403, headers: { "content-type": "application/problem+json" } }
          );
        }
        return new Response(
          JSON.stringify({
            type: "https://saath.app/problems/messaging_unavailable",
            title: "Messaging Unavailable",
            status: 503,
            detail: "Messaging unavailable.",
            code: "messaging_unavailable",
          }),
          { status: 503, headers: { "content-type": "application/problem+json" } }
        );
      }
      return new Response("{}", { status: 404 });
    });

    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    try {
      render(
        <NextIntlClientProvider locale="en" messages={enMessages}>
          <AuthProvider>
            <PhoneOtpSheet open={true} onClose={vi.fn()} />
          </AuthProvider>
        </NextIntlClientProvider>
      );

      await waitFor(() => expect(renderCount).toBeGreaterThanOrEqual(1));
      expect(latestCallback).not.toBeNull();

      const phoneInput = screen.getByLabelText("Indian mobile number");
      await user.type(phoneInput, "9876543210");
      await user.click(screen.getByRole("button", { name: "Send 6-digit code" }));

      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Bot check expired or failed. Please complete the check again."
      );
      await waitFor(() => expect(renderCount).toBeGreaterThanOrEqual(2));

      await user.click(screen.getByRole("button", { name: "Send 6-digit code" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "We couldn't send the code right now. Please try again shortly."
      );
      await waitFor(() => expect(renderCount).toBeGreaterThanOrEqual(3));
    } finally {
      publicEnv.NEXT_PUBLIC_TURNSTILE_MODE = prevMode;
      publicEnv.NEXT_PUBLIC_TURNSTILE_SITE_KEY = prevKey;
      delete window.turnstile;
      vi.unstubAllGlobals();
    }
  });
});
