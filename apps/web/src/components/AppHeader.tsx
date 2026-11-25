"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import {
  Button,
  LanguageSwitcher,
  SaathLogo,
  ThemeToggle,
  applyTheme,
  resolveInitialTheme,
  type SaathTheme,
} from "@saath/ui";
import { Link, usePathname, useRouter } from "@/i18n/navigation";
import { useAuth } from "./AuthProvider";

export function AppHeader() {
  const tCommon = useTranslations("common");
  const tAuth = useTranslations("auth");
  const locale = useLocale() === "hi" ? "hi" : "en";
  const pathname = usePathname();
  const router = useRouter();
  const { authKind, user, openOtpModal } = useAuth();
  const [theme, setTheme] = useState<SaathTheme>("light");

  useEffect(() => {
    setTheme(resolveInitialTheme());
  }, []);

  const handleToggleTheme = () => {
    const next: SaathTheme = theme === "light" ? "dark" : "light";
    applyTheme(next);
    setTheme(next);
  };

  const handleToggleLocale = (next: "en" | "hi") => {
    router.replace(pathname, { locale: next });
  };

  return (
    <header className="sticky top-0 z-30 border-b border-[var(--border)] bg-[var(--bg)]/95 backdrop-blur">
      <div className="mx-auto flex max-w-3xl items-center justify-between gap-2 px-4 py-2.5">
        <Link
          href="/"
          className="inline-flex min-h-[48px] items-center rounded-[var(--radius-sm)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]"
        >
          <SaathLogo size="sm" />
        </Link>

        <div className="flex items-center gap-2">
          <nav aria-label="Desktop navigation" className="hidden items-center gap-1 md:flex">
            <Link
              href="/journeys"
              className="inline-flex min-h-[44px] items-center rounded-[var(--radius-sm)] px-2.5 text-sm font-semibold text-[var(--text)] hover:bg-[var(--surface-2)]"
            >
              {tCommon("navJourneys")}
            </Link>
            <Link
              href="/pricing"
              className="inline-flex min-h-[44px] items-center rounded-[var(--radius-sm)] px-2.5 text-sm font-semibold text-[var(--text)] hover:bg-[var(--surface-2)]"
            >
              {tCommon("navPricing")}
            </Link>
          </nav>
          <LanguageSwitcher
            locale={locale}
            onToggle={handleToggleLocale}
            label={tCommon("switchLanguage")}
          />
          <ThemeToggle
            theme={theme}
            onToggle={handleToggleTheme}
            lightLabel={tCommon("switchToLight")}
            darkLabel={tCommon("switchToDark")}
          />
          {authKind === "user" ? (
            <Link
              href="/profile"
              className="inline-flex min-h-[48px] items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--secondary)] bg-[var(--surface)] px-3 text-sm font-semibold text-[var(--text)] hover:bg-[var(--surface-2)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]"
            >
              <span
                aria-hidden="true"
                className="h-2 w-2 rounded-full bg-[var(--success)]"
              />
              <span>{user?.display_alias || tAuth("signedInBadge")}</span>
            </Link>
          ) : (
            <Button variant="ghost" onClick={openOtpModal} className="px-3 text-sm">
              {tAuth("signInCta")}
            </Button>
          )}
        </div>
      </div>
    </header>
  );
}
