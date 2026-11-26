"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useToast } from "@saath/ui";
import type { MessagesResponse } from "@saath/contracts";
import { publicEnv } from "@/lib/env";
import { connectSseStream } from "./sseFetch";
import type { RealtimeServerEvent, TransportMode } from "./types";

interface TypingEntry {
  alias: string;
  expiresAt: number;
}

export interface ChartEventRecord {
  journeyId: string;
  state: string;
  changed: boolean;
  receivedAt: number;
}

interface RealtimeContextValue {
  mode: TransportMode;
  connected: boolean;
  readyCount: number;
  typingByConversation: Record<string, TypingEntry | undefined>;
  lastChartEventByJourney: Record<string, ChartEventRecord | undefined>;
  sendTyping: (conversationId: string) => void;
  subscribeConversation: (conversationId: string) => void;
}

const RealtimeContext = createContext<RealtimeContextValue>({
  mode: "ws",
  connected: false,
  readyCount: 0,
  typingByConversation: {},
  lastChartEventByJourney: {},
  sendTyping: () => {},
  subscribeConversation: () => {},
});

const WS_READY_TIMEOUT_MS = 1200;
const WS_PING_INTERVAL_MS = 25000;
const WS_RECOVERY_PROBE_MS = 60000;
const POLLING_INTERVAL_MS = 15000;

