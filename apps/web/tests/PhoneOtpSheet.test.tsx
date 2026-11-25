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
      const url = typeof input === "string" ? input : input.url;
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
});
