import type { ReactNode } from "react";
import { cn } from "../cn";

export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description: string;
  primaryAction?: ReactNode;
  secondaryAction?: ReactNode;
  footerNote?: string;
  className?: string;
}

export function EmptyState({
  icon,
  title,
  description,
  primaryAction,
  secondaryAction,
  footerNote,
  className,
}: EmptyStateProps) {
  return (
    <section
      className={cn(
        "rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-6 text-center shadow-[var(--shadow)]",
        className
      )}
    >
      {icon ? (
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--surface-2)] text-[var(--primary-text)]">
          {icon}
        </div>
      ) : null}
      <h3
        className="text-lg font-bold text-[var(--text)]"
        style={{ fontFamily: "var(--font-display)" }}
      >
        {title}
      </h3>
      <p className="mx-auto mt-1.5 max-w-md text-sm text-[var(--text-muted)]">
        {description}
      </p>
      {primaryAction || secondaryAction ? (
        <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
          {primaryAction}
          {secondaryAction}
        </div>
      ) : null}
      {footerNote ? (
        <p className="mt-4 text-xs text-[var(--text-muted)]">{footerNote}</p>
      ) : null}
    </section>
  );
}
