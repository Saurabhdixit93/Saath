"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { SaathLogo, ThemeToggle, applyTheme, resolveInitialTheme, type SaathTheme } from "@saath/ui";
import { getAdminToken, clearAdminToken } from "@/lib/api";

const NAV_LINKS = [
  { href: "/", label: "Overview" },
  { href: "/moderation", label: "Moderation" },
  { href: "/flags", label: "Feature Flags" },
  { href: "/fraud", label: "Fraud & Disputes" },
  { href: "/audit", label: "Audit Log" },
];

export function AdminHeader() {
  const [theme, setTheme] = useState<SaathTheme>("light");
  const [hasToken, setHasToken] = useState<boolean>(false);
  const pathname = usePathname();

  useEffect(() => {
    setTheme(resolveInitialTheme());
    setHasToken(Boolean(getAdminToken()));
  }, []);

  const handleToggle = () => {
    const next: SaathTheme = theme === "light" ? "dark" : "light";
    applyTheme(next);
    setTheme(next);
  };

  const handleSignOut = () => {
    clearAdminToken();
    setHasToken(false);
    window.location.href = "/login";
  };

  return (
    <header className="border-b border-[var(--border)] bg-[var(--surface)]">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-3">
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-3">
            <Link href="/" className="inline-flex min-h-[48px] items-center">
              <SaathLogo size="sm" subtitle="Operations" />
            </Link>
            <span className="rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1 text-xs font-semibold text-[var(--secondary)]">
              Admin
            </span>
          </div>
          <nav className="hidden items-center gap-1 md:flex">
            {NAV_LINKS.map((link) => {
              const isActive = pathname === link.href;
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                    isActive
                      ? "bg-[var(--surface-2)] text-[var(--secondary)] font-semibold"
                      : "text-[var(--text-muted)] hover:text-[var(--text)]"
                  }`}
                >
                  {link.label}
                </Link>
              );
            })}
          </nav>
        </div>
        <div className="flex items-center gap-3">
          {hasToken ? (
            <button
              onClick={handleSignOut}
              className="inline-flex min-h-[36px] items-center rounded-[var(--radius-sm)] border border-[var(--border)] px-3 text-xs font-medium text-[var(--text-muted)] hover:text-[var(--danger)]"
            >
              Sign Out
            </button>
          ) : (
            <Link
              href="/login"
              className="inline-flex min-h-[36px] items-center rounded-[var(--radius-sm)] border border-[var(--border)] px-3 text-xs font-medium text-[var(--text)] hover:bg-[var(--surface-2)]"
            >
              SSO Sign In
            </Link>
          )}
          <ThemeToggle theme={theme} onToggle={handleToggle} />
        </div>
      </div>
    </header>
  );
}
