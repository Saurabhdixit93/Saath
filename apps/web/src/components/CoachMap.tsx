"use client";

import { useId, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { SeatLegendBadge } from "@saath/ui";
import type { CoachMapResponse, CoachMapSeatDTO } from "@saath/contracts";
import { buildCoachLayout } from "@/lib/coachLayouts";

export interface CoachMapProps {
  mapData: CoachMapResponse;
  womenOnly?: boolean;
  onSelectCoach?: (coach: string) => void;
  onSelectMatchSeat?: (seat: CoachMapSeatDTO) => void;
}

const SEAT_TYPE_KEY: Record<string, string> = {
  LB: "berthTypeLB",
  MB: "berthTypeMB",
  UB: "berthTypeUB",
  SL: "berthTypeSL",
  SM: "berthTypeSM",
  SU: "berthTypeSU",
  WS: "berthTypeWS",
  MS: "berthTypeMS",
  AS: "berthTypeAS",
};

const STATE_TEXT_KEY: Record<CoachMapSeatDTO["state"], string> = {
  mine: "seatStateMine",
  party: "seatStateParty",
  match: "seatStateMatch",
  incoming: "seatStateIncoming",
  occupied: "seatStateOccupied",
  unknown: "seatStateUnknown",
};

export function CoachMap({
  mapData,
  womenOnly = false,
  onSelectCoach,
  onSelectMatchSeat,
}: CoachMapProps) {
  const tMatches = useTranslations("matches");
  const tJourneys = useTranslations("journeys");
  const uid = useId().replace(/:/g, "");
  const spec = useMemo(() => buildCoachLayout(mapData.travel_class), [mapData.travel_class]);

  const seatByNo = useMemo(() => {
    const map = new Map<string, CoachMapSeatDTO>();
    for (const s of mapData.seats) {
      map.set(s.seat_no.trim().toUpperCase(), s);
    }
    return map;
  }, [mapData.seats]);

  const orderedNos = useMemo(() => spec.slots.map((s) => String(s.seatNo)), [spec.slots]);
  const [activeSeatNo, setActiveSeatNo] = useState<string>(orderedNos[0] ?? "1");
  const optionRefs = useRef<Record<string, SVGGElement | null>>({});

  const moveFocus = (nextNo: string) => {
    setActiveSeatNo(nextNo);
    optionRefs.current[nextNo]?.focus();
  };

  const title = `${tJourneys("mapTitleTrain")} · Coach ${mapData.coach} (${mapData.travel_class})`;

  return (
    <div className="space-y-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--shadow)]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2
          className="text-base font-bold text-[var(--text)]"
          style={{ fontFamily: "var(--font-display)" }}
        >
          {title}
        </h2>

        {mapData.coaches.length > 1 && onSelectCoach ? (
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={tMatches("coachSelectLabel")}>
            {mapData.coaches.map((c) => {
              const active = c === mapData.coach;
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => onSelectCoach(c)}
                  aria-pressed={active}
                  className={`min-h-[48px] min-w-[48px] rounded-[var(--radius-sm)] border px-3 text-xs font-bold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)] ${
                    active
                      ? "border-[var(--primary)] bg-[var(--primary-btn-bg)] text-[var(--primary-ink)]"
                      : "border-[var(--border)] bg-[var(--surface-2)] text-[var(--text)]"
                  }`}
                  style={{ fontFamily: "var(--font-mono)" }}
                >
                  {c}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-2" aria-label="Seat legend">
        <SeatLegendBadge kind="mine" label={tJourneys("legendMine")} />
        <SeatLegendBadge kind="party" label={tJourneys("legendParty")} />
        <SeatLegendBadge kind="match" label={tJourneys("legendMatch")} />
        <SeatLegendBadge kind="request" label={tJourneys("legendRequest")} />
        {womenOnly ? <SeatLegendBadge kind="women" label={tJourneys("legendWomen")} /> : null}
        <SeatLegendBadge kind="empty" label={tJourneys("legendEmpty")} />
      </div>

      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${spec.viewBoxWidth} ${spec.viewBoxHeight}`}
          className="mx-auto w-full max-w-md"
          role="listbox"
          aria-label={title}
        >
          <title>{title}</title>
          <defs>
            <pattern
              id={`pat-match-${uid}`}
              width="6"
              height="6"
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <rect width="6" height="6" fill="var(--seat-match)" />
              <line x1="0" y1="0" x2="0" y2="6" stroke="rgba(255,255,255,0.22)" strokeWidth="2" />
            </pattern>
            <pattern
              id={`pat-req-${uid}`}
              width="6"
              height="6"
              patternUnits="userSpaceOnUse"
            >
              <rect width="6" height="6" fill="var(--seat-request)" />
              <circle cx="3" cy="3" r="1" fill="rgba(28,26,23,0.2)" />
            </pattern>
            <pattern
              id={`pat-women-${uid}`}
              width="6"
              height="6"
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(-45)"
            >
              <rect width="6" height="6" fill="var(--women-mode)" />
              <line x1="0" y1="0" x2="0" y2="6" stroke="rgba(255,255,255,0.2)" strokeWidth="2" />
            </pattern>
          </defs>

          {spec.slots.map((slot, slotIdx) => {
            const seatStr = String(slot.seatNo);
            const cell = seatByNo.get(seatStr) ?? {
              seat_no: seatStr,
              bay: slot.bay,
              seat_type: slot.seatType,
              is_side: slot.isSide,
              is_exit_row: false,
              is_premium: false,
              state: "unknown" as const,
            };

            let fill = "var(--seat-empty)";
            let textFill = "var(--text)";
            let stroke = "var(--border)";
            let marker = "○";

            if (cell.state === "mine") {
              fill = "var(--seat-mine)";
              textFill = "var(--primary-ink)";
              stroke = "var(--seat-mine)";
              marker = "●";
            } else if (cell.state === "party") {
              fill = "var(--surface-2)";
              textFill = "var(--text)";
              stroke = "var(--seat-mine)";
              marker = "◉";
            } else if (cell.state === "match") {
              fill = womenOnly ? `url(#pat-women-${uid})` : `url(#pat-match-${uid})`;
              textFill = womenOnly ? "var(--women-mode-ink)" : "var(--secondary-ink)";
              stroke = womenOnly ? "var(--women-mode)" : "var(--seat-match)";
              marker = womenOnly ? "◆" : "★";
            } else if (cell.state === "incoming") {
              fill = `url(#pat-req-${uid})`;
              textFill = "var(--warning-ink)";
              stroke = "var(--seat-request)";
              marker = "⇄";
            } else if (cell.state === "occupied") {
              fill = "var(--surface-2)";
              textFill = "var(--text-muted)";
              stroke = "var(--border)";
              marker = "•";
            }

            const typeKey = SEAT_TYPE_KEY[cell.seat_type.toUpperCase()];
            const berthName = typeKey ? tMatches(typeKey) : cell.seat_type;
            const stateText = tMatches(STATE_TEXT_KEY[cell.state]);
            const ariaLabel = `Coach ${mapData.coach}, berth ${seatStr}, ${berthName}, ${stateText}`;
            const isSelected = activeSeatNo === seatStr;

            return (
              <g
                key={seatStr}
                ref={(el) => {
                  optionRefs.current[seatStr] = el;
                }}
                role="option"
                aria-selected={isSelected}
                aria-label={ariaLabel}
                tabIndex={isSelected ? 0 : -1}
                onClick={() => {
                  setActiveSeatNo(seatStr);
                  onSelectMatchSeat?.(cell);
                }}
                onKeyDown={(ev) => {
                  let targetIdx: number | null = null;
                  if (ev.key === "ArrowRight") targetIdx = Math.min(orderedNos.length - 1, slotIdx + 1);
                  else if (ev.key === "ArrowLeft") targetIdx = Math.max(0, slotIdx - 1);
                  else if (ev.key === "ArrowDown") targetIdx = Math.min(orderedNos.length - 1, slotIdx + 3);
                  else if (ev.key === "ArrowUp") targetIdx = Math.max(0, slotIdx - 3);
                  else if (ev.key === "Home") targetIdx = 0;
                  else if (ev.key === "End") targetIdx = orderedNos.length - 1;
                  else if (ev.key === "Enter" || ev.key === " ") {
                    ev.preventDefault();
                    onSelectMatchSeat?.(cell);
                    return;
                  }
                  if (targetIdx !== null && orderedNos[targetIdx]) {
                    ev.preventDefault();
                    moveFocus(orderedNos[targetIdx]!);
                  }
                }}
                className="cursor-pointer focus:outline-none"
              >
                <rect
                  x={slot.x}
                  y={slot.y}
                  width={slot.width}
                  height={slot.height}
                  rx={6}
                  fill={fill}
                  stroke={isSelected ? "var(--focus-ring)" : stroke}
                  strokeWidth={isSelected ? 2.5 : cell.state === "unknown" ? 1 : 2}
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
