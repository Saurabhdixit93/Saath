"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import {
  DPDP_NOTICE_VERSION,
  DPDP_PURPOSES,
  ESSENTIAL_DPDP_PURPOSES,
  type DpdpPurpose,
} from "@/lib/dpdp";

export interface DpdpConsentNoticeProps {
  selections: Record<DpdpPurpose, boolean>;
  onChange: (next: Record<DpdpPurpose, boolean>) => void;
  noticeVersion?: string;
  defaultExpanded?: boolean;
  savedBanner?: boolean;
}

export function DpdpConsentNotice({
  selections,
  onChange,
  noticeVersion = DPDP_NOTICE_VERSION,
  defaultExpanded = false,
  savedBanner = false,
}: DpdpConsentNoticeProps) {
  const t = useTranslations("dpdp");
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <div className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] p-3.5 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-bold text-[var(--text)]">
          {t("noticeTitle", { version: noticeVersion })}
        </p>
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((prev) => !prev)}
          className="inline-flex min-h-[48px] items-center justify-center rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-3 text-xs font-semibold text-[var(--secondary)] cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]"
        >
          {expanded ? t("hideToggle") : t("reviewToggle")}
        </button>
      </div>

      <p className="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">
        {t("noticeCompactSummary")}
      </p>

      {savedBanner ? (
        <p className="mt-1.5 text-xs font-semibold text-[var(--secondary)]">
          {t("noticeSavedSummary", { version: noticeVersion })}
        </p>
      ) : null}

      {expanded ? (
        <ul className="mt-3 space-y-2 border-t border-[var(--border)] pt-3">
          {DPDP_PURPOSES.map((purpose) => {
            const isEssential = ESSENTIAL_DPDP_PURPOSES.has(purpose);
            const checked = isEssential ? true : Boolean(selections[purpose]);
            const title = t(`purpose_${purpose}_title`);
            const desc = t(`purpose_${purpose}_desc`);

            return (
              <li
                key={purpose}
                className="flex items-start justify-between gap-3 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] p-3"
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-bold text-[var(--text)]">{title}</span>
                    <span
                      className={`inline-flex items-center rounded-[var(--radius-sm)] border px-2 py-0.5 text-[11px] font-semibold ${
                        isEssential
                          ? "border-[var(--secondary)] bg-[var(--surface-2)] text-[var(--text)]"
                          : "border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-muted)]"
                      }`}
                    >
                      {isEssential ? t("essentialBadge") : t("optionalBadge")}
                    </span>
                  </div>
                  <p className="text-xs leading-relaxed text-[var(--text-muted)]">{desc}</p>
                </div>

                <button
                  type="button"
                  role="switch"
                  aria-checked={checked}
                  aria-label={title}
                  disabled={isEssential}
                  onClick={() => {
                    if (isEssential) return;
                    onChange({
                      ...selections,
                      [purpose]: !checked,
                    });
                  }}
                  className={`inline-flex min-h-[48px] min-w-[64px] shrink-0 items-center justify-center rounded-[var(--radius-sm)] border px-3 text-xs font-bold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)] ${
                    isEssential
                      ? "border-[var(--success)] bg-[var(--success-btn-bg)] text-[var(--success-ink)] cursor-not-allowed"
                      : checked
                        ? "border-[var(--success)] bg-[var(--success-btn-bg)] text-[var(--success-ink)] cursor-pointer"
                        : "border-[var(--border)] bg-[var(--surface-2)] text-[var(--text)] cursor-pointer"
                  }`}
                  style={{ fontFamily: "var(--font-mono)" }}
                >
                  {checked ? "ON" : "OFF"}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      <div className="mt-1">
        <Link
          href="/legal/privacy"
          className="inline-flex min-h-[48px] items-center text-xs font-semibold text-[var(--secondary)] underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]"
        >
          {t("privacyPolicyLink")}
        </Link>
      </div>
    </div>
  );
}
