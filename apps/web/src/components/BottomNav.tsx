"use client";

import { useTranslations } from "next-intl";
import { Link, usePathname } from "@/i18n/navigation";

export function BottomNav() {
  const t = useTranslations("common");
  const pathname = usePathname();

  const isHome = pathname === "/";
  const isProfile = pathname.startsWith("/profile");

  return (
    <nav
      aria-label="Primary navigation"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-[var(--border)] bg-[var(--surface)]/95 backdrop-blur md:hidden"
    >
      <div className="mx-auto grid max-w-3xl grid-cols-2 pb-[env(safe-area-inset-bottom)]">
        <Link
          href="/"
          aria-current={isHome ? "page" : undefined}
          className={`flex min-h-[52px] items-center justify-center text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)] ${
            isHome ? "text-[var(--primary-text)]" : "text-[var(--text-muted)]"
          }`}
        >
          {t("navHome")}
        </Link>
        <Link
          href="/profile"
          aria-current={isProfile ? "page" : undefined}
          className={`flex min-h-[52px] items-center justify-center text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)] ${
            isProfile ? "text-[var(--primary-text)]" : "text-[var(--text-muted)]"
          }`}
        >
          {t("navProfile")}
        </Link>
      </div>
    </nav>
  );
}
