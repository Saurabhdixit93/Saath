"use client";

import { useTranslations } from "next-intl";
import { Link, usePathname } from "@/i18n/navigation";

export function BottomNav() {
  const t = useTranslations("common");
  const pathname = usePathname();

  const isHome = pathname === "/";
  const isJourneys = pathname.startsWith("/journeys") || pathname.startsWith("/party");
  const isInbox = pathname.startsWith("/inbox") || pathname.startsWith("/swaps");
  const isPricing = pathname.startsWith("/pricing");
  const isProfile = pathname.startsWith("/profile");

  const linkClass = (active: boolean) =>
    `flex min-h-[52px] min-w-[48px] items-center justify-center text-xs sm:text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)] ${
      active ? "text-[var(--primary-text)]" : "text-[var(--text-muted)]"
    }`;

  return (
    <nav
      aria-label="Primary navigation"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-[var(--border)] bg-[var(--surface)]/95 backdrop-blur md:hidden"
    >
      <div className="mx-auto grid max-w-3xl grid-cols-5 pb-[env(safe-area-inset-bottom)]">
        <Link href="/" aria-current={isHome ? "page" : undefined} className={linkClass(isHome)}>
          {t("navHome")}
        </Link>
        <Link
          href="/journeys"
          aria-current={isJourneys ? "page" : undefined}
          className={linkClass(isJourneys)}
        >
          {t("navJourneys")}
        </Link>
        <Link
          href="/inbox"
          aria-current={isInbox ? "page" : undefined}
          className={linkClass(isInbox)}
        >
          {t("navInbox")}
        </Link>
        <Link
          href="/pricing"
          aria-current={isPricing ? "page" : undefined}
          className={linkClass(isPricing)}
        >
          {t("navPricing")}
        </Link>
        <Link
          href="/profile"
          aria-current={isProfile ? "page" : undefined}
          className={linkClass(isProfile)}
        >
          {t("navProfile")}
        </Link>
      </div>
    </nav>
  );
}
