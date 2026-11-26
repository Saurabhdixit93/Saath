import { describe, expect, it, vi } from "vitest";
import { createSaathClient, parseProblemDetail } from "../src/client";

describe("createSaathClient 401 single-flight refresh & retry", () => {
  it("retries PATCH /v1/me with preserved JSON body after 401 token refresh", async () => {
    let currentToken = "expired-jwt";
    const seenAuthHeaders: Array<string | null> = [];
    const seenBodies: string[] = [];

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      // Simulate real fetch consuming request body stream before response returns
      const bodyText = await req.text();
      seenAuthHeaders.push(req.headers.get("Authorization"));
      seenBodies.push(bodyText);

      if (req.headers.get("Authorization") === "Bearer expired-jwt") {
        return new Response(
          JSON.stringify({
            type: "https://saath.app/problems/token_expired",
            title: "Token Expired",
            status: 401,
            detail: "Authentication token has expired.",
            code: "token_expired",
          }),
          { status: 401, headers: { "content-type": "application/problem+json" } }
        );
      }

      return new Response(
        JSON.stringify({
          id: "0193632e-0000-7000-8000-000000000001",
          display_alias: "Asha",
          gender_self: "female",
          locale: "hi",
          women_only_default: true,
          reliability_accepted: 0,
          reliability_completed: 0,
          status: "active",
          created_at: "2026-11-25T14:00:00Z",
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const refreshTokens = vi.fn(async () => {
      currentToken = "fresh-jwt";
      return currentToken;
    });

    const client = createSaathClient({
      baseUrl: "http://localhost:8000",
      getAccessToken: () => currentToken,
      refreshTokens,
      fetch: fetchMock as typeof globalThis.fetch,
    });

    const { data, error } = await client.PATCH("/v1/me", {
      body: {
        locale: "hi",
        women_only_default: true,
        display_alias: "Asha",
      },
    });

    expect(error).toBeUndefined();
    expect(data?.locale).toBe("hi");
    expect(data?.display_alias).toBe("Asha");
    expect(refreshTokens).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(seenAuthHeaders).toEqual(["Bearer expired-jwt", "Bearer fresh-jwt"]);
    expect(seenBodies).toEqual([
      JSON.stringify({ locale: "hi", women_only_default: true, display_alias: "Asha" }),
      JSON.stringify({ locale: "hi", women_only_default: true, display_alias: "Asha" }),
    ]);
  });

  it("coalesces concurrent 401 refreshes into a single refreshTokens call", async () => {
    let currentToken = "expired-jwt";

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (req.body) {
        await req.text();
      }
      if (req.headers.get("Authorization") === "Bearer expired-jwt") {
        return new Response(JSON.stringify({ status: 401, code: "token_expired", title: "Expired" }), {
          status: 401,
          headers: { "content-type": "application/problem+json" },
        });
      }
      return new Response(
        JSON.stringify({
          id: "0193632e-0000-7000-8000-000000000001",
          display_alias: null,
          gender_self: "undisclosed",
          locale: "en",
          women_only_default: false,
          reliability_accepted: 0,
          reliability_completed: 0,
          status: "active",
          created_at: "2026-11-25T14:00:00Z",
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const refreshTokens = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      currentToken = "fresh-jwt-2";
      return currentToken;
    });

    const client = createSaathClient({
      baseUrl: "http://localhost:8000",
      getAccessToken: () => currentToken,
      refreshTokens,
      fetch: fetchMock as typeof globalThis.fetch,
    });

    const [res1, res2] = await Promise.all([
      client.GET("/v1/me"),
      client.PATCH("/v1/me", { body: { locale: "en" } }),
    ]);

    expect(res1.error).toBeUndefined();
    expect(res2.error).toBeUndefined();
    expect(refreshTokens).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("supports M3 matches, coach-map, swaps, and 409 parseProblemDetail", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      const url = new URL(req.url);
      if (url.pathname === "/v1/parties/p1/matches") {
        return new Response(JSON.stringify({ match_version: 2, items: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname === "/v1/swaps/s1/accept") {
        return new Response(
          JSON.stringify({
            type: "https://saath.app/problems/seat_locked",
            title: "Seat Already Locked",
            status: 409,
            detail: "Your seat is already locked.",
            code: "seat_locked",
          }),
          { status: 409, headers: { "content-type": "application/problem+json" } }
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });

    const client = createSaathClient({
      baseUrl: "http://localhost:8000",
      getAccessToken: () => "valid-jwt",
      fetch: fetchMock as typeof globalThis.fetch,
    });

    const matchesRes = await client.GET("/v1/parties/{party_id}/matches", {
      params: { path: { party_id: "p1" }, query: { kind: "pair" } },
    });
    expect(matchesRes.data?.match_version).toBe(2);

    const acceptRes = await client.POST("/v1/swaps/{swap_id}/accept", {
      params: { path: { swap_id: "s1" } },
      body: { version: 0 },
    });
    const problem = parseProblemDetail(acceptRes.error);
    expect(problem?.status).toBe(409);
    expect(problem?.code).toBe("seat_locked");
  });

  it("supports M4 conversations, messages, push-subscriptions, public chart-time, and 403/429 ProblemDetail", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      const url = new URL(req.url);
      if (url.pathname === "/v1/conversations" && req.method === "POST") {
        return new Response(
          JSON.stringify({
            id: "c1",
            journey_instance_id: "j1",
            service: "IR 12951",
            date: "2026-12-01",
            partner_alias: "Passenger B5-L",
            partner_alias_ref: "ar_1234",
            unmasked: false,
            blocked: false,
            participants: [],
            last_message: null,
            created_at: "2026-11-26T00:00:00Z",
            updated_at: "2026-11-26T00:00:00Z",
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.pathname === "/v1/conversations/c1/messages" && req.method === "POST") {
        return new Response(
          JSON.stringify({
            type: "https://saath.app/problems/user_blocked",
            title: "User Blocked",
            status: 403,
            detail: "You cannot message a blocked traveller.",
            code: "user_blocked",
          }),
          { status: 403, headers: { "content-type": "application/problem+json" } }
        );
      }
      if (url.pathname === "/v1/me/push-subscriptions") {
        return new Response(JSON.stringify({ subscribed: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname === "/v1/public/train/12009/chart-time") {
        return new Response(
          JSON.stringify({
            train_no: "12009",
            date: "2026-12-01",
            chart_due_at: "2026-11-30T14:30:00Z",
            rule: "dec2025_morning_prev_20_ist",
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });

    const client = createSaathClient({
      baseUrl: "http://localhost:8000",
      getAccessToken: () => "valid-jwt",
      fetch: fetchMock as typeof globalThis.fetch,
    });

    const convoRes = await client.POST("/v1/conversations", {
      body: { card_id: "card-1" },
    });
    expect(convoRes.data?.partner_alias).toBe("Passenger B5-L");
    expect(convoRes.data?.unmasked).toBe(false);

    const msgRes = await client.POST("/v1/conversations/{conversation_id}/messages", {
      params: { path: { conversation_id: "c1" } },
      body: { body: "Hi", client_id: "cli-1" },
    });
    expect(parseProblemDetail(msgRes.error)?.status).toBe(403);
    expect(parseProblemDetail(msgRes.error)?.code).toBe("user_blocked");

    const pushRes = await client.POST("/v1/me/push-subscriptions", {
      body: {
        endpoint: "https://push.example/sub/1",
        keys: { p256dh: "p256dh-key-val", auth: "auth-key" },
      },
    });
    expect(pushRes.data?.subscribed).toBe(true);

    const chartRes = await client.GET("/v1/public/train/{train_no}/chart-time", {
      params: { path: { train_no: "12009" }, query: { date: "2026-12-01" } },
    });
    expect(chartRes.data?.rule).toBe("dec2025_morning_prev_20_ist");
  });

  it("supports M5-C POST /v1/ai/draft-request and 429 ProblemDetail", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      const url = new URL(req.url);
      if (url.pathname === "/v1/ai/draft-request" && req.method === "POST") {
        const body = JSON.parse(await req.text()) as { card_id: string; lang?: string };
        if (body.card_id === "mc_rate_limited") {
          return new Response(
            JSON.stringify({
              type: "https://saath.app/problems/rate_limited",
              title: "Daily AI Limit Reached",
              status: 429,
              detail: "You have reached the daily limit for AI concierge and draft requests.",
              code: "rate_limited",
            }),
            { status: 429, headers: { "content-type": "application/problem+json" } }
          );
        }
        return new Response(
          JSON.stringify({
            text:
              body.lang === "hi"
                ? "नमस्ते! क्या आप मेरी B3-11 UB सीट से अपनी B3 LB सीट बदलेंगे?"
                : "Hello! Would you swap your B3 LB for my B3-11 UB seat?",
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });

    const client = createSaathClient({
      baseUrl: "http://localhost:8000",
      getAccessToken: () => "valid-jwt",
      fetch: fetchMock as typeof globalThis.fetch,
    });

    const okRes = await client.POST("/v1/ai/draft-request", {
      body: { card_id: "mc_1234", tone: "polite", lang: "hi" },
    });
    expect(okRes.data?.text).toMatch(/[\u0900-\u097F]/);

    const limitedRes = await client.POST("/v1/ai/draft-request", {
      body: { card_id: "mc_rate_limited", tone: "polite", lang: "en" },
    });
    expect(parseProblemDetail(limitedRes.error)?.status).toBe(429);
    expect(parseProblemDetail(limitedRes.error)?.code).toBe("rate_limited");
  });
});
