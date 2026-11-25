"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { SaathLogo, ThemeToggle, applyTheme, resolveInitialTheme, type SaathTheme } from "@saath/ui";

export function AdminHeader() {
  const [theme, setTheme] = useState<SaathTheme>("light");

  useEffect(() => {
    setTheme(resolveInitialTheme());
  }, []);

  const handleToggle = () => {
    const next: SaathTheme = theme === "light" ? "dark" : "light";
    applyTheme(next);
    setTheme(next);
  };

  return (
    <header className="border-b border-[var(--border)] bg-[var(--surface)]">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
        <div className="flex items-center gap-3">
          <Link href="/" className="inline-flex min-h-[48px] items-center">
            <SaathLogo size="sm" subtitle="Operations" />
          </Link>
          <span className="rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1 text-xs font-semibold text-[var(--secondary)]">
            Admin
          </span>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/login"
            className="inline-flex min-h-[48px] items-center rounded-[var(--radius-sm)] border border-[var(--border)] px-3.5 text-sm font-medium text-[var(--text)] hover:bg-[var(--surface-2)]"
          >
            SSO Sign In
          </Link>
          <ThemeToggle theme={theme} onToggle={handleToggle} />
        </div>
      </div>
    </header>
  );
}
