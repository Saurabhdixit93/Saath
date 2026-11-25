"use client";

import { useTranslations } from "next-intl";
import { Button } from "@saath/ui";
import type { GoalDTO, SmartSuggestionDTO } from "@saath/contracts";

export interface GoalCardProps {
  goal: GoalDTO | null | undefined;
  suggestions?: SmartSuggestionDTO[];
  onOpenWizard: (presetGoalType?: string, presetMovers?: string[]) => void;
  onClearGoal?: () => Promise<void>;
  clearing?: boolean;
}

export function GoalCard({
  goal,
  suggestions = [],
  onOpenWizard,
  onClearGoal,
  clearing = false,
}: GoalCardProps) {
  const t = useTranslations("journeys");
  const tWiz = useTranslations("wizard");

  const goalLabelMap: Record<string, string> = {
    together: tWiz("goalTogether"),
    lower: tWiz("goalLower"),
    upper: tWiz("goalUpper"),
    same_coach: tWiz("goalSameCoach"),
    window: tWiz("goalWindow"),
    aisle: tWiz("goalAisle"),
    legroom: tWiz("goalLegroom"),
    specific_seats: tWiz("goalSpecific"),
    open_to_help: tWiz("goalOpenToHelp"),
  };

  return (
    <section className="space-y-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--shadow)]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2
          className="text-base font-bold text-[var(--text)]"
          style={{ fontFamily: "var(--font-display)" }}
        >
          {t("goalSectionTitle")}
        </h2>
        <div className="flex gap-2">
          <Button
            variant="primary"
            size="md"
            className="px-3.5 py-2 text-sm"
            onClick={() => onOpenWizard()}
          >
            {goal ? t("goalEditCta") : t("goalCreateCta")}
          </Button>
          {goal && onClearGoal ? (
            <Button
              variant="ghost"
              size="md"
              className="px-3.5 py-2 text-sm"
              loading={clearing}
              onClick={() => void onClearGoal()}
            >
              {t("goalClearCta")}
            </Button>
          ) : null}
        </div>
      </div>

      {goal ? (
        <div className="space-y-2 rounded-[var(--radius-sm)] border border-[var(--secondary)] bg-[var(--surface-2)] p-3 text-sm">
          <p className="font-bold text-[var(--text)]">
            {goalLabelMap[goal.goal_type] ?? goal.goal_type} · {goal.movers.length}{" "}
            {t("memberCount", { count: goal.movers.length })}
          </p>
          <div className="flex flex-wrap gap-1.5 text-xs">
            {goal.constraints.women_only ? (
              <span className="rounded-full bg-[var(--women-mode)] px-2.5 py-0.5 font-semibold text-[var(--women-mode-ink)]">
                ◆ {tWiz("womenOnlyLabel")}
              </span>
            ) : null}
            {goal.constraints.no_middle ? (
              <span className="rounded-full border border-[var(--border)] bg-[var(--surface)] px-2.5 py-0.5 font-medium text-[var(--text)]">
                {tWiz("noMiddleLabel")}
              </span>
            ) : null}
            {goal.constraints.same_coach_only ? (
              <span className="rounded-full border border-[var(--border)] bg-[var(--surface)] px-2.5 py-0.5 font-medium text-[var(--text)]">
                {tWiz("sameCoachOnlyLabel")}
              </span>
            ) : null}
            {goal.preferred_seats.length > 0 ? (
              <span
                className="rounded-full border border-[var(--border)] bg-[var(--surface)] px-2.5 py-0.5 font-semibold text-[var(--text)]"
                style={{ fontFamily: "var(--font-mono)" }}
              >
                {goal.preferred_seats.join(", ")}
              </span>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-sm font-medium text-[var(--text)]">{t("goalNoneTitle")}</p>
          <p className="text-xs text-[var(--text-muted)]">{t("goalNoneBody")}</p>
        </div>
      )}

      {suggestions.length > 0 && !goal ? (
        <div className="space-y-2 pt-1">
          {suggestions.map((sug) => (
            <div
              key={sug.code}
              className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-xs"
            >
              <span className="font-medium text-[var(--text)]">
                {t(sug.title_key as "suggestionSeniorUpper")}
              </span>
              <Button
                variant="secondary"
                size="md"
                className="px-3.5 py-2 text-sm"
                onClick={() =>
                  onOpenWizard(sug.recommended_goal_type, sug.seat_holder_ids ?? [])
                }
              >
                {t("applySuggestionCta")}
              </Button>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
