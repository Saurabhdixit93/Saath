import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import enMessages from "../messages/en.json";
import hiMessages from "../messages/hi.json";
import ProfilePage from "../src/app/[locale]/profile/page";
import { AuthProvider } from "../src/components/AuthProvider";
import { PhoneOtpSheet } from "../src/components/PhoneOtpSheet";
import { PENDING_CONSENTS_KEY } from "../src/lib/dpdp";
import { runAxe } from "../vitest.setup";

vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/profile",
}));

function makeFakeUserJwt(): string {
  const header = btoa(JSON.stringify({ alg: "EdDSA", typ: "JWT" }));
  const payload = btoa(
    JSON.stringify({
      sub: "0193632e-0000-7000-8000-000000000001",
      kind: "user",
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
  );
  return `${header}.${payload}.sig`;
}

describe("Profile DPDP Consents, Data Export, Erasure & OTP Consent Flush", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
    window.sessionStorage.setItem("saath_access", makeFakeUserJwt());
    window.sessionStorage.setItem("saath_auth_kind", "user");
    window.localStorage.setItem("saath_access_token", makeFakeUserJwt());
    window.localStorage.setItem("saath_refresh", "refresh-jwt-token");
  });

  it("loads and updates DPDP consents, exports ZIP archive, deletes account cleanly, and passes axe", async () => {
    const savedPayloads: Array<{ consents: Array<{ purpose: string; granted: boolean }> }> = [];
    let deleteCalled = false;

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method || (input instanceof Request ? input.method : "GET");

      if (url.endsWith("/v1/me") && method === "GET") {
        return new Response(
          JSON.stringify({
            id: "u1",
            display_alias: "Asha",
            gender_self: "female",
            locale: "en",
            women_only_default: true,
            reliability_accepted: 3,
            reliability_completed: 3,
            status: "active",
            notification_channels: {
              push: true,
              whatsapp: true,
              sms: false,
              quiet_hours_enabled: true,
            },
            created_at: "2026-11-25T14:00:00Z",
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }

      if (url.endsWith("/v1/me/consents") && method === "GET") {
        return new Response(
          JSON.stringify({
            notice_version: "1.0",
            purposes: ["verification", "matching", "notifications", "analytics", "whatsapp"],
            consents: [
              { purpose: "verification", notice_version: "1.0", granted: true },
              { purpose: "matching", notice_version: "1.0", granted: true },
              { purpose: "notifications", notice_version: "1.0", granted: true },
              { purpose: "analytics", notice_version: "1.0", granted: false },
              { purpose: "whatsapp", notice_version: "1.0", granted: true },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }

      if (url.endsWith("/v1/me/consents") && method === "POST") {
        const parsed = JSON.parse(String(init?.body ?? "{}")) as {
          consents: Array<{ purpose: string; notice_version: string; granted: boolean }>;
        };
        savedPayloads.push(parsed);
        return new Response(JSON.stringify({ consents: parsed.consents }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (url.endsWith("/v1/me/export") && method === "GET") {
        const zipBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
        return new Response(zipBytes, {
          status: 200,
          headers: {
            "content-type": "application/zip",
            "content-disposition": 'attachment; filename="saath-data-export.zip"',
          },
        });
      }

      if (url.endsWith("/v1/me") && method === "DELETE") {
        deleteCalled = true;
        return new Response(
          JSON.stringify({ status: "erasure_scheduled", scheduled_within_hours: 24 }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }

      return new Response("{}", { status: 404 });
    });

    vi.stubGlobal("fetch", fetchMock);
    const createObjectUrlSpy = vi.fn(() => "blob:saath-export-1");
    const revokeObjectUrlSpy = vi.fn();
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: createObjectUrlSpy,
      revokeObjectURL: revokeObjectUrlSpy,
    });
    const anchorClickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    const user = userEvent.setup();
    const { container } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AuthProvider>
          <ProfilePage />
        </AuthProvider>
      </NextIntlClientProvider>
    );

    expect(await screen.findByText("DPDP consent preferences")).toBeInTheDocument();
    const analyticsSwitch = screen.getByRole("switch", {
      name: /PII-masked product analytics/i,
    });
    expect(analyticsSwitch).toHaveAttribute("aria-checked", "false");

    await user.click(analyticsSwitch);
    await waitFor(() => expect(savedPayloads.length).toBeGreaterThanOrEqual(1));
    expect(
      savedPayloads[0]?.consents.find((c) => c.purpose === "analytics")?.granted
    ).toBe(true);

    await user.click(screen.getByRole("button", { name: /Download my data/i }));
    await waitFor(() => expect(createObjectUrlSpy).toHaveBeenCalledTimes(1));
    expect(anchorClickSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectUrlSpy).toHaveBeenCalledWith("blob:saath-export-1");

    expect(await runAxe(container)).toHaveNoViolations();

    await user.click(screen.getByRole("button", { name: /Delete my data/i }));
    const confirmDeleteBtn = await screen.findByRole("button", {
      name: /confirm delete|yes, delete|permanently delete|erase/i,
    });
    expect(confirmDeleteBtn).toHaveTextContent("Permanently delete & erase my account");

    await user.click(confirmDeleteBtn);
    await waitFor(() => expect(deleteCalled).toBe(true));

    expect(
      await screen.findByText(/Your account erasure is scheduled and will complete within 24 hours/i)
    ).toBeInTheDocument();
    expect(window.localStorage.getItem("saath_access_token")).toBeNull();
    expect(window.sessionStorage.getItem("saath_access")).toBeNull();
    expect(window.localStorage.getItem("saath_refresh")).toBeNull();

    anchorClickSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("renders Profile in Hindi with zero Devanagari digits", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.endsWith("/v1/me")) {
          return new Response(
            JSON.stringify({
              id: "u1",
              display_alias: "Asha",
              gender_self: "female",
              locale: "hi",
              women_only_default: false,
              reliability_accepted: 1,
              reliability_completed: 1,
              status: "active",
              notification_channels: {
                push: true,
                whatsapp: true,
                sms: true,
                quiet_hours_enabled: true,
              },
              created_at: "2026-11-25T14:00:00Z",
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        return new Response("{}", { status: 404 });
      })
    );

    const { container } = render(
      <NextIntlClientProvider locale="hi" messages={hiMessages}>
        <AuthProvider>
          <ProfilePage />
        </AuthProvider>
      </NextIntlClientProvider>
    );

    expect(await screen.findByText("DPDP सहमति प्राथमिकताएँ")).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/[०-९]/);
    vi.unstubAllGlobals();
  });

  it("flushes pending DPDP consents best-effort when OTP verification succeeds", async () => {
    window.sessionStorage.clear();
    window.localStorage.clear();
    window.localStorage.setItem(
      PENDING_CONSENTS_KEY,
      JSON.stringify([
        { purpose: "verification", notice_version: "1.0", granted: true },
        { purpose: "matching", notice_version: "1.0", granted: true },
        { purpose: "notifications", notice_version: "1.0", granted: true },
        { purpose: "analytics", notice_version: "1.0", granted: true },
        { purpose: "whatsapp", notice_version: "1.0", granted: true },
      ])
    );

    let flushedConsents = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.endsWith("/v1/auth/otp/start")) {
          return new Response(JSON.stringify({ request_id: "req-1", resend_after: 30 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.endsWith("/v1/auth/otp/verify")) {
          return new Response(
            JSON.stringify({
              access: makeFakeUserJwt(),
              refresh: "refresh-2",
              user: {
                id: "u1",
                display_alias: "Asha",
                gender_self: "female",
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
        if (url.endsWith("/v1/me/consents") && init?.method === "POST") {
          flushedConsents = true;
          return new Response(JSON.stringify({ consents: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({ access: "anon.jwt", token_type: "bearer", expires_in: 7200 }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      })
    );

    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AuthProvider>
          <PhoneOtpSheet open={true} onClose={onClose} />
        </AuthProvider>
      </NextIntlClientProvider>
    );

    await user.type(screen.getByLabelText(/Mobile number/i), "9876543210");
    await user.click(screen.getByRole("button", { name: /Send OTP/i }));

    const otpInput = await screen.findByLabelText(/6-digit OTP/i);
    await user.type(otpInput, "123456");
    await user.click(screen.getByRole("button", { name: /Verify OTP/i }));

    await waitFor(() => expect(flushedConsents).toBe(true));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(window.localStorage.getItem(PENDING_CONSENTS_KEY)).toBeNull();

    vi.unstubAllGlobals();
  });
});
