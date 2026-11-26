"use client";

import { useLocale, useTranslations } from "next-intl";

export const CANONICAL_BADGE_CODES = [
  "first_swap",
  "senior_saviour",
  "family_uniter",
  "night_owl",
  "ten_swaps",
] as const;

export type CanonicalBadgeCode = (typeof CANONICAL_BADGE_CODES)[number];

export interface KarmaBadgeProps {
  code: string;
  title?: string;
  description?: string;
  earnedAt?: string | null;
  newlyUnlocked?: boolean;
}

function BadgeIcon({ code, unlocked }: { code: string; unlocked: boolean }) {
  const strokeClass = unlocked
    ? "text-[var(--primary-text)]"
    : "text-[var(--text-muted)]";

  if (code === "senior_saviour") {
    return (
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className={`h-6 w-6 shrink-0 ${strokeClass}`}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 21s-7-4.35-7-10a4 4 0 0 1 7-2.65A4 4 0 0 1 19 11c0 5.65-7 10-7 10z" />
      </svg>
    );
  }
  if (code === "family_uniter") {
    return (
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className={`h-6 w-6 shrink-0 ${strokeClass}`}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </svg>
    );
  }
  if (code === "night_owl") {
    return (
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className={`h-6 w-6 shrink-0 ${strokeClass}`}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
      </svg>
    );
  }
  if (code === "ten_swaps") {
    return (
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className={`h-6 w-6 shrink-0 ${strokeClass}`}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6" />
        <path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18" />
        <path d="M4 22h16" />
        <path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22" />
        <path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22" />
        <path d="M18 2H6v7a6 6 0 0 0 12 0V2Z" />
      </svg>
    );
  }
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className={`h-6 w-6 shrink-0 ${strokeClass}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="8" r="6" />
      <path d="M15.477 12.89 17 22l-5-3-5 3 1.523-9.11" />
    </svg>
  );
}

export function KarmaBadge({
  code,
  title,
  description,
  earnedAt,
  newlyUnlocked = false,
}: KarmaBadgeProps) {
  const t = useTranslations("karma");
  const locale = useLocale() === "hi" ? "hi" : "en";
  const unlocked = Boolean(earnedAt);

  const isCanonical = (CANONICAL_BADGE_CODES as readonly string[]).includes(code);
  const resolvedTitle =
    title ||
    (isCanonical ? t(`badge_${code}_title` as Parameters<typeof t>[0]) : code);
  const resolvedDesc =
    description ||
    (isCanonical ? t(`badge_${code}_desc` as Parameters<typeof t>[0]) : "");

  const formattedDate = earnedAt
    ? new Intl.DateTimeFormat(
        locale === "hi" ? "hi-IN-u-nu-latn" : "en-IN",
        {
          day: "2-digit",
          month: "short",
          year: "numeric",
        }
      ).format(new Date(earnedAt))
    : null;

  return (
    <article
      data-testid={`karma-badge-${code}`}
      className={`flex items-start gap-3 rounded-[var(--radius)] border p-4 transition-colors ${
        unlocked
          ? "border-[var(--success)] bg-[var(--surface)] shadow-[var(--shadow)]"
          : "border-[var(--border)] bg-[var(--surface-2)]"
      } ${unlocked && newlyUnlocked ? "karma-badge-unlock" : ""}`}
    >
      <div
        className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--radius-sm)] border ${
          unlocked
            ? "border-[var(--primary)] bg-[var(--bg)]"
            : "border-[var(--border)] bg-[var(--surface)]"
        }`}
      >
        <BadgeIcon code={code} unlocked={unlocked} />
      </div>

      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-bold text-[var(--text)]">{resolvedTitle}</h3>
          {unlocked && formattedDate ? (
            <span className="inline-flex items-center rounded-full bg-[var(--success-btn-bg)] px-2.5 py-0.5 text-[11px] font-bold text-[var(--success-ink)]">
              {newlyUnlocked
                ? t("badgeNewHighlight")
                : t("badgeUnlocked", { date: formattedDate })}
            </span>
          ) : (
            <span className="inline-flex items-center rounded-full border border-[var(--border)] bg-[var(--surface)] px-2.5 py-0.5 text-[11px] font-semibold text-[var(--text-muted)]">
              {t("badgeLocked")}
            </span>
          )}
        </div>
        {resolvedDesc ? (
          <p className="text-xs leading-relaxed text-[var(--text-muted)]">
            {resolvedDesc}
          </p>
        ) : null}
      </div>
    </article>
  );
}
