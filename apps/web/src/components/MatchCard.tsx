"use client";

import { useTranslations } from "next-intl";
import { Button } from "@saath/ui";
import type { MatchCardDTO } from "@saath/contracts";
import { CycleSwapDiagram } from "./CycleSwapDiagram";

export interface MatchCardProps {
  card: MatchCardDTO;
  mode: "train" | "flight" | "bus";
  onRequestSwap: (card: MatchCardDTO) => void;
  onSayHi?: (card: MatchCardDTO) => void;
  requesting?: boolean;
}

const SEAT_TYPE_KEY_MAP = {
  LB: "berthTypeLB",
  MB: "berthTypeMB",
  UB: "berthTypeUB",
  SL: "berthTypeSL",
  SM: "berthTypeSM",
  SU: "berthTypeSU",
  WS: "berthTypeWS",
  MS: "berthTypeMS",
  AS: "berthTypeAS",
} as const;

export function MatchCard({
  card,
  mode,
  onRequestSwap,
  onSayHi,
  requesting = false,
}: MatchCardProps) {
  const t = useTranslations("matches");

  const upperType = card.you_get.seat_type.toUpperCase();
  const seatTypeName =
    upperType in SEAT_TYPE_KEY_MAP
      ? t(SEAT_TYPE_KEY_MAP[upperType as keyof typeof SEAT_TYPE_KEY_MAP])
      : card.you_get.seat_type;
  const targetSummary =
    mode === "flight"
      ? `${seatTypeName}${card.you_get.bay ? ` · Row ${card.you_get.bay}` : ""}`
      : `Coach ${card.you_get.coach} · ${seatTypeName}${
          card.you_get.bay ? ` · Bay ${card.you_get.bay}` : ""
        }`;

  const primaryOther = card.others[0];
  const isDeclared = card.others.some((o) => o.trust === "declared");
  const isMulti = card.kind === "cycle3" || card.kind === "cycle4" || card.kind === "plan";

  return (
    <article className="space-y-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--shadow)]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className="rounded-full bg-[var(--secondary)] px-3 py-1 text-xs font-bold text-[var(--secondary-ink)]"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            {t("scoreLabel", { score: card.score })}
          </span>
          <span className="text-sm font-bold text-[var(--text)]">{card.label}</span>
        </div>

        <span className="rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-0.5 text-xs font-semibold text-[var(--text)]">
          {isDeclared ? t("declaredBadge") : `✓ ${t("verifiedBadge")}`}
        </span>
      </div>

      <div className="grid gap-2 rounded-[var(--radius-sm)] bg-[var(--surface-2)] p-3 sm:grid-cols-2">
        <div>
          <p className="text-xs font-medium text-[var(--text-muted)]">{t("youGive")}</p>
          <p
            className="text-sm font-bold text-[var(--text)]"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            {card.you_give}
          </p>
        </div>
        <div>
          <p className="text-xs font-medium text-[var(--text-muted)]">{t("youGet")}</p>
          <p className="text-sm font-bold text-[var(--secondary)]">{targetSummary}</p>
        </div>
      </div>

      {primaryOther ? (
        <p className="text-xs font-medium text-[var(--text-muted)]">
          {primaryOther.alias} ·{" "}
          {t("reliabilityText", { reliability: primaryOther.reliability })} ·{" "}
          {t("respondsIn", { time: primaryOther.responds_in })}
        </p>
      ) : null}

      {isMulti ? (
        <div className="space-y-1.5">
          <CycleSwapDiagram
            kind={card.kind}
            youGive={card.you_give}
            youGetLabel={`${card.you_get.coach}-${card.you_get.seat_type}`}
            others={card.others}
          />
          <p className="text-xs font-semibold text-[var(--secondary)]">
            {t("cycleAllMustAccept", { count: card.others.length + 1 })}
          </p>
        </div>
      ) : null}

      {card.reasons.length > 0 ? (
        <div>
          <p className="sr-only">{t("whyLabel")}</p>
          <ul className="flex flex-wrap gap-1.5">
            {card.reasons.map((reason, idx) => (
              <li
                key={idx}
                className="rounded-full border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1 text-xs text-[var(--text)]"
              >
                {reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="text-xs text-[var(--text-muted)]">{t("privacyLine")}</p>

      <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
        <span className="text-xs font-semibold text-[var(--secondary)]">
          {t("karmaPreview", { points: card.karma_preview.you })}
        </span>
        <div className="flex flex-wrap gap-2">
          {onSayHi ? (
            <Button
              variant="secondary"
              size="md"
              onClick={() => onSayHi(card)}
              className="px-4 text-sm"
            >
              {t("sayHiCta")}
            </Button>
          ) : null}
          <Button
            variant="primary"
            size="md"
            loading={requesting}
            onClick={() => onRequestSwap(card)}
            className="px-4 text-sm"
          >
            {t("requestSwapCta")}
          </Button>
        </div>
      </div>
    </article>
  );
}
