import { describe, expect, it, vi } from "vitest";
import { createSaathClient } from "../src/client";

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
});
