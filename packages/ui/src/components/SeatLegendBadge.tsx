import { cn } from "../cn";

export type SeatLegendKind = "mine" | "match" | "request" | "empty" | "women";

export interface SeatLegendBadgeProps {
  kind: SeatLegendKind;
  label: string;
  className?: string;
}

const KIND_STYLES: Record<SeatLegendKind, { dotColor: string; inkColor: string; symbol: string }> = {
  mine: {
    dotColor: "bg-[var(--seat-mine)] border-[var(--seat-mine)]",
    inkColor: "text-[var(--primary-ink)]",
    symbol: "●",
  },
  match: {
    dotColor: "bg-[var(--seat-match)] border-[var(--seat-match)]",
    inkColor: "text-[var(--secondary-ink)]",
    symbol: "★",
  },
  request: {
    dotColor: "bg-[var(--seat-request)] border-[var(--seat-request)]",
    inkColor: "text-[var(--warning-ink)]",
    symbol: "⇄",
  },
  empty: {
    dotColor: "bg-[var(--seat-empty)] border-[var(--border)] border-dashed",
    inkColor: "text-[var(--text)]",
    symbol: "○",
  },
  women: {
    dotColor: "bg-[var(--women-mode)] border-[var(--women-mode)]",
    inkColor: "text-[var(--women-mode-ink)]",
    symbol: "◆",
  },
};

export function SeatLegendBadge({ kind, label, className }: SeatLegendBadgeProps) {
  const spec = KIND_STYLES[kind];

  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-xs font-medium text-[var(--text)]",
        className
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "inline-flex h-5 w-5 items-center justify-center rounded-full border text-[11px] font-bold",
          spec.inkColor,
          spec.dotColor
        )}
      >
        {spec.symbol}
      </span>
      <span>{label}</span>
    </span>
  );
}
