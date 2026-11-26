"use client";

import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";

export function AppFooter() {
  const t = useTranslations("footer");

  return (
    <footer className="border-t border-[var(--border)] bg-[var(--surface)]/80 pb-24 md:pb-8">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-4 py-6">
        <nav aria-label={t("ariaLabel")} className="flex flex-wrap items-center gap-3">
          <Link
            href="/legal/privacy"
            className="inline-flex min-h-[48px] min-w-[48px] items-center px-2 text-sm font-semibold text-[var(--secondary)] underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]"
          >
            {t("privacyLink")}
          </Link>
          <Link
            href="/legal/terms"
            className="inline-flex min-h-[48px] min-w-[48px] items-center px-2 text-sm font-semibold text-[var(--secondary)] underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]"
          >
            {t("termsLink")}
          </Link>
          <Link
            href="/grievance"
            className="inline-flex min-h-[48px] min-w-[48px] items-center px-2 text-sm font-semibold text-[var(--secondary)] underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]"
          >
            {t("grievanceLink")}
          </Link>
        </nav>
        <p className="text-xs leading-relaxed text-[var(--text-muted)]">{t("disclaimer")}</p>
      </div>
    </footer>
  );
}
