import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "../cn";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "women";
export type ButtonSize = "md" | "lg" | "icon";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  fullWidth?: boolean;
}

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    "bg-[var(--primary-btn-bg)] text-[var(--primary-ink)] hover:bg-[var(--primary-hover-bg)] border border-transparent shadow-sm",
  secondary:
    "bg-[var(--secondary)] text-[var(--secondary-ink)] hover:opacity-95 border border-transparent shadow-sm",
  ghost:
    "bg-transparent text-[var(--text)] hover:bg-[var(--surface-2)] border border-[var(--border)]",
  danger:
    "bg-[var(--danger)] text-[var(--danger-ink)] hover:opacity-95 border border-transparent shadow-sm",
  women:
    "bg-[var(--women-mode)] text-[var(--women-mode-ink)] hover:opacity-95 border border-transparent shadow-sm",
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  md: "min-h-[48px] px-5 py-2.5 text-base",
  lg: "min-h-[52px] px-6 py-3 text-base",
  icon: "min-h-[48px] min-w-[48px] p-2.5",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant = "primary",
      size = "md",
      loading = false,
      fullWidth = false,
      disabled,
      type = "button",
      className,
      children,
      ...props
    },
    ref
  ) {
    const isDisabled = Boolean(disabled || loading);

    return (
      <button
        ref={ref}
        type={type}
        disabled={isDisabled}
        aria-busy={loading || undefined}
        className={cn(
          "inline-flex items-center justify-center gap-2 rounded-[var(--radius-sm)] font-semibold transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)] cursor-pointer",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]",
          "disabled:cursor-not-allowed disabled:opacity-55",
          VARIANT_CLASSES[variant],
          SIZE_CLASSES[size],
          fullWidth && "w-full",
          className
        )}
        {...props}
      >
        {loading ? (
          <svg
            className="h-4 w-4 animate-spin"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-85"
              fill="currentColor"
              d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
            />
          </svg>
        ) : null}
        {children}
      </button>
    );
  }
);
