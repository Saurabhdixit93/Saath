"use client";

import { useId } from "react";
import { useTranslations } from "next-intl";
import type { MatchOtherDTO } from "@saath/contracts";

export interface CycleSwapDiagramProps {
  kind: "pair" | "cycle3" | "cycle4" | "plan" | string;
  youGive: string;
  youGetLabel: string;
  others: MatchOtherDTO[];
}

export function CycleSwapDiagram({
  kind,
  youGive,
  youGetLabel,
  others,
}: CycleSwapDiagramProps) {
  const t = useTranslations("matches");
  const markerId = useId();
  const nodes = [
    { label: t("youLabel"), sub: youGive },
    ...others.map((o, idx) => ({
      label: o.alias,
      sub: idx === 0 ? youGetLabel : o.trust.replace("_", " "),
    })),
  ];

  const count = nodes.length;
  const cx = 160;
  const cy = 92;
  const rx = count <= 2 ? 96 : 106;
  const ry = count <= 2 ? 10 : 58;

  const coords = nodes.map((_, i) => {
    if (count === 2) {
      return {
        x: i === 0 ? 66 : 254,
        y: 52,
      };
    }
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / count;
    return {
      x: Math.round(cx + rx * Math.cos(angle)),
      y: Math.round(cy + ry * Math.sin(angle)),
    };
  });

  const vbHeight = count === 2 ? 104 : 186;
  const label = t("diagramLabel", { count });

  return (
    <div className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)]/60 p-3">
      <svg
        viewBox={`0 0 320 ${vbHeight}`}
        className="mx-auto w-full max-w-xs"
        role="img"
        aria-label={label}
      >
        <title>{label}</title>
        <defs>
          <marker
            id={markerId}
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 1 L 10 5 L 0 9 z" fill="var(--secondary)" />
          </marker>
        </defs>

        {coords.map((pt, idx) => {
          const nxt = coords[(idx + 1) % coords.length]!;
          const dx = nxt.x - pt.x;
          const dy = nxt.y - pt.y;
          const dist = Math.hypot(dx, dy) || 1;
          const pad = 26;
          const x1 = pt.x + (dx / dist) * pad;
          const y1 = pt.y + (dy / dist) * pad;
          const x2 = nxt.x - (dx / dist) * pad;
          const y2 = nxt.y - (dy / dist) * pad;
          const midX = (x1 + x2) / 2 + (count === 2 ? 0 : (cy - (y1 + y2) / 2) * 0.12);
          const midY = (y1 + y2) / 2 + (count === 2 ? (idx === 0 ? -24 : 24) : ((x1 + x2) / 2 - cx) * 0.12);

          return (
            <path
              key={`${idx}-${kind}`}
              d={`M ${x1.toFixed(1)} ${y1.toFixed(1)} Q ${midX.toFixed(1)} ${midY.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`}
              fill="none"
              stroke="var(--secondary)"
              strokeWidth="2"
              strokeDasharray="5 4"
              markerEnd={`url(#${markerId})`}
            />
          );
        })}

        {coords.map((pt, idx) => {
          const item = nodes[idx]!;
          const isMe = idx === 0;
          return (
            <g key={item.label + idx} transform={`translate(${pt.x}, ${pt.y})`}>
              <rect
                x={-48}
                y={-20}
                width={96}
                height={40}
                rx={12}
                fill={isMe ? "var(--seat-mine)" : "var(--surface)"}
                stroke={isMe ? "var(--seat-mine)" : "var(--secondary)"}
                strokeWidth="1.5"
              />
              <text
                x={0}
                y={-2}
                textAnchor="middle"
                fontSize="10"
                fontWeight="700"
                fill={isMe ? "var(--primary-ink)" : "var(--text)"}
              >
                {item.label.length > 15 ? `${item.label.slice(0, 14)}…` : item.label}
              </text>
              <text
                x={0}
                y={12}
                textAnchor="middle"
                fontSize="9"
                fill={isMe ? "var(--primary-ink)" : "var(--text-muted)"}
                style={{ fontFamily: "var(--font-mono)" }}
              >
                {item.sub.length > 15 ? `${item.sub.slice(0, 14)}…` : item.sub}
              </text>
            </g>
          );
        })}
      </svg>

      <ol className="sr-only">
        {nodes.map((n, idx) => {
          const nxt = nodes[(idx + 1) % nodes.length]!;
          return (
            <li key={idx}>
              {n.label} moves to {nxt.label}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
