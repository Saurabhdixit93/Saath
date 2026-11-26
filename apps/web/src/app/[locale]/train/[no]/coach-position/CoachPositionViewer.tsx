"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import type { PublicTrainCoachDTO } from "@saath/contracts";
import { CoachBerthMap } from "@/components/CoachBerthMap";

export function CoachPositionViewer({ coaches }: { coaches: PublicTrainCoachDTO[] }) {
  const t = useTranslations("seo.trainCoachPosition");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const selected = coaches[selectedIdx] ?? coaches[0];

  if (!selected) return null;

  return (
    <div className="space-y-5">
      <section className="space-y-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow)]">
        <h2
          className="text-base font-extrabold text-[var(--text)]"
          style={{ fontFamily: "var(--font-display)" }}
        >
          {t("rakeHeading")}
        </h2>
        <div className="flex flex-wrap gap-2">
          {coaches.map((coach, idx) => {
            const active = idx === selectedIdx;
            return (
              <button
                key={`${coach.position}-${coach.coach}`}
                type="button"
                aria-pressed={active}
                onClick={() => setSelectedIdx(idx)}
                className={`min-h-[48px] rounded-[var(--radius-sm)] border px-3 text-xs font-bold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)] ${
                  active
                    ? "border-[var(--primary)] bg-[var(--primary-btn-bg)] text-[var(--primary-ink)]"
                    : "border-[var(--border)] bg-[var(--surface-2)] text-[var(--text)]"
                }`}
                style={{ fontFamily: "var(--font-mono)" }}
              >
                {t("coachChip", {
                  coach: coach.coach,
                  travelClass: coach.travel_class,
                  capacity: coach.capacity,
                })}
              </button>
            );
          })}
        </div>
      </section>

      <section className="space-y-3">
        <h2
          className="text-base font-extrabold text-[var(--text)]"
          style={{ fontFamily: "var(--font-display)" }}
        >
          {t("berthPreviewHeading", { travelClass: selected.travel_class })}
        </h2>
        <CoachBerthMap travelClass={selected.travel_class} coachLabel={selected.coach} />
      </section>
    </div>
  );
}
