import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import enMessages from "../messages/en.json";
import { AuthProvider } from "../src/components/AuthProvider";
import InboxPage from "../src/app/[locale]/inbox/page";
import ConversationChatPage from "../src/app/[locale]/inbox/[id]/page";
import { clearOutboxMemoryForTests } from "../src/lib/chat/outboxDb";
import { runAxe } from "../vitest.setup";

vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/inbox",
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

describe("Inbox & Masked Chat UI", () => {
  beforeEach(async () => {
    window.sessionStorage.clear();
    window.localStorage.clear();
    await clearOutboxMemoryForTests();
    window.sessionStorage.setItem("saath_access", makeFakeUserJwt());
    window.sessionStorage.setItem("saath_auth_kind", "user");
  });

  it("renders masked conversations alongside swaps in /inbox", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("/v1/swaps")) {
        return new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/v1/conversations")) {
        return new Response(
          JSON.stringify({
            items: [
              {
                id: "convo-1",
                journey_instance_id: "ji-1",
                service: "IR 12951",
                date: "2026-12-01",
                partner_alias: "Passenger B5-L",
                partner_alias_ref: "ar_1234",
                unmasked: false,
                blocked: false,
                participants: [],
                last_message: {
                  id: "m0",
                  conversation_id: "convo-1",
                  sender_alias: "Passenger B5-L",
                  is_me: false,
                  client_id: "c0",
                  body: "Happy to swap!",
                  moderation: "ok",
                  created_at: "2026-11-26T00:00:00Z",
                },
                created_at: "2026-11-26T00:00:00Z",
                updated_at: "2026-11-26T00:00:00Z",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response("{}", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AuthProvider>
          <InboxPage />
        </AuthProvider>
      </NextIntlClientProvider>
    );

    expect(await screen.findByText("Passenger B5-L")).toBeInTheDocument();
    expect(screen.getByText("Masked conversations")).toBeInTheDocument();
    expect(await runAxe(container)).toHaveNoViolations();
    vi.unstubAllGlobals();
  });

  it("renders masked chat thread, quick replies, translate, and block/report sheets with axe clean", async () => {
    const user = userEvent.setup();
    const messagesList = [
      {
        id: "m1",
        conversation_id: "convo-1",
        sender_alias: "Passenger B5-L",
        is_me: false,
        client_id: "c1",
        body: "Happy to swap!",
        lang: "en",
        moderation: "ok",
        redacted_hint: null,
        created_at: "2026-11-26T00:00:00Z",
      },
    ];

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.url;
      const method = init?.method || (input instanceof Request ? input.method : "GET");
      if (url.endsWith("/messages") && method === "GET") {
        return new Response(
          JSON.stringify({
            conversation: {
              id: "convo-1",
              journey_instance_id: "ji-1",
              service: "IR 12951",
              date: "2026-12-01",
              partner_alias: "Passenger B5-L",
              partner_alias_ref: "ar_1234",
              unmasked: false,
              blocked: false,
              participants: [
                { alias: "Passenger B5-U", alias_ref: "ar_me", is_me: true, seat_revealed: null },
                { alias: "Passenger B5-L", alias_ref: "ar_1234", is_me: false, seat_revealed: null },
              ],
              last_message: null,
              created_at: "2026-11-26T00:00:00Z",
              updated_at: "2026-11-26T00:00:00Z",
            },
            items: messagesList,
            next_before: null,
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.endsWith("/translate")) {
        return new Response(
          JSON.stringify({
            message_id: "m1",
            translated_text: "अदला-बदली करने में खुशी होगी!",
            to: "hi",
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.endsWith("/messages") && method === "POST") {
        const msg = {
          id: "m2",
          conversation_id: "convo-1",
          sender_alias: "Passenger B5-U",
          is_me: true,
          client_id: "c2",
          body: "Swap at next station?",
          lang: "en",
          moderation: "ok",
          redacted_hint: null,
          created_at: "2026-11-26T00:01:00Z",
        };
        messagesList.push(msg);
        return new Response(JSON.stringify(msg), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AuthProvider>
          <ConversationChatPage params={Promise.resolve({ id: "convo-1" })} />
        </AuthProvider>
      </NextIntlClientProvider>
    );

    expect(await screen.findByText("Contact details unlock after you both agree")).toBeInTheDocument();
    expect(screen.getByText("Happy to swap!")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Translate" }));
    expect(await screen.findByText("अदला-बदली करने में खुशी होगी!")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Swap at next station?" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    expect(await runAxe(container)).toHaveNoViolations();
    vi.unstubAllGlobals();
  });

  it("suppresses self-typing echo and renders partner typing indicator", async () => {
    let activeSocket: {
      readyState: number;
      onopen: (() => void) | null;
      onmessage: ((evt: { data: string }) => void) | null;
      onerror: (() => void) | null;
      onclose: (() => void) | null;
      send: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
    } | null = null;

    class MockWebSocket {
      static OPEN = 1;
      readyState = 1;
      onopen: (() => void) | null = null;
      onmessage: ((evt: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: (() => void) | null = null;
      send = vi.fn();
      close = vi.fn();

      constructor() {
        activeSocket = this;
        setTimeout(() => {
          this.onopen?.();
          this.onmessage?.({ data: JSON.stringify({ type: "ready" }) });
        }, 0);
      }
    }

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.endsWith("/messages")) {
        return new Response(
          JSON.stringify({
            conversation: {
              id: "convo-1",
              journey_instance_id: "ji-1",
              service: "IR 12951",
              date: "2026-12-01",
              partner_alias: "Passenger B5-L",
              partner_alias_ref: "ar_1234",
              unmasked: false,
              blocked: false,
              participants: [
                { alias: "Passenger B5-U", alias_ref: "ar_me", is_me: true, seat_revealed: null },
                { alias: "Passenger B5-L", alias_ref: "ar_1234", is_me: false, seat_revealed: null },
              ],
              last_message: null,
              created_at: "2026-11-26T00:00:00Z",
              updated_at: "2026-11-26T00:00:00Z",
            },
            items: [],
            next_before: null,
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response("{}", { status: 200 });
    });

    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.stubGlobal("fetch", fetchMock);

    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AuthProvider>
          <ConversationChatPage params={Promise.resolve({ id: "convo-1" })} />
        </AuthProvider>
      </NextIntlClientProvider>
    );

    expect(await screen.findByText("Contact details unlock after you both agree")).toBeInTheDocument();
    await waitFor(() => expect(activeSocket).not.toBeNull());

    // Self-typing echo must not render
    activeSocket!.onmessage?.({
      data: JSON.stringify({
        type: "typing",
        conversation_id: "convo-1",
        alias: "Passenger B5-U",
      }),
    });
    expect(screen.queryByText("Passenger B5-U is typing...")).toBeNull();

    // Partner typing must render
    activeSocket!.onmessage?.({
      data: JSON.stringify({
        type: "typing",
        conversation_id: "convo-1",
        alias: "Passenger B5-L",
      }),
    });
    expect(await screen.findByText("Passenger B5-L is typing...")).toBeInTheDocument();

    vi.unstubAllGlobals();
  });
});
