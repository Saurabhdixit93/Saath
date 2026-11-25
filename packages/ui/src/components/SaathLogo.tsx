import type { HTMLAttributes } from "react";
import { cn } from "../cn";

export interface SaathLogoProps extends HTMLAttributes<HTMLDivElement> {
  showWordmark?: boolean;
  subtitle?: string;
  size?: "sm" | "md" | "lg";
}

const SIZE_MAP = {
  sm: { width: 32, height: 26, text: "text-lg" },
  md: { width: 40, height: 32, text: "text-xl" },
  lg: { width: 48, height: 38, text: "text-2xl" },
} as const;

export function SaathLogo({
  showWordmark = true,
  subtitle,
  size = "md",
  className,
  ...props
}: SaathLogoProps) {
  const dims = SIZE_MAP[size];

  return (
    <div
      className={cn("inline-flex items-center gap-2.5 select-none", className)}
      {...props}
    >
      <svg
        width={dims.width}
        height={dims.height}
        viewBox="0 0 40 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden={showWordmark ? "true" : undefined}
        role={showWordmark ? undefined : "img"}
        aria-label={showWordmark ? undefined : "Saath"}
      >
        {/* Two rounded seat silhouettes merging into one warm shape */}
        <path
          d="M5 9C5 6.23858 7.23858 4 10 4H14.5C16.9853 4 19 6.01472 19 8.5V19H23V24.5C23 26.433 21.433 28 19.5 28H9C6.79086 28 5 26.2091 5 24V9Z"
          fill="var(--primary)"
        />
        <path
          d="M35 9C35 6.23858 32.7614 4 30 4H25.5C23.0147 4 21 6.01472 21 8.5V19H17V24.5C17 26.433 18.567 28 20.5 28H31C33.2091 28 35 26.2091 35 24V9Z"
          fill="var(--secondary)"
          fillOpacity="0.92"
        />
        <rect
          x="14"
          y="19"
          width="12"
          height="9"
          rx="4.5"
          fill="var(--primary)"
          fillOpacity="0.35"
        />
      </svg>

      {showWordmark ? (
        <div className="flex flex-col leading-none">
          <span className="inline-flex items-baseline gap-1.5">
            <span
              className={cn(
                "font-bold tracking-tight text-[var(--text)]",
                dims.text
              )}
              style={{ fontFamily: "var(--font-display)" }}
            >
              Saath
            </span>
            <span className="text-xs font-medium text-[var(--text-muted)]">
              साथ
            </span>
          </span>
          {subtitle ? (
            <span className="mt-0.5 text-xs text-[var(--text-muted)]">
              {subtitle}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
