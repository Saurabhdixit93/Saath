import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { createElement } from "react";
import { ToastProvider } from "@saath/ui";
import { afterEach, describe, expect, it, vi } from "vitest";
import enMessages from "../messages/en.json";
import { RealtimeProvider, useRealtime } from "../src/lib/realtime/RealtimeProvider";
import { connectSseStream } from "../src/lib/realtime/sseFetch";
import type { RealtimeServerEvent } from "../src/lib/realtime/types";

describe("RealtimeProvider & sseFetch", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("parses Bearer-authenticated SSE stream frames", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(": connected\n\n"));
        controller.enqueue(
          encoder.encode(
            'event: journey.chart\ndata: {"type":"journey.chart","journey_id":"j1","state":"final","changed":true}\n\n'
          )
        );
        controller.close();
      },
    });

    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const hdrs = init?.headers as Record<string, string>;
      expect(hdrs.Authorization).toBe("Bearer jwt-abc");
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });

    const events: RealtimeServerEvent[] = [];
    const onOpen = vi.fn();
    const ac = new AbortController();

    await connectSseStream({
      url: "http://localhost:8000/v1/events/stream",
      token: "jwt-abc",
      signal: ac.signal,
      onOpen,
      onEvent: (e) => events.push(e),
      fetchImpl: fetchMock as typeof globalThis.fetch,
    });

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      { type: "journey.chart", journey_id: "j1", state: "final", changed: true },
    ]);
  });

  it("authenticates WS, invalidates TanStack Query caches, and falls back to SSE when WS closes", async () => {
    const sockets: Array<{
      onopen: (() => void) | null;
      onmessage: ((ev: { data: string }) => void) | null;
      onclose: (() => void) | null;
      onerror: (() => void) | null;
      sent: string[];
      readyState: number;
      send: (d: string) => void;
      close: () => void;
    }> = [];

    class MockWebSocket {
      static OPEN = 1;
      readyState = 1;
      onopen: (() => void) | null = null;
      onmessage: ((ev: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      sent: string[] = [];
      constructor() {
        sockets.push(this);
      }
      send(d: string) {
        this.sent.push(d);
      }
      close() {
        this.readyState = 3;
      }
    }

    vi.stubGlobal("WebSocket", MockWebSocket);

    const encoder = new TextEncoder();
    const fetchMock = vi.fn(async () => {
      const sseStream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(": connected\n\n"));
          controller.enqueue(
            encoder.encode(
              'event: swap.updated\ndata: {"type":"swap.updated","swap_id":"sw-1","journey_instance_id":"j-1","status":"confirmed","version":2}\n\n'
            )
          );
        },
      });
      return new Response(sseStream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const queryClient = new QueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    let latestMode = "";

    function Probe() {
      const rt = useRealtime();
      latestMode = rt.mode;
      return createElement("div", { "data-testid": "mode" }, rt.mode);
    }

    const probeEl = createElement(Probe);
    const realtimeEl = createElement(RealtimeProvider, {
      accessToken: "user-jwt",
      children: probeEl,
    });
    const toastEl = createElement(ToastProvider, null, realtimeEl);
    const queryEl = createElement(QueryClientProvider, { client: queryClient }, toastEl);

    render(
      createElement(NextIntlClientProvider, {
        locale: "en",
        messages: enMessages,
        children: queryEl,
      })
    );

    expect(sockets.length).toBe(1);
    act(() => {
      sockets[0]!.onopen?.();
    });
    expect(sockets[0]!.sent[0]).toBe(JSON.stringify({ type: "auth", token: "user-jwt" }));

    act(() => {
      sockets[0]!.onmessage?.({ data: JSON.stringify({ type: "ready" }) });
      sockets[0]!.onmessage?.({
        data: JSON.stringify({
          type: "match.updated",
          party_id: "p-1",
          journey_instance_id: "j-1",
          match_version: 3,
        }),
      });
    });

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["matches", "p-1"] });
    });

    // Simulate WS drop -> immediate SSE fallback
    act(() => {
      sockets[0]!.onclose?.();
    });

    await waitFor(() => {
      expect(latestMode).toBe("sse");
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["swap", "sw-1"] });
    });
  });
});
