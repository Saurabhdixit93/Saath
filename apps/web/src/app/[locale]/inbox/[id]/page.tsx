"use client";

import { use, useCallback, useEffect, useState, type FormEvent } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BottomSheet, Button, EmptyState, useToast } from "@saath/ui";
import { parseProblemDetail } from "@saath/contracts";
import { Link, useRouter } from "@/i18n/navigation";
import { useAuth } from "@/components/AuthProvider";
import { useRealtime } from "@/lib/realtime/RealtimeProvider";
import {
  enqueuePendingMessage,
  flushConversationOutbox,
  listPendingForConversation,
  type PendingChatMessage,
} from "@/lib/chat/outboxDb";
import { ChatBubble } from "@/components/chat/ChatBubble";
import { QuickReplyChips } from "@/components/chat/QuickReplyChips";

const REPORT_REASONS = ["spam", "harassment", "scam", "contact_sharing", "other"] as const;

export default function ConversationChatPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: conversationId } = use(params);
  const t = useTranslations("chat");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { authKind, ensureAuth, apiClient, openOtpModal } = useAuth();
  const { showToast } = useToast();
  const {
    readyCount,
    typingByConversation,
    sendTyping,
    subscribeConversation,
  } = useRealtime();

  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [pendingMessages, setPendingMessages] = useState<PendingChatMessage[]>([]);
  const [blockOpen, setBlockOpen] = useState(false);
  const [blocking, setBlocking] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportReason, setReportReason] = useState<string>("spam");
  const [reportNote, setReportNote] = useState("");
  const [reporting, setReporting] = useState(false);

  useEffect(() => {
    if (authKind === "uninitialized") {
      void ensureAuth();
    }
  }, [authKind, ensureAuth]);

  useEffect(() => {
    if (authKind === "user") {
      subscribeConversation(conversationId);
    }
  }, [authKind, conversationId, subscribeConversation]);

  const refreshPending = useCallback(async () => {
    const rows = await listPendingForConversation(conversationId);
    setPendingMessages(rows);
  }, [conversationId]);

  const messagesQuery = useQuery({
    queryKey: ["messages", conversationId],
    enabled: authKind === "user",
    queryFn: async () => {
      const { data, error } = await apiClient.GET(
        "/v1/conversations/{conversation_id}/messages",
        {
          params: { path: { conversation_id: conversationId }, query: { limit: 50 } },
        }
      );
      if (error || !data) {
        throw new Error(parseProblemDetail(error)?.detail || tCommon("errorBody"));
      }
      return data;
    },
  });

  const sendQueuedItem = useCallback(
    async (item: PendingChatMessage) => {
      const { data, error, response } = await apiClient.POST(
        "/v1/conversations/{conversation_id}/messages",
        {
          params: { path: { conversation_id: item.conversation_id } },
          body: {
            body: item.body,
            client_id: item.client_id,
            lang: item.lang ?? (locale === "hi" ? "hi" : "en"),
          },
        }
      );
      if (error || !data) {
        const problem = parseProblemDetail(error);
        const status = response?.status ?? problem?.status ?? 500;
        const permanentFailure = status === 403 || status === 404 || status === 422;
        return {
          ok: false,
          permanentFailure,
          errorDetail: problem?.detail || tCommon("errorBody"),
        };
      }
      if (data.redacted_hint) {
        showToast({ variant: "info", message: data.redacted_hint });
      }
      return { ok: true };
    },
    [apiClient, locale, showToast, tCommon]
  );

  const flushOutbox = useCallback(async () => {
    if (authKind !== "user") return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    const sent = await flushConversationOutbox(conversationId, sendQueuedItem);
    await refreshPending();
    if (sent > 0) {
      await queryClient.invalidateQueries({ queryKey: ["messages", conversationId] });
      await queryClient.invalidateQueries({ queryKey: ["conversations"] });
    }
  }, [authKind, conversationId, queryClient, refreshPending, sendQueuedItem]);

  useEffect(() => {
    void refreshPending();
  }, [refreshPending]);

  useEffect(() => {
    if (authKind === "user") {
      void flushOutbox();
    }
  }, [authKind, readyCount, flushOutbox]);

  useEffect(() => {
    const onOnline = () => {
      void flushOutbox();
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [flushOutbox]);

  const sendBody = async (textToSend: string) => {
    const trimmed = textToSend.trim();
    if (!trimmed) return;
    if (authKind !== "user") {
      openOtpModal();
      return;
    }

    const clientId =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `msg-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    const pendingItem: PendingChatMessage = {
      client_id: clientId,
      conversation_id: conversationId,
      body: trimmed,
      lang: locale === "hi" ? "hi" : "en",
      created_at: new Date().toISOString(),
      status: "queued",
      attempts: 0,
    };

    setSending(true);
    setDraft("");
    await enqueuePendingMessage(pendingItem);
    await refreshPending();

    try {
      await flushOutbox();
    } finally {
      setSending(false);
    }
  };

  const handleSubmit = (ev: FormEvent) => {
    ev.preventDefault();
    void sendBody(draft);
  };

  const handleTranslate = async (messageId: string): Promise<string | null> => {
    const targetLang = locale === "hi" ? "en" : "hi";
    const { data, error } = await apiClient.POST(
      "/v1/conversations/{conversation_id}/translate",
      {
        params: { path: { conversation_id: conversationId } },
        body: { message_id: messageId, to: targetLang },
      }
    );
    if (error || !data) {
      showToast({
        variant: "error",
        message: parseProblemDetail(error)?.detail || tCommon("errorBody"),
      });
      return null;
    }
    return data.translated_text;
  };

  const handleConfirmBlock = async () => {
    const partnerRef = messagesQuery.data?.conversation.partner_alias_ref;
    if (!partnerRef) return;
    setBlocking(true);
    try {
      const { error } = await apiClient.POST("/v1/users/block", {
        body: { alias_ref: partnerRef },
      });
      if (error) {
        showToast({
          variant: "error",
          message: parseProblemDetail(error)?.detail || tCommon("errorBody"),
        });
        return;
      }
      setBlockOpen(false);
      showToast({ variant: "info", message: t("blockedToast") });
      await queryClient.invalidateQueries({ queryKey: ["conversations"] });
      await queryClient.invalidateQueries({ queryKey: ["messages", conversationId] });
      router.push("/inbox");
    } finally {
      setBlocking(false);
    }
  };

  const handleConfirmReport = async () => {
    const reasonText = reportNote.trim()
      ? `${reportReason}: ${reportNote.trim()}`
      : reportReason;
    setReporting(true);
    try {
      const { error } = await apiClient.POST("/v1/reports", {
        body: {
          conversation_id: conversationId,
          reason: reasonText,
        },
      });
      if (error) {
        showToast({
          variant: "error",
          message: parseProblemDetail(error)?.detail || tCommon("errorBody"),
        });
        return;
      }
      setReportOpen(false);
      setReportNote("");
      showToast({ variant: "success", message: t("reportedToast") });
    } finally {
      setReporting(false);
    }
  };

  if (authKind === "anon") {
    return (
      <EmptyState
        title={t("signInRequiredTitle")}
        description={t("signInRequiredBody")}
        primaryAction={
          <Button variant="primary" onClick={openOtpModal}>
            {t("signInCta")}
          </Button>
        }
      />
    );
  }

  if (messagesQuery.isLoading || authKind === "uninitialized") {
    return <div className="h-64 animate-pulse rounded-[var(--radius)] bg-[var(--surface-2)]" />;
  }

  if (messagesQuery.isError || !messagesQuery.data) {
    return (
      <EmptyState
        title={tCommon("errorTitle")}
        description={messagesQuery.error?.message || tCommon("errorBody")}
        primaryAction={
          <Button onClick={() => void messagesQuery.refetch()}>{tCommon("retry")}</Button>
        }
      />
    );
  }

  const { conversation, items } = messagesQuery.data;
  const myMember = conversation.participants.find((p) => p.is_me);
  const rawTypingState = typingByConversation[conversationId];
  const typingState =
    rawTypingState && (!myMember || rawTypingState.alias !== myMember.alias)
      ? rawTypingState
      : undefined;
  const revealedPartnerSeat = conversation.participants.find((p) => !p.is_me)?.seat_revealed;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--shadow)]">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href="/inbox"
              className="inline-flex min-h-[48px] items-center rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-3 text-xs font-bold text-[var(--text)]"
            >
              ← {tCommon("back")}
            </Link>
            <h1
              className="text-lg font-extrabold text-[var(--text)]"
              style={{ fontFamily: "var(--font-display)" }}
            >
              {conversation.partner_alias}
            </h1>
            <span className="rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-0.5 text-xs font-semibold text-[var(--secondary)]">
              {conversation.unmasked ? t("unmaskedBadge") : t("maskedBadge")}
            </span>
          </div>
          <p
            className="text-xs text-[var(--text-muted)]"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            {conversation.service} · {conversation.date}
            {conversation.unmasked && revealedPartnerSeat
              ? ` · ${revealedPartnerSeat}`
              : ""}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            variant="ghost"
            size="md"
            onClick={() => setReportOpen(true)}
            className="min-h-[48px] px-3 text-xs"
          >
            {t("reportCta")}
          </Button>
          <Button
            variant="secondary"
            size="md"
            onClick={() => setBlockOpen(true)}
            className="min-h-[48px] px-3 text-xs"
          >
            {t("blockCta")}
          </Button>
        </div>
      </header>

      {!conversation.unmasked ? (
        <div
          role="status"
          className="rounded-[var(--radius-sm)] border border-[var(--secondary)] bg-[var(--surface-2)] px-4 py-2.5 text-xs font-semibold text-[var(--text)]"
        >
          {t("redactionHintBanner")}
        </div>
      ) : null}

      {conversation.blocked ? (
        <div
          role="alert"
          className="rounded-[var(--radius-sm)] border border-[var(--danger)] bg-[var(--surface)] px-4 py-3 text-xs font-semibold text-[var(--danger-text)]"
        >
          {t("blockedNotice")}
        </div>
      ) : null}

      <section
        aria-label={t("messagesLabel")}
        className="min-h-[260px] space-y-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--shadow)]"
      >
        {items.length === 0 && pendingMessages.length === 0 ? (
          <p className="py-8 text-center text-sm text-[var(--text-muted)]">
            {t("emptyThread")}
          </p>
        ) : (
          <>
            {items.map((msg) => (
              <ChatBubble
                key={msg.id}
                message={msg}
                onTranslate={handleTranslate}
              />
            ))}
            {pendingMessages
              .filter((p) => !items.some((m) => m.client_id === p.client_id))
              .map((p) => (
                <ChatBubble
                  key={p.client_id}
                  pendingBody={p.body}
                  pendingStatus={p.status}
                  pendingError={p.error_detail}
                  onRetryPending={() => void flushOutbox()}
                />
              ))}
          </>
        )}
      </section>

      <div aria-live="polite" className="min-h-[20px] px-1 text-xs text-[var(--text-muted)]">
        {typingState ? t("typingIndicator", { alias: typingState.alias }) : null}
      </div>

      <QuickReplyChips
        disabled={conversation.blocked || sending}
        onSelect={(chipText) => void sendBody(chipText)}
      />

      <form onSubmit={handleSubmit} className="flex gap-2">
        <label htmlFor="chat-message-input" className="sr-only">
          {t("inputLabel")}
        </label>
        <input
          id="chat-message-input"
          type="text"
          maxLength={1000}
          disabled={conversation.blocked}
          value={draft}
          onChange={(ev) => {
            setDraft(ev.target.value);
            sendTyping(conversationId);
          }}
          placeholder={t("inputPlaceholder")}
          className="min-h-[48px] flex-1 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-3.5 text-base text-[var(--text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)] disabled:opacity-50"
        />
        <Button
          type="submit"
          variant="primary"
          disabled={conversation.blocked || !draft.trim()}
          loading={sending}
          className="min-h-[48px] px-5"
        >
          {t("sendCta")}
        </Button>
      </form>

      <BottomSheet
        open={blockOpen}
        onClose={() => setBlockOpen(false)}
        title={t("blockSheetTitle")}
        description={t("blockSheetBody", { alias: conversation.partner_alias })}
      >
        <div className="flex flex-wrap gap-2 pt-2">
          <Button
            variant="primary"
            loading={blocking}
            onClick={() => void handleConfirmBlock()}
          >
            {t("confirmBlockCta")}
          </Button>
          <Button variant="ghost" onClick={() => setBlockOpen(false)}>
            {tCommon("close")}
          </Button>
        </div>
      </BottomSheet>

      <BottomSheet
        open={reportOpen}
        onClose={() => setReportOpen(false)}
        title={t("reportSheetTitle")}
        description={t("reportSheetBody")}
      >
        <div className="space-y-3">
          <label
            htmlFor="report-reason-select"
            className="block text-sm font-medium text-[var(--text)]"
          >
            {t("reportReasonLabel")}
          </label>
          <select
            id="report-reason-select"
            value={reportReason}
            onChange={(ev) => setReportReason(ev.target.value)}
            className="min-h-[48px] w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] px-3 text-sm text-[var(--text)]"
          >
            {REPORT_REASONS.map((r) => (
              <option key={r} value={r}>
                {t(`reason_${r}`)}
              </option>
            ))}
          </select>
          <label
            htmlFor="report-note-input"
            className="block text-sm font-medium text-[var(--text)]"
          >
            {t("reportDetailsLabel")}
          </label>
          <input
            id="report-note-input"
            type="text"
            maxLength={300}
            value={reportNote}
            onChange={(ev) => setReportNote(ev.target.value)}
            placeholder={t("reportDetailsPlaceholder")}
            className="min-h-[48px] w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] px-3 text-sm text-[var(--text)]"
          />
          <div className="flex flex-wrap gap-2 pt-2">
            <Button
              variant="primary"
              loading={reporting}
              onClick={() => void handleConfirmReport()}
            >
              {t("submitReportCta")}
            </Button>
            <Button variant="ghost" onClick={() => setReportOpen(false)}>
              {tCommon("close")}
            </Button>
          </div>
        </div>
      </BottomSheet>
    </div>
  );
}
