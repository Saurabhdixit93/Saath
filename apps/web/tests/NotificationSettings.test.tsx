import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import enMessages from "../messages/en.json";
import { AuthProvider } from "../src/components/AuthProvider";
import ProfilePage from "../src/app/[locale]/profile/page";
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

describe("Profile Notification Settings & Value-First Web Push Opt-In", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
    window.sessionStorage.setItem("saath_access", makeFakeUserJwt());
    window.sessionStorage.setItem("saath_auth_kind", "user");
  });

  it("never calls Notification.requestPermission on mount and only prompts on explicit click", async () => {
    const requestPermissionSpy = vi.fn(async () => "granted" as NotificationPermission);
    vi.stubGlobal("Notification", {
      permission: "default",
      requestPermission: requestPermissionSpy,
    });

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
      if (url.endsWith("/v1/me/push-subscriptions")) {
        return new Response(JSON.stringify({ subscribed: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/v1/me") && method === "PATCH") {
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
              whatsapp: false,
              sms: false,
              quiet_hours_enabled: true,
            },
            created_at: "2026-11-25T14:00:00Z",
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
          <ProfilePage />
        </AuthProvider>
      </NextIntlClientProvider>
    );

    expect(await screen.findByText("Notifications & alerts")).toBeInTheDocument();
    expect(requestPermissionSpy).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Enable push notifications" }));
    await waitFor(() => expect(requestPermissionSpy).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([u]) =>
          String(
            typeof u === "string" ? u : u instanceof URL ? u.toString() : u.url
          ).endsWith("/v1/me/push-subscriptions")
        )
      ).toBe(true)
    );

    await user.click(screen.getByLabelText("WhatsApp alerts"));
    await user.click(screen.getByRole("button", { name: "Save preferences" }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([u, i]) =>
            String(
              typeof u === "string" ? u : u instanceof URL ? u.toString() : u.url
            ).endsWith("/v1/me") &&
            (i?.method === "PATCH" || (u instanceof Request && u.method === "PATCH"))
        )
      ).toBe(true)
    );

    expect(await runAxe(container)).toHaveNoViolations();
    vi.unstubAllGlobals();
  });
});
