"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { SeatLegendBadge } from "@saath/ui";
import { buildCoachLayout } from "@/lib/coachLayouts";

export interface CoachBerthMapProps {
  travelClass: string;
  coachLabel?: string | null;
  mySeats?: Array<string | number>;
  selectedSeats?: string[];
  onToggleSeat?: (seatLabel: string) => void;
  womenOnly?: boolean;
}

export function CoachBerthMap({
  travelClass,
  coachLabel,
  mySeats = [],
  selectedSeats = [],
  onToggleSeat,
  womenOnly = false,
}: CoachBerthMapProps) {
  const t = useTranslations("journeys");
  const spec = useMemo(() => buildCoachLayout(travelClass), [travelClass]);
  const mineSet = useMemo(
    () => new Set(mySeats.map((s) => String(s).trim())),
    [mySeats]
  );
  const selectedSet = useMemo(
    () => new Set(selectedSeats.map((s) => s.trim())),
    [selectedSeats]
  );

  const title = coachLabel
    ? `${t("mapTitleTrain")} · ${coachLabel} (${spec.travelClass})`
    : `${t("mapTitleTrain")} (${spec.travelClass})`;

  return (
    <div className="space-y-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--shadow)]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3
          className="text-base font-bold text-[var(--text)]"
          style={{ fontFamily: "var(--font-display)" }}
        >
          {title}
        </h3>
        <div className="flex flex-wrap gap-2">
          <SeatLegendBadge kind="mine" label={t("legendMine")} />
          {onToggleSeat ? (
            <SeatLegendBadge kind="request" label={t("legendRequest")} />
          ) : null}
          {womenOnly ? (
            <SeatLegendBadge kind="women" label={t("legendWomen")} />
          ) : null}
          <SeatLegendBadge kind="empty" label={t("legendEmpty")} />
        </div>
      </div>

      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${spec.viewBoxWidth} ${spec.viewBoxHeight}`}
          className="mx-auto w-full max-w-md"
          role="img"
          aria-label={title}
        >
          <title>{title}</title>
          {spec.slots.map((slot) => {
            const seatStr = String(slot.seatNo);
            const isMine = mineSet.has(seatStr);
            const isSelected = selectedSet.has(seatStr);

            let fill = "var(--seat-empty)";
            let textFill = "var(--text)";
            let stroke = "var(--border)";
            let marker = "";

            if (isMine) {
              fill = "var(--seat-mine)";
              textFill = "var(--primary-ink)";
              stroke = "var(--seat-mine)";
              marker = "●";
            } else if (isSelected) {
              fill = womenOnly ? "var(--women-mode)" : "var(--seat-request)";
              textFill = womenOnly ? "var(--women-mode-ink)" : "var(--warning-ink)";
              stroke = fill;
              marker = womenOnly ? "◆" : "⇄";
            }

            const ariaLabel = `Seat ${slot.label} ${slot.seatType} bay ${slot.bay}${
              isMine ? ` (${t("legendMine")})` : ""
            }`;

            return (
              <g
                key={slot.seatNo}
                role={onToggleSeat ? "button" : undefined}
                tabIndex={onToggleSeat ? 0 : undefined}
                aria-label={ariaLabel}
                aria-pressed={onToggleSeat ? isSelected : undefined}
                onClick={() => onToggleSeat?.(seatStr)}
                onKeyDown={(ev) => {
                  if (onToggleSeat && (ev.key === "Enter" || ev.key === " ")) {
                    ev.preventDefault();
                    onToggleSeat(seatStr);
                  }
                }}
                className={onToggleSeat ? "cursor-pointer focus:outline-none" : undefined}
              >
                <rect
                  x={slot.x}
                  y={slot.y}
                  width={slot.width}
                  height={slot.height}
                  rx={6}
                  fill={fill}
                  stroke={stroke}
                  strokeWidth={isMine || isSelected ? 2 : 1.25}
                />
                <text
                  x={slot.x + slot.width / 2}
                  y={slot.y + 15}
                  textAnchor="middle"
                  fontSize="11"
                  fontWeight="700"
                  fill={textFill}
                  style={{ fontFamily: "var(--font-mono)" }}
                >
                  {marker}
                  {slot.label}
                </text>
                <text
                  x={slot.x + slot.width / 2}
                  y={slot.y + 28}
                  textAnchor="middle"
                  fontSize="9"
                  fill={textFill}
                >
                  {slot.seatType}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
