"use client";

import { useId, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { SeatLegendBadge } from "@saath/ui";
import type { CoachMapSeatDTO } from "@saath/contracts";
import { resolveAircraftLayout, seatTypeForColumn } from "@/lib/aircraftLayouts";

export interface CabinMapProps {
  layoutRef?: string | null;
  carrierCode?: string;
  mySeats?: string[];
  selectedSeats?: string[];
  onToggleSeat?: (seatNo: string) => void;
  coachMapSeats?: CoachMapSeatDTO[];
  onSelectMatchSeat?: (seat: CoachMapSeatDTO) => void;
  womenOnly?: boolean;
  maxRowsPreview?: number;
}

export function CabinMap({
  layoutRef,
  carrierCode = "",
  mySeats = [],
  selectedSeats = [],
  onToggleSeat,
  coachMapSeats,
  onSelectMatchSeat,
  womenOnly = false,
  maxRowsPreview,
}: CabinMapProps) {
  const t = useTranslations("journeys");
  const uid = useId().replace(/:/g, "");
  const spec = useMemo(
    () => resolveAircraftLayout(layoutRef, carrierCode),
    [layoutRef, carrierCode]
  );

  const mineSet = useMemo(
    () => new Set(mySeats.map((s) => s.trim().toUpperCase())),
    [mySeats]
  );
  const selectedSet = useMemo(
    () => new Set(selectedSeats.map((s) => s.trim().toUpperCase())),
    [selectedSeats]
  );
  const mapSeatByNo = useMemo(() => {
    const out = new Map<string, CoachMapSeatDTO>();
    for (const s of coachMapSeats ?? []) {
      out.set(s.seat_no.trim().toUpperCase(), s);
    }
    return out;
  }, [coachMapSeats]);

  const displayRows = maxRowsPreview ? Math.min(spec.rows, maxRowsPreview) : spec.rows;
  const cellW = 34;
  const cellH = 28;
  const gap = 5;
  const aisleGap = 20;
  const padX = 36;
  const padY = 24;

  const colXPositions = spec.columns.map((_, idx) => {
    let aislesBefore = 0;
    for (const aisleAfter of spec.aisleAfterIndices) {
      if (idx > aisleAfter) {
        aislesBefore += 1;
      }
    }
    return padX + idx * (cellW + gap) + aislesBefore * aisleGap;
  });

  const orderedSeatNos = useMemo(() => {
    const list: string[] = [];
    for (let r = 1; r <= displayRows; r += 1) {
      for (const letter of spec.columns) {
        const seatNo = `${r}${letter}`;
        if (!spec.excludedSeats.includes(seatNo)) {
          list.push(seatNo);
        }
      }
    }
    return list;
  }, [displayRows, spec.columns, spec.excludedSeats]);

  const [activeSeatNo, setActiveSeatNo] = useState<string>(orderedSeatNos[0] ?? "1A");
  const optionRefs = useRef<Record<string, SVGGElement | null>>({});

  const moveFocus = (nextNo: string) => {
    setActiveSeatNo(nextNo);
    optionRefs.current[nextNo]?.focus();
  };

  const maxColX = colXPositions[colXPositions.length - 1] ?? 180;
  const viewBoxW = maxColX + cellW + 20;
  const viewBoxH = padY + displayRows * (cellH + gap) + 16;
  const title = `${t("mapTitleFlight")} · ${spec.aircraftName}`;
  const isInteractive = Boolean(onToggleSeat || onSelectMatchSeat || coachMapSeats);

  return (
    <div className="space-y-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--shadow)]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3
            className="text-base font-bold text-[var(--text)]"
            style={{ fontFamily: "var(--font-display)" }}
          >
            {title}
          </h3>
          <p className="text-xs text-[var(--text-muted)]">
            {spec.configuration} · {spec.totalSeats} seats
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <SeatLegendBadge kind="mine" label={t("legendMine")} />
          {coachMapSeats ? <SeatLegendBadge kind="match" label={t("legendMatch")} /> : null}
          {onToggleSeat || coachMapSeats ? (
            <SeatLegendBadge kind="request" label={t("legendRequest")} />
          ) : null}
          {womenOnly ? <SeatLegendBadge kind="women" label={t("legendWomen")} /> : null}
          <SeatLegendBadge kind="empty" label={t("legendEmpty")} />
        </div>
      </div>

      <div className="max-h-[420px] overflow-auto">
        <svg
          viewBox={`0 0 ${viewBoxW} ${viewBoxH}`}
          className="mx-auto w-full max-w-md"
          role={isInteractive ? "listbox" : "img"}
          aria-label={title}
        >
          <title>{title}</title>
          <defs>
            <pattern
              id={`cabin-match-${uid}`}
              width="6"
              height="6"
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <rect width="6" height="6" fill="var(--seat-match)" />
              <line x1="0" y1="0" x2="0" y2="6" stroke="rgba(255,255,255,0.22)" strokeWidth="2" />
            </pattern>
          </defs>
          {spec.columns.map((colLetter, colIdx) => (
            <text
              key={colLetter}
              x={(colXPositions[colIdx] ?? 0) + cellW / 2}
              y={15}
              textAnchor="middle"
              fontSize="10"
              fontWeight="700"
              fill="var(--text-muted)"
            >
              {colLetter}
            </text>
          ))}

          {Array.from({ length: displayRows }, (_, rowIdx) => {
            const row = rowIdx + 1;
            const y = padY + rowIdx * (cellH + gap);
            const isExit = spec.exitRows.includes(row);
            return (
              <g key={row}>
                <text
                  x={16}
                  y={y + 18}
                  textAnchor="middle"
                  fontSize="10"
                  fontWeight={isExit ? "700" : "500"}
                  fill={isExit ? "var(--secondary)" : "var(--text-muted)"}
                  style={{ fontFamily: "var(--font-mono)" }}
                >
                  {row}
                  {isExit ? "E" : ""}
                </text>
                {spec.columns.map((letter, colIdx) => {
                  const seatNo = `${row}${letter}`;
                  if (spec.excludedSeats.includes(seatNo)) {
                    return null;
                  }
                  const x = colXPositions[colIdx] ?? 0;
                  const seatType = seatTypeForColumn(spec, colIdx);
                  const dto = mapSeatByNo.get(seatNo);
                  const isMine = dto ? dto.state === "mine" : mineSet.has(seatNo);
                  const isSelected = selectedSet.has(seatNo);

                  let fill = "var(--seat-empty)";
                  let textFill = "var(--text)";
                  let stroke = isExit ? "var(--secondary)" : "var(--border)";
                  let marker = "";

                  if (isMine) {
                    fill = "var(--seat-mine)";
                    textFill = "var(--primary-ink)";
                    stroke = "var(--seat-mine)";
                    marker = "●";
                  } else if (dto?.state === "party") {
                    fill = "var(--surface-2)";
                    textFill = "var(--text)";
                    stroke = "var(--seat-mine)";
                    marker = "◉";
                  } else if (dto?.state === "match") {
                    fill = womenOnly ? "var(--women-mode)" : `url(#cabin-match-${uid})`;
                    textFill = womenOnly ? "var(--women-mode-ink)" : "var(--secondary-ink)";
                    stroke = womenOnly ? "var(--women-mode)" : "var(--seat-match)";
                    marker = womenOnly ? "◆" : "★";
                  } else if (dto?.state === "incoming" || isSelected) {
                    fill = womenOnly ? "var(--women-mode)" : "var(--seat-request)";
                    textFill = womenOnly ? "var(--women-mode-ink)" : "var(--warning-ink)";
                    stroke = fill;
                    marker = womenOnly ? "◆" : "⇄";
                  } else if (dto?.state === "occupied") {
                    fill = "var(--surface-2)";
                    textFill = "var(--text-muted)";
                    marker = "•";
                  }

                  const slotIdx = orderedSeatNos.indexOf(seatNo);
                  const isFocused = activeSeatNo === seatNo;
                  const colsLen = spec.columns.length;

                  const handleActivate = () => {
                    if (onToggleSeat) onToggleSeat(seatNo);
                    if (dto && onSelectMatchSeat) onSelectMatchSeat(dto);
                  };

                  return (
                    <g
                      key={seatNo}
                      ref={(el) => {
                        optionRefs.current[seatNo] = el;
                      }}
                      role={isInteractive ? "option" : undefined}
                      tabIndex={isInteractive ? (isFocused ? 0 : -1) : undefined}
                      aria-label={`Seat ${seatNo} ${seatType}${isExit ? " exit row" : ""}`}
                      aria-selected={isInteractive ? isFocused || isSelected : undefined}
                      onClick={
                        isInteractive
                          ? () => {
                              setActiveSeatNo(seatNo);
                              handleActivate();
                            }
                          : undefined
                      }
                      onKeyDown={
                        isInteractive
                          ? (ev) => {
                              let targetIdx: number | null = null;
                              if (ev.key === "ArrowRight")
                                targetIdx = Math.min(orderedSeatNos.length - 1, slotIdx + 1);
                              else if (ev.key === "ArrowLeft") targetIdx = Math.max(0, slotIdx - 1);
                              else if (ev.key === "ArrowDown")
                                targetIdx = Math.min(orderedSeatNos.length - 1, slotIdx + colsLen);
                              else if (ev.key === "ArrowUp")
                                targetIdx = Math.max(0, slotIdx - colsLen);
                              else if (ev.key === "Home") targetIdx = 0;
                              else if (ev.key === "End") targetIdx = orderedSeatNos.length - 1;
                              else if (ev.key === "Enter" || ev.key === " ") {
                                ev.preventDefault();
                                handleActivate();
                                return;
                              }
                              if (targetIdx !== null && orderedSeatNos[targetIdx]) {
                                ev.preventDefault();
                                moveFocus(orderedSeatNos[targetIdx]!);
                              }
                            }
                          : undefined
                      }
                      className={isInteractive ? "cursor-pointer focus:outline-none" : undefined}
                    >
                      <rect
                        x={x}
                        y={y}
                        width={cellW}
                        height={cellH}
                        rx={5}
                        fill={fill}
                        stroke={isInteractive && isFocused ? "var(--focus-ring)" : stroke}
                        strokeWidth={isMine || isSelected || isExit || isFocused ? 1.8 : 1}
                      />
                      <text
                        x={x + cellW / 2}
                        y={y + 18}
                        textAnchor="middle"
                        fontSize="10"
                        fontWeight="700"
                        fill={textFill}
                        style={{ fontFamily: "var(--font-mono)" }}
                      >
                        {marker}
                        {seatNo}
                      </text>
                    </g>
                  );
                })}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
