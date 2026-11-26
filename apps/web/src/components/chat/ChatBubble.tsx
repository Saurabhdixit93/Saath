"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import type { MessageDTO } from "@saath/contracts";
import { Button } from "@saath/ui";

export interface ChatBubbleProps {
  message?: MessageDTO;
  pendingBody?: string;
  pendingStatus?: "queued" | "sending" | "failed";
  pendingError?: string;
  onRetryPending?: () => void;
  onTranslate?: (messageId: string) => Promise<string | null>;
}

export function ChatBubble({
  message,
  pendingBody,
  pendingStatus,
  pendingError,
  onRetryPending,
  onTranslate,
}: ChatBubbleProps) {
  const t = useTranslations("chat");
  const [translatedText, setTranslatedText] = useState<string | null>(null);
  const [translating, setTranslating] = useState(false);

  if (!message && pendingBody !== undefined) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] space-y-1.5 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3 text-[var(--text)]">
          <div className="flex items-center justify-between gap-2 text-xs text-[var(--text-muted)]">
            <span className="font-semibold">{t("youLabel")}</span>
            <span>
              {pendingStatus === "failed"
                ? t("statusFailed")
                : pendingStatus === "sending"
                  ? t("statusSending")
                  : t("statusQueued")}
            </span>
          </div>
          <p className="whitespace-pre-wrap text-sm">{pendingBody}</p>
          {pendingError ? (
            <p className="text-xs font-medium text-[var(--danger-text)]">
              {pendingError}
            </p>
          ) : null}
          {onRetryPending && pendingStatus !== "sending" ? (
            <Button
              variant="secondary"
              size="md"
              onClick={onRetryPending}
              className="mt-1 min-h-[48px] px-3 text-xs"
            >
              {t("retrySendCta")}
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  if (!message) {
    return null;
  }

  const isMe = message.is_me;
  const handleTranslateClick = async () => {
    if (translatedText) {
      setTranslatedText(null);
      return;
    }
    if (!onTranslate) return;
    setTranslating(true);
    try {
      const res = await onTranslate(message.id);
      if (res) {
        setTranslatedText(res);
      }
    } finally {
      setTranslating(false);
    }
  };

  return (
    <div className={`flex ${isMe ? "justify-end" : "justify-start"}`}>
      <article
        className={`max-w-[85%] space-y-1.5 rounded-[var(--radius)] border px-4 py-3 shadow-sm ${
          isMe
            ? "border-[var(--secondary)] bg-[var(--surface-2)] text-[var(--text)]"
            : "border-[var(--border)] bg-[var(--surface)] text-[var(--text)]"
        }`}
      >
        <div className="flex items-center justify-between gap-3 text-xs text-[var(--text-muted)]">
          <span className="font-semibold">
            {isMe ? t("youLabel") : message.sender_alias}
          </span>
          {message.moderation === "redacted" ? (
            <span className="rounded-full border border-[var(--warning)] px-2 py-0.5 text-[11px] font-semibold text-[var(--text)]">
              {t("redactedBadge")}
            </span>
          ) : null}
        </div>

        <p className="whitespace-pre-wrap text-sm leading-relaxed">{message.body}</p>

        {translatedText ? (
          <p className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] px-2.5 py-2 text-xs text-[var(--text)]">
            {translatedText}
          </p>
        ) : null}

        {message.redacted_hint ? (
          <p className="text-xs font-medium text-[var(--text-muted)]">
            {message.redacted_hint}
          </p>
        ) : null}

        {!isMe && onTranslate && message.moderation !== "hidden" ? (
          <div className="pt-1">
            <button
              type="button"
              disabled={translating}
              onClick={() => void handleTranslateClick()}
              className="inline-flex min-h-[48px] items-center rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] px-3 text-xs font-semibold text-[var(--secondary)] hover:bg-[var(--surface-2)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]"
            >
              {translating
                ? t("translating")
                : translatedText
                  ? t("hideTranslationCta")
                  : t("translateCta")}
            </button>
          </div>
        ) : null}
      </article>
    </div>
  );
}
