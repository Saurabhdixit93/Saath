"use client";

import { useTranslations } from "next-intl";

export interface QuickReplyChipsProps {
  onSelect: (text: string) => void;
  disabled?: boolean;
}

export function QuickReplyChips({ onSelect, disabled = false }: QuickReplyChipsProps) {
  const t = useTranslations("chat");
  const chips = [
    t("quickReplyHappy"),
    t("quickReplyStation"),
    t("quickReplyCoachDoor"),
  ];

  return (
    <div
      className="flex flex-wrap gap-2"
      aria-label={t("quickRepliesLabel")}
    >
      {chips.map((label) => (
        <button
          key={label}
          type="button"
          disabled={disabled}
          onClick={() => onSelect(label)}
          className="inline-flex min-h-[48px] items-center rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-4 text-xs font-semibold text-[var(--text)] hover:border-[var(--secondary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)] disabled:opacity-50"
        >
          {label}
        </button>
      ))}
    </div>
  );
}
