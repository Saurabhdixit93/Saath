"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { BottomSheet, Button } from "@saath/ui";
import type { MatchCardDTO } from "@saath/contracts";

export interface RequestSwapSheetProps {
  open: boolean;
  card: MatchCardDTO | null;
  loading?: boolean;
  error?: string | null;
  onClose: () => void;
  onSubmit: (cardId: string, note?: string) => Promise<void>;
}

export function RequestSwapSheet({
  open,
  card,
  loading = false,
  error = null,
  onClose,
  onSubmit,
}: RequestSwapSheetProps) {
  const t = useTranslations("matches");
  const [note, setNote] = useState("");

  if (!card) {
    return null;
  }

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

        <div className="space-y-1.5">
          <label
            htmlFor="swap-request-note"
            className="block text-sm font-medium text-[var(--text)]"
          >
            {t("requestNoteLabel")}
          </label>
          <textarea
            id="swap-request-note"
            rows={2}
            maxLength={240}
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
