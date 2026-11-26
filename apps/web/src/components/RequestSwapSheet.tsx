"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { BottomSheet, Button } from "@saath/ui";
import type { MatchCardDTO } from "@saath/contracts";

export interface RequestSwapSheetProps {
  open: boolean;
  card: MatchCardDTO | null;
  loading?: boolean;
  error?: string | null;
  defaultLang?: "en" | "hi";
  onDraftMessage?: (args: {
    cardId: string;
    lang: "en" | "hi";
    tone: "polite";
  }) => Promise<string>;
  onClose: () => void;
  onSubmit: (cardId: string, note?: string) => Promise<void>;
}

export function RequestSwapSheet({
  open,
  card,
  loading = false,
  error = null,
  defaultLang = "en",
  onDraftMessage,
  onClose,
  onSubmit,
}: RequestSwapSheetProps) {
  const t = useTranslations("matches");
  const [note, setNote] = useState("");
  const [draftLang, setDraftLang] = useState<"en" | "hi">(defaultLang);
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);

  useEffect(() => {
    setDraftLang(defaultLang);
  }, [defaultLang]);

  useEffect(() => {
    setNote("");
    setDraftError(null);
  }, [open, card?.card_id]);

  if (!card) {
    return null;
  }

  const handleGenerateDraft = async () => {
    if (!onDraftMessage || drafting) {
      return;
    }
    setDrafting(true);
    setDraftError(null);
    try {
      const drafted = await onDraftMessage({
        cardId: card.card_id,
        lang: draftLang,
        tone: "polite",
      });
      setNote(drafted.slice(0, 300));
    } catch (err) {
      setDraftError(err instanceof Error ? err.message : t("draftErrorGeneric"));
    } finally {
      setDrafting(false);
    }
  };

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={t("requestSheetTitle")}
      description={t("privacyLine")}
    >
      <form
        className="space-y-4"
        onSubmit={async (ev) => {
          ev.preventDefault();
          await onSubmit(card.card_id, note.trim() || undefined);
          setNote("");
        }}
      >
        <div className="grid grid-cols-2 gap-3 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] p-3">
          <div>
            <p className="text-xs text-[var(--text-muted)]">{t("youGive")}</p>
            <p
              className="text-sm font-bold text-[var(--text)]"
              style={{ fontFamily: "var(--font-mono)" }}
            >
              {card.you_give}
            </p>
          </div>
          <div>
            <p className="text-xs text-[var(--text-muted)]">{t("youGet")}</p>
            <p className="text-sm font-bold text-[var(--secondary)]">
              {card.you_get.coach} · {card.you_get.seat_type}
              {card.you_get.bay ? ` · Bay ${card.you_get.bay}` : ""}
            </p>
          </div>
        </div>

        <p className="text-xs font-semibold text-[var(--secondary)]">
          {t("karmaPreview", { points: card.karma_preview.you })}
        </p>

        {onDraftMessage ? (
          <div className="space-y-2 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-semibold text-[var(--text)]">
                {t("draftLangLabel")}
              </span>
              <div className="flex gap-1.5" role="group" aria-label={t("draftLangLabel")}>
                <button
                  type="button"
                  aria-pressed={draftLang === "en"}
                  onClick={() => setDraftLang("en")}
                  className={`min-h-[48px] rounded-[var(--radius-sm)] border px-3 text-xs font-semibold ${
                    draftLang === "en"
                      ? "border-[var(--primary)] bg-[var(--primary-btn-bg)] text-[var(--primary-ink)]"
                      : "border-[var(--border)] bg-[var(--surface)] text-[var(--text)]"
                  }`}
                >
                  {t("draftLangEn")}
                </button>
                <button
                  type="button"
                  aria-pressed={draftLang === "hi"}
                  onClick={() => setDraftLang("hi")}
                  className={`min-h-[48px] rounded-[var(--radius-sm)] border px-3 text-xs font-semibold ${
                    draftLang === "hi"
                      ? "border-[var(--primary)] bg-[var(--primary-btn-bg)] text-[var(--primary-ink)]"
                      : "border-[var(--border)] bg-[var(--surface)] text-[var(--text)]"
                  }`}
                >
                  {t("draftLangHi")}
                </button>
              </div>
            </div>
            <Button
              type="button"
              variant="secondary"
              size="md"
              loading={drafting}
              onClick={() => void handleGenerateDraft()}
              className="w-full"
            >
              {drafting ? t("draftingAiCta") : t("draftWithAiCta")}
            </Button>
            {draftError ? (
              <p role="alert" className="text-xs font-semibold text-[var(--danger-text)]">
                {draftError}
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <label
              htmlFor="swap-request-note"
              className="block text-sm font-medium text-[var(--text)]"
            >
              {t("requestNoteLabel")}
            </label>
            <span className="text-xs text-[var(--text-muted)]">
              {t("draftCharCount", { count: note.length })}
            </span>
          </div>
          <textarea
            id="swap-request-note"
            rows={3}
            maxLength={300}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t("requestNotePlaceholder")}
            className="w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]"
          />
        </div>

        {error ? (
          <p role="alert" className="text-sm font-semibold text-[var(--danger-text)]">
            {error}
          </p>
        ) : null}

        <Button type="submit" variant="primary" loading={loading} className="w-full">
          {t("submitRequestCta")}
        </Button>
      </form>
    </BottomSheet>
  );
}
