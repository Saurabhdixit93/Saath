"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { BottomSheet, Button } from "@saath/ui";
import type { GoalDTO, PutGoalRequest, SeatHolderOwnDTO } from "@saath/contracts";

type GoalType = PutGoalRequest["goal_type"];

export interface GoalWizardSheetProps {
  open: boolean;
  onClose: () => void;
  mode: "train" | "flight" | "bus";
  members: SeatHolderOwnDTO[];
  initialGoal?: GoalDTO | null;
  presetGoalType?: string;
  presetMovers?: string[];
  onSubmit: (payload: PutGoalRequest) => Promise<void>;
  loading?: boolean;
  error?: string | null;
}

export function GoalWizardSheet({
  open,
  onClose,
  mode,
  members,
  initialGoal,
  presetGoalType,
  presetMovers,
  onSubmit,
  loading = false,
  error = null,
}: GoalWizardSheetProps) {
  const t = useTranslations("wizard");
  const tCommon = useTranslations("common");

  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [movers, setMovers] = useState<string[]>([]);
  const [goalType, setGoalType] = useState<GoalType>("together");
  const [preferredSeatsText, setPreferredSeatsText] = useState("");
  const [womenOnly, setWomenOnly] = useState(false);
  const [noMiddle, setNoMiddle] = useState(false);
  const [sameCoachOnly, setSameCoachOnly] = useState(false);
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  const [giveTo, setGiveTo] = useState<"senior" | "women" | "anyone">("senior");

  useEffect(() => {
    if (!open) return;
    setStep(1);
    if (presetGoalType) {
      setGoalType(presetGoalType as GoalType);
      setMovers(
        presetMovers && presetMovers.length > 0
          ? presetMovers
          : members.map((m) => m.id)
      );
      return;
    }
    if (initialGoal) {
      setMovers(initialGoal.movers);
      setGoalType(initialGoal.goal_type);
      setPreferredSeatsText(initialGoal.preferred_seats.join(", "));
      setWomenOnly(Boolean(initialGoal.constraints.women_only));
      setNoMiddle(Boolean(initialGoal.constraints.no_middle));
      setSameCoachOnly(Boolean(initialGoal.constraints.same_coach_only));
      setVerifiedOnly(Boolean(initialGoal.constraints.verified_only));
      if (initialGoal.standing_offer?.give_to) {
        setGiveTo(initialGoal.standing_offer.give_to);
      }
      return;
    }
    setMovers(members.map((m) => m.id));
    setGoalType(members.length > 1 ? "together" : mode === "flight" ? "window" : "lower");
    setPreferredSeatsText("");
    setWomenOnly(false);
    setNoMiddle(false);
    setSameCoachOnly(false);
    setVerifiedOnly(false);
  }, [open, initialGoal, members, mode, presetGoalType, presetMovers]);

  const toggleMover = (id: string) => {
    setMovers((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  const goalOptions: Array<{ value: GoalType; label: string }> =
    mode === "flight"
      ? [
          { value: "together", label: t("goalTogether") },
          { value: "window", label: t("goalWindow") },
          { value: "aisle", label: t("goalAisle") },
          { value: "legroom", label: t("goalLegroom") },
          { value: "specific_seats", label: t("goalSpecific") },
          { value: "open_to_help", label: t("goalOpenToHelp") },
        ]
      : [
          { value: "together", label: t("goalTogether") },
          { value: "lower", label: t("goalLower") },
          { value: "upper", label: t("goalUpper") },
          { value: "same_coach", label: t("goalSameCoach") },
          { value: "specific_seats", label: t("goalSpecific") },
          { value: "open_to_help", label: t("goalOpenToHelp") },
        ];

  const selectedGoalLabel =
    goalOptions.find((g) => g.value === goalType)?.label ?? goalType;

  const handleSave = async () => {
    const seats =
      goalType === "specific_seats"
        ? preferredSeatsText
            .split(",")
            .map((s) => s.trim().toUpperCase())
            .filter(Boolean)
            .slice(0, 4)
        : [];
    await onSubmit({
      goal_type: goalType,
      movers,
      preferred_seats: seats,
      constraints: {
        women_only: womenOnly,
        no_middle: noMiddle,
        same_coach_only: sameCoachOnly,
        verified_only: verifiedOnly,
      },
      standing_offer:
        goalType === "open_to_help" ? { give_to: giveTo } : null,
    });
  };

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={`${t("title")} · ${t("stepLabel", { step })}`}
      closeLabel={tCommon("close")}
    >
      <div className="space-y-4">
        {step === 1 ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-bold text-[var(--text)]">
                {t("step1Title")}
              </h3>
              <Button
                type="button"
                variant="ghost"
                size="md"
                className="px-3.5 py-2 text-sm"
                onClick={() => setMovers(members.map((m) => m.id))}
              >
                {t("selectAllCta")}
              </Button>
            </div>
            <p className="text-xs text-[var(--text-muted)]">{t("step1Subtitle")}</p>
            <div className="space-y-2">
              {members.map((m) => {
                const checked = movers.includes(m.id);
                const seatDesc = m.seat_no
                  ? `${m.coach && m.coach !== "CABIN" ? `${m.coach}-` : ""}${m.seat_no} (${m.seat_type ?? ""})`
                  : m.current_status ?? "WL";
                return (
                  <label
                    key={m.id}
                    className="flex min-h-[48px] cursor-pointer items-center justify-between rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] px-3 py-2"
                  >
                    <span className="flex items-center gap-3 text-sm font-medium text-[var(--text)]">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleMover(m.id)}
                        className="h-5 w-5 accent-[var(--primary-btn-bg)]"
                      />
                      <span>
                        #{m.pax_seq} · {seatDesc}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
            <div className="flex justify-end pt-2">
              <Button
                type="button"
                variant="primary"
                disabled={movers.length === 0}
                onClick={() => setStep(2)}
              >
                {tCommon("next")}
              </Button>
            </div>
          </div>
        ) : null}

        {step === 2 ? (
          <div className="space-y-3">
            <h3 className="text-sm font-bold text-[var(--text)]">{t("step2Title")}</h3>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {goalOptions.map((opt) => {
                const active = goalType === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setGoalType(opt.value)}
                    className={`min-h-[48px] rounded-[var(--radius-sm)] border px-3 py-2 text-left text-sm font-semibold transition-colors cursor-pointer ${
                      active
                        ? "border-[var(--primary-btn-bg)] bg-[var(--surface-2)] text-[var(--primary-text)]"
                        : "border-[var(--border)] bg-[var(--bg)] text-[var(--text)]"
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>

            {goalType === "specific_seats" ? (
              <div>
                <label
                  htmlFor="wizard-specific-seats"
                  className="mb-1 block text-xs font-semibold text-[var(--text)]"
                >
                  {t("specificSeatsLabel")}
                </label>
                <input
                  id="wizard-specific-seats"
                  type="text"
                  value={preferredSeatsText}
                  onChange={(ev) => setPreferredSeatsText(ev.target.value)}
                  placeholder={t("specificSeatsPlaceholder")}
                  className="min-h-[48px] w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] px-3 text-sm text-[var(--text)]"
                  style={{ fontFamily: "var(--font-mono)" }}
                />
              </div>
            ) : null}

            {goalType === "open_to_help" ? (
              <div>
                <label
                  htmlFor="wizard-give-to"
                  className="mb-1 block text-xs font-semibold text-[var(--text)]"
                >
                  {t("standingGiveToLabel")}
                </label>
                <select
                  id="wizard-give-to"
                  value={giveTo}
                  onChange={(ev) =>
                    setGiveTo(ev.target.value as "senior" | "women" | "anyone")
                  }
                  className="min-h-[48px] w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] px-3 text-sm text-[var(--text)]"
                >
                  <option value="senior">{t("giveToSenior")}</option>
                  <option value="women">{t("giveToWomen")}</option>
                  <option value="anyone">{t("giveToAnyone")}</option>
                </select>
              </div>
            ) : null}

            <div className="flex justify-between pt-2">
              <Button type="button" variant="ghost" onClick={() => setStep(1)}>
                {tCommon("back")}
              </Button>
              <Button type="button" variant="primary" onClick={() => setStep(3)}>
                {tCommon("next")}
              </Button>
            </div>
          </div>
        ) : null}

        {step === 3 ? (
          <div className="space-y-3">
            <h3 className="text-sm font-bold text-[var(--text)]">{t("step3Title")}</h3>

            <label
              className="flex min-h-[48px] cursor-pointer items-start gap-3 rounded-[var(--radius-sm)] border p-3"
              style={{
                borderColor: womenOnly ? "var(--women-mode)" : "var(--border)",
                backgroundColor: "var(--bg)",
              }}
            >
              <input
                type="checkbox"
                checked={womenOnly}
                onChange={(ev) => setWomenOnly(ev.target.checked)}
                className="mt-1 h-5 w-5 accent-[var(--women-mode)]"
              />
              <div>
                <span className="block text-sm font-semibold text-[var(--text)]">
                  ◆ {t("womenOnlyLabel")}
                </span>
                <span className="block text-xs text-[var(--text-muted)]">
                  {t("womenOnlyHint")}
                </span>
              </div>
            </label>

            <label className="flex min-h-[48px] cursor-pointer items-center gap-3 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm font-medium text-[var(--text)]">
              <input
                type="checkbox"
                checked={noMiddle}
                onChange={(ev) => setNoMiddle(ev.target.checked)}
                className="h-5 w-5 accent-[var(--primary-btn-bg)]"
              />
              <span>{t("noMiddleLabel")}</span>
            </label>

            {mode === "train" ? (
              <label className="flex min-h-[48px] cursor-pointer items-center gap-3 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm font-medium text-[var(--text)]">
                <input
                  type="checkbox"
                  checked={sameCoachOnly}
                  onChange={(ev) => setSameCoachOnly(ev.target.checked)}
                  className="h-5 w-5 accent-[var(--primary-btn-bg)]"
                />
                <span>{t("sameCoachOnlyLabel")}</span>
              </label>
            ) : null}

            <label className="flex min-h-[48px] cursor-pointer items-center gap-3 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm font-medium text-[var(--text)]">
              <input
                type="checkbox"
                checked={verifiedOnly}
                onChange={(ev) => setVerifiedOnly(ev.target.checked)}
                className="h-5 w-5 accent-[var(--primary-btn-bg)]"
              />
              <span>{t("verifiedOnlyLabel")}</span>
            </label>

            <div className="rounded-[var(--radius-sm)] border border-[var(--secondary)] bg-[var(--surface-2)] p-3 text-xs text-[var(--text)]">
              <span className="font-bold">{t("summaryPrefix")} </span>
              {t("summarySentence", {
                count: movers.length,
                goal: selectedGoalLabel,
              })}
            </div>

            {error ? (
              <p role="alert" className="text-sm font-medium text-[var(--danger-text)]">
                {error}
              </p>
            ) : null}

            <div className="flex justify-between pt-2">
              <Button type="button" variant="ghost" onClick={() => setStep(2)}>
                {tCommon("back")}
              </Button>
              <Button
                type="button"
                variant="primary"
                loading={loading}
                onClick={() => void handleSave()}
              >
                {t("submitCta")}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </BottomSheet>
  );
}