export function RealtimeProvider({
  accessToken,
  children,
}: {
  accessToken: string | null;
  children: ReactNode;
}) {
  const queryClient = useQueryClient();
  const tJourneys = useTranslations("journeys");
  const { showToast } = useToast();

  const [mode, setMode] = useState<TransportMode>("ws");
  const [connected, setConnected] = useState(false);
  const [readyCount, setReadyCount] = useState(0);
  const [typingByConversation, setTypingByConversation] = useState<
    Record<string, TypingEntry | undefined>
  >({});
  const [lastChartEventByJourney, setLastChartEventByJourney] = useState<
    Record<string, ChartEventRecord | undefined>
  >({});

  const wsRef = useRef<WebSocket | null>(null);
  const lastMatchVersionRef = useRef<Record<string, number>>({});
  const lastTypingSentRef = useRef<Record<string, number>>({});
  const typingTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const sseAttemptRef = useRef(0);

  const handleServerEvent = useCallback(
    (evt: RealtimeServerEvent) => {
      if (evt.type === "ready") {
        setConnected(true);
        setReadyCount((c) => c + 1);
        return;
      }
      if (evt.type === "pong" || evt.type === "error") {
        return;
      }

      if (evt.type === "match.updated") {
        const prev = lastMatchVersionRef.current[evt.party_id] ?? -1;
        if (evt.match_version >= prev) {
          lastMatchVersionRef.current[evt.party_id] = evt.match_version;
          void queryClient.invalidateQueries({ queryKey: ["matches", evt.party_id] });
          void queryClient.invalidateQueries({ queryKey: ["journey", evt.journey_instance_id] });
          void queryClient.invalidateQueries({ queryKey: ["coach-map", evt.journey_instance_id] });
        }
        return;
      }

      if (evt.type === "swap.updated") {
        void queryClient.invalidateQueries({ queryKey: ["swap", evt.swap_id] });
        void queryClient.invalidateQueries({ queryKey: ["swaps"] });
        void queryClient.invalidateQueries({ queryKey: ["journey", evt.journey_instance_id] });
        void queryClient.invalidateQueries({ queryKey: ["conversations"] });
        return;
      }

      if (evt.type === "message.new") {
        queryClient.setQueryData<MessagesResponse>(
          ["messages", evt.conversation_id],
          (oldData) => {
            if (!oldData) {
              return oldData;
            }
            const exists = oldData.items.some(
              (m) => m.id === evt.message.id || m.client_id === evt.message.client_id
            );
            if (exists) {
              return oldData;
            }
            return {
              ...oldData,
              items: [
                ...oldData.items,
                {
                  id: evt.message.id,
                  conversation_id: evt.message.conversation_id,
                  sender_alias: evt.message.sender_alias,
                  is_me: false,
                  client_id: evt.message.client_id,
                  body: evt.message.body,
                  lang: evt.message.lang ?? null,
                  moderation: evt.message.moderation,
                  redacted_hint: null,
                  created_at: evt.message.created_at,
                },
              ],
            };
          }
        );
        void queryClient.invalidateQueries({ queryKey: ["messages", evt.conversation_id] });
        void queryClient.invalidateQueries({ queryKey: ["conversations"] });
        return;
      }

      if (evt.type === "journey.chart") {
        const jId = evt.journey_id || evt.journey_instance_id || "";
        if (jId) {
          setLastChartEventByJourney((prev) => ({
            ...prev,
            [jId]: {
              journeyId: jId,
              state: evt.state,
              changed: Boolean(evt.changed),
              receivedAt: Date.now(),
            },
          }));
          void queryClient.invalidateQueries({ queryKey: ["journey", jId] });
          void queryClient.invalidateQueries({ queryKey: ["coach-map", jId] });
        }
        void queryClient.invalidateQueries({ queryKey: ["journeys"] });
        void queryClient.invalidateQueries({ queryKey: ["matches"] });
        void queryClient.invalidateQueries({ queryKey: ["swaps"] });
        void queryClient.invalidateQueries({ queryKey: ["swap"] });
        if (evt.changed) {
          showToast({ variant: "info", message: tJourneys("chartPreparedToast") });
        }
        return;
      }

      if (evt.type === "typing") {
        const cid = evt.conversation_id;
        setTypingByConversation((prev) => ({
          ...prev,
          [cid]: { alias: evt.alias, expiresAt: Date.now() + 3500 },
        }));
        if (typingTimersRef.current[cid]) {
          clearTimeout(typingTimersRef.current[cid]);
        }
        typingTimersRef.current[cid] = setTimeout(() => {
          setTypingByConversation((prev) => {
            const next = { ...prev };
            delete next[cid];
            return next;
          });
        }, 3500);
      }
    },
    [queryClient, showToast, tJourneys]
  );

  useEffect(() => {
    if (!accessToken) {
      setConnected(false);
      return;
    }

    let cancelled = false;
    sseAttemptRef.current = 0;
    let currentAbort: AbortController | null = null;
    let readyTimer: ReturnType<typeof setTimeout> | null = null;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let wsProbeTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanupTransportTimers = () => {
      if (readyTimer) clearTimeout(readyTimer);
      if (pingTimer) clearInterval(pingTimer);
      if (retryTimer) clearTimeout(retryTimer);
      if (wsProbeTimer) clearTimeout(wsProbeTimer);
      readyTimer = null;
      pingTimer = null;
      retryTimer = null;
      wsProbeTimer = null;
    };

    const stopPolling = () => {
      if (pollTimer) clearInterval(pollTimer);
      if (retryTimer) clearTimeout(retryTimer);
      pollTimer = null;
      retryTimer = null;
    };

    const cleanupAllTimers = () => {
      cleanupTransportTimers();
      stopPolling();
    };

    const startPolling = () => {
      if (cancelled) return;
      cleanupTransportTimers();
      setMode("polling");
      setConnected(false);
      if (!pollTimer) {
        pollTimer = setInterval(() => {
          if (typeof document !== "undefined" && document.hidden) {
            return;
          }
          void queryClient.invalidateQueries({ queryKey: ["journeys"] });
          void queryClient.invalidateQueries({ queryKey: ["journey"] });
          void queryClient.invalidateQueries({ queryKey: ["matches"] });
          void queryClient.invalidateQueries({ queryKey: ["swaps"] });
          void queryClient.invalidateQueries({ queryKey: ["swap"] });
          void queryClient.invalidateQueries({ queryKey: ["conversations"] });
          void queryClient.invalidateQueries({ queryKey: ["messages"] });
        }, POLLING_INTERVAL_MS);
      }

      const backoffMs = Math.min(30000, 2000 * 2 ** sseAttemptRef.current);
      sseAttemptRef.current += 1;
      retryTimer = setTimeout(() => {
        if (!cancelled) startSse();
      }, backoffMs);
    };

    const startSse = () => {
      if (cancelled) return;
      cleanupTransportTimers();
      if (!pollTimer) {
        setMode("sse");
      }
      currentAbort?.abort();
      currentAbort = new AbortController();
      const sseUrl = `${publicEnv.NEXT_PUBLIC_API_URL.replace(/\/$/, "")}/v1/events/stream`;

      wsProbeTimer = setTimeout(() => {
        if (!cancelled && (typeof document === "undefined" || !document.hidden)) {
          currentAbort?.abort();
          startWs();
        }
      }, WS_RECOVERY_PROBE_MS);

      void connectSseStream({
        url: sseUrl,
        token: accessToken,
        signal: currentAbort.signal,
        onOpen: () => {
          if (!cancelled) {
            sseAttemptRef.current = 0;
            stopPolling();
            setMode("sse");
            setConnected(true);
            setReadyCount((c) => c + 1);
          }
        },
        onEvent: handleServerEvent,
        onError: () => {
          if (!cancelled) {
            setConnected(false);
            startPolling();
          }
        },
      });
    };

    const startWs = () => {
      if (cancelled || typeof WebSocket === "undefined") {
        startSse();
        return;
      }
      cleanupTransportTimers();
      if (!pollTimer) {
        setMode("ws");
      }
      setConnected(false);

      let isReady = false;
      let fallbackTriggered = false;
      const triggerSseFallback = () => {
        if (cancelled || fallbackTriggered) return;
        fallbackTriggered = true;
        cleanupTransportTimers();
        try {
          ws.close();
        } catch {
          // ignore
        }
        wsRef.current = null;
        startSse();
      };

      let ws: WebSocket;
      try {
        ws = new WebSocket(publicEnv.NEXT_PUBLIC_WS_URL);
      } catch {
        startSse();
        return;
      }
      wsRef.current = ws;

      readyTimer = setTimeout(() => {
        if (!isReady) {
          triggerSseFallback();
        }
      }, WS_READY_TIMEOUT_MS);

      ws.onopen = () => {
        if (cancelled) return;
        try {
          ws.send(JSON.stringify({ type: "auth", token: accessToken }));
        } catch {
          triggerSseFallback();
        }
      };

      ws.onmessage = (msgEvent) => {
        if (cancelled) return;
        try {
          const parsed = JSON.parse(String(msgEvent.data)) as RealtimeServerEvent;
          if (parsed.type === "ready") {
            isReady = true;
            sseAttemptRef.current = 0;
            stopPolling();
            setMode("ws");
            if (readyTimer) {
              clearTimeout(readyTimer);
              readyTimer = null;
            }
            pingTimer = setInterval(() => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: "ping" }));
              }
            }, WS_PING_INTERVAL_MS);
          }
          handleServerEvent(parsed);
        } catch {
          // ignore invalid JSON frame
        }
      };

      ws.onerror = () => {
        if (!isReady) {
          triggerSseFallback();
        }
      };

      ws.onclose = () => {
        wsRef.current = null;
        if (cancelled) return;
        setConnected(false);
        triggerSseFallback();
      };
    };

    startWs();

    return () => {
      cancelled = true;
      cleanupAllTimers();
      currentAbort?.abort();
      if (wsRef.current) {
        try {
          wsRef.current.close();
        } catch {
          // ignore
        }
        wsRef.current = null;
      }
    };
  }, [accessToken, handleServerEvent, queryClient]);

  const sendTyping = useCallback((conversationId: string) => {
    const now = Date.now();
    const last = lastTypingSentRef.current[conversationId] ?? 0;
    if (now - last < 2000) {
      return;
    }
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      lastTypingSentRef.current[conversationId] = now;
      ws.send(JSON.stringify({ type: "typing", conversation_id: conversationId }));
    }
  }, []);

  const subscribeConversation = useCallback((conversationId: string) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "subscribe", conversation_id: conversationId }));
    }
  }, []);

  return (
    <RealtimeContext.Provider
      value={{
        mode,
        connected,
        readyCount,
        typingByConversation,
        lastChartEventByJourney,
        sendTyping,
        subscribeConversation,
      }}
    >
      {children}
    </RealtimeContext.Provider>
  );
}

export function useRealtime(): RealtimeContextValue {
  return useContext(RealtimeContext);
}
