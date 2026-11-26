"use client";

import { useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { SeatLegendBadge } from "@saath/ui";
import { buildCoachLayout, findVerticalSlotIndex } from "@/lib/coachLayouts";

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

  const orderedNos = useMemo(() => spec.slots.map((s) => String(s.seatNo)), [spec.slots]);
  const [activeSeatNo, setActiveSeatNo] = useState<string>(orderedNos[0] ?? "1");
  const optionRefs = useRef<Record<string, SVGGElement | null>>({});

  const moveFocus = (nextNo: string) => {
    setActiveSeatNo(nextNo);
    optionRefs.current[nextNo]?.focus();
  };

  const title = coachLabel
    ? `${t("mapTitleTrain")} · ${coachLabel} (${spec.travelClass})`
    : `${t("mapTitleTrain")} (${spec.travelClass})`;
  const isInteractive = Boolean(onToggleSeat);

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
          role={isInteractive ? "listbox" : "img"}
          aria-label={title}
        >
          <title>{title}</title>
          {spec.slots.map((slot, slotIdx) => {
            const seatStr = String(slot.seatNo);
            const isMine = mineSet.has(seatStr);
            const isSelected = selectedSet.has(seatStr);
            const isFocused = activeSeatNo === seatStr;

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
                ref={(el) => {
                  optionRefs.current[seatStr] = el;
                }}
                role={isInteractive ? "option" : undefined}
                tabIndex={isInteractive ? (isFocused ? 0 : -1) : undefined}
                aria-label={ariaLabel}
                aria-selected={isInteractive ? isSelected : undefined}
                onClick={
                  isInteractive
                    ? () => {
                        setActiveSeatNo(seatStr);
                        onToggleSeat?.(seatStr);
                      }
                    : undefined
                }
                onKeyDown={
                  isInteractive
                    ? (ev) => {
                        let targetIdx: number | null = null;
                        if (ev.key === "ArrowRight")
                          targetIdx = Math.min(orderedNos.length - 1, slotIdx + 1);
                        else if (ev.key === "ArrowLeft") targetIdx = Math.max(0, slotIdx - 1);
                        else if (ev.key === "ArrowDown")
                          targetIdx = findVerticalSlotIndex(spec.slots, slotIdx, "down");
                        else if (ev.key === "ArrowUp")
                          targetIdx = findVerticalSlotIndex(spec.slots, slotIdx, "up");
                        else if (ev.key === "Home") targetIdx = 0;
                        else if (ev.key === "End") targetIdx = orderedNos.length - 1;
                        else if (ev.key === "Enter" || ev.key === " ") {
                          ev.preventDefault();
                          onToggleSeat?.(seatStr);
                          return;
                        }
                        if (targetIdx !== null && orderedNos[targetIdx]) {
                          ev.preventDefault();
                          moveFocus(orderedNos[targetIdx]!);
                        }
                      }
                    : undefined
                }
                className={isInteractive ? "cursor-pointer focus:outline-none" : undefined}
              >
                <rect
                  x={slot.x}
                  y={slot.y}
                  width={slot.width}
                  height={slot.height}
                  rx={6}
                  fill={fill}
                  stroke={isInteractive && isFocused ? "var(--focus-ring)" : stroke}
                  strokeWidth={isMine || isSelected || (isInteractive && isFocused) ? 2 : 1.25}
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
