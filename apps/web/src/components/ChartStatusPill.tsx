"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import type { ChartStatusDTO } from "@saath/contracts";

export function ChartStatusPill({ chart }: { chart: ChartStatusDTO }) {
  const t = useTranslations("journeys");
  const [secondsLeft, setSecondsLeft] = useState<number | null>(
    chart.seconds_until_chart ?? null
  );

  useEffect(() => {
    setSecondsLeft(chart.seconds_until_chart ?? null);
    if (chart.state !== "pending" || chart.seconds_until_chart == null) {
      return;
    }
    const timer = window.setInterval(() => {
      setSecondsLeft((prev) => (prev !== null && prev > 60 ? prev - 60 : 0));
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [chart.seconds_until_chart, chart.state]);

  if (chart.state === "na") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1 text-xs font-semibold text-[var(--text-muted)]">
        <span aria-hidden="true">✈</span>
        <span>{t("chartNa")}</span>
      </span>
    );
  }

  if (chart.state === "final") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--success)] bg-[var(--surface)] px-3 py-1 text-xs font-semibold text-[var(--success)]">
        <span aria-hidden="true">✓</span>
        <span>{t("chartFinal")}</span>
      </span>
    );
  }

  if (chart.state === "first") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--warning)] bg-[var(--surface)] px-3 py-1 text-xs font-semibold text-[var(--warning)]">
        <span aria-hidden="true">◔</span>
        <span>{t("chartFirst")}</span>
      </span>
    );
  }

  const label =
    secondsLeft !== null && secondsLeft > 0
      ? t("chartPendingCountdown", {
          hours: Math.floor(secondsLeft / 3600),
          minutes: Math.floor((secondsLeft % 3600) / 60),
        })
      : t("chartPending");

  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--secondary)] bg-[var(--surface)] px-3 py-1 text-xs font-semibold text-[var(--secondary)]">
      <span aria-hidden="true">◷</span>
      <span>{label}</span>
    </span>
  );
}
