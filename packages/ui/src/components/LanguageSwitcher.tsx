import { cn } from "../cn";

export interface LanguageSwitcherProps {
  locale: "en" | "hi";
  onToggle: (next: "en" | "hi") => void;
  label?: string;
  disabled?: boolean;
  className?: string;
}

export function LanguageSwitcher({
  locale,
  onToggle,
  label,
  disabled = false,
  className,
}: LanguageSwitcherProps) {
  const nextLocale = locale === "en" ? "hi" : "en";
  const ariaLabel =
    label ?? (locale === "en" ? "हिंदी में बदलें" : "Switch to English");

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onToggle(nextLocale)}
      aria-label={ariaLabel}
      className={cn(
        "inline-flex min-h-[48px] items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-3 text-sm font-medium text-[var(--text)] transition-colors hover:bg-[var(--surface-2)] cursor-pointer",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]",
        "disabled:cursor-not-allowed disabled:opacity-55",
        className
      )}
    >
      <span
        className={cn(
          locale === "hi"
            ? "font-bold text-[var(--primary-text)] underline underline-offset-4"
            : "text-[var(--text-muted)]"
        )}
      >
        हिं
      </span>
      <span className="text-[var(--text-muted)]" aria-hidden="true">
        /
      </span>
      <span
        className={cn(
          locale === "en"
            ? "font-bold text-[var(--primary-text)] underline underline-offset-4"
            : "text-[var(--text-muted)]"
        )}
      >
        EN
      </span>
    </button>
  );
}
