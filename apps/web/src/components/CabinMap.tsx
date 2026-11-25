"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { SeatLegendBadge } from "@saath/ui";
import { resolveAircraftLayout, seatTypeForColumn } from "@/lib/aircraftLayouts";

export interface CabinMapProps {
  layoutRef?: string | null;
  carrierCode?: string;
  mySeats?: string[];
  selectedSeats?: string[];
  onToggleSeat?: (seatNo: string) => void;
  womenOnly?: boolean;
  maxRowsPreview?: number;
}

export function CabinMap({
  layoutRef,
  carrierCode = "",
  mySeats = [],
  selectedSeats = [],
  onToggleSeat,
  womenOnly = false,
  maxRowsPreview,
}: CabinMapProps) {
  const t = useTranslations("journeys");
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

  const maxColX = colXPositions[colXPositions.length - 1] ?? 180;
  const viewBoxW = maxColX + cellW + 20;
  const viewBoxH = padY + displayRows * (cellH + gap) + 16;
  const title = `${t("mapTitleFlight")} · ${spec.aircraftName}`;

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
          {onToggleSeat ? (
            <SeatLegendBadge kind="request" label={t("legendRequest")} />
          ) : null}
          {womenOnly ? (
            <SeatLegendBadge kind="women" label={t("legendWomen")} />
          ) : null}
          <SeatLegendBadge kind="empty" label={t("legendEmpty")} />
        </div>
      </div>

      <div className="max-h-[420px] overflow-auto">
        <svg
          viewBox={`0 0 ${viewBoxW} ${viewBoxH}`}
          className="mx-auto w-full max-w-md"
          role="img"
          aria-label={title}
        >
          <title>{title}</title>
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
                  const isMine = mineSet.has(seatNo);
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
                  } else if (isSelected) {
                    fill = womenOnly ? "var(--women-mode)" : "var(--seat-request)";
                    textFill = womenOnly ? "var(--women-mode-ink)" : "var(--warning-ink)";
                    stroke = fill;
                    marker = womenOnly ? "◆" : "⇄";
                  }

                  return (
                    <g
                      key={seatNo}
                      role={onToggleSeat ? "button" : undefined}
                      tabIndex={onToggleSeat ? 0 : undefined}
                      aria-label={`Seat ${seatNo} ${seatType}${isExit ? " exit row" : ""}`}
                      aria-pressed={onToggleSeat ? isSelected : undefined}
                      onClick={() => onToggleSeat?.(seatNo)}
                      onKeyDown={(ev) => {
                        if (onToggleSeat && (ev.key === "Enter" || ev.key === " ")) {
                          ev.preventDefault();
                          onToggleSeat(seatNo);
                        }
                      }}
                      className={onToggleSeat ? "cursor-pointer focus:outline-none" : undefined}
                    >
                      <rect
                        x={x}
                        y={y}
                        width={cellW}
                        height={cellH}
                        rx={5}
                        fill={fill}
                        stroke={stroke}
                        strokeWidth={isMine || isSelected || isExit ? 1.5 : 1}
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
