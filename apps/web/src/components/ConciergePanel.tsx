"use client";

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@saath/ui";
import type { PutGoalRequest, SeatHolderOwnDTO } from "@saath/contracts";
import { useAuth } from "@/components/AuthProvider";
import { publicEnv } from "@/lib/env";
import {
  ConciergeApiError,
  normalizeProposedGoal,
  streamConcierge,
  type ConciergeProposal,
} from "@/lib/ai/conciergeStream";

export interface ConciergePanelProps {
  journeyId: string;
  members: SeatHolderOwnDTO[];
  applyingGoal?: boolean;
  onApplyGoal: (payload: PutGoalRequest) => Promise<void>;
  fetchImpl?: typeof globalThis.fetch;
}

const GOAL_LABEL_KEY = {
  together: "goalTogether",
  lower: "goalLower",
  upper: "goalUpper",
  same_coach: "goalSameCoach",
  window: "goalWindow",
  aisle: "goalAisle",
  legroom: "goalLegroom",
  specific_seats: "goalSpecific",
  open_to_help: "goalOpenToHelp",
} as const satisfies Record<PutGoalRequest["goal_type"], string>;

export function ConciergePanel({
  journeyId,
  members,
  applyingGoal = false,
  onApplyGoal,
  fetchImpl,
}: ConciergePanelProps) {
  const t = useTranslations("concierge");
  const tWizard = useTranslations("wizard");
  const { accessToken, authKind, ensureAuth, openOtpModal } = useAuth();

  const [prompt, setPrompt] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [explanation, setExplanation] = useState("");
  const [proposal, setProposal] = useState<ConciergeProposal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fallbackMoverIds = members.map((m) => m.id);

  const handleSubmit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    const trimmed = prompt.trim();
    if (!trimmed || streaming) {
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setStreaming(true);
    setError(null);
    setExplanation("");
    setProposal(null);

    try {
      const token = accessToken ?? (await ensureAuth());
      if (!token || authKind === "anon") {
        if (authKind === "anon") {
          setError(t("errorAuthRequired"));
          openOtpModal();
          return;
        }
        setError(t("errorGeneric"));
        return;
      }

      let latestText = "";
      await streamConcierge({
        apiUrl: publicEnv.NEXT_PUBLIC_API_URL,
        token,
        journeyId,
        text: trimmed,
        signal: controller.signal,
        fetchImpl,
        onEvent: (evt) => {
          if (evt.event === "proposal") {
            setProposal(normalizeProposedGoal(evt.data, fallbackMoverIds));
          } else if (evt.event === "explanation" || evt.event === "message") {
            const chunk = evt.data.delta ?? evt.data.text ?? "";
            if (evt.data.delta) {
              latestText += chunk;
            } else if (chunk) {
              latestText = chunk;
            }
            setExplanation(latestText);
          }
        },
      });
    } catch (err) {
      if (err instanceof ConciergeApiError) {
        if (err.status === 429) {
          setError(t("errorRateLimit"));
        } else if (err.code === "ai_concierge_disabled") {
          setError(t("errorDisabled"));
        } else if (err.status === 401 || err.code === "user_auth_required") {
          setError(t("errorAuthRequired"));
        } else {
          setError(err.message || t("errorGeneric"));
        }
      } else if (err instanceof Error && err.name !== "AbortError") {
        setError(err.message || t("errorGeneric"));
      }
    } finally {
      setStreaming(false);
    }
  };

  const handleConfirm = async () => {
    if (!proposal) {
      return;
    }
    setError(null);
    try {
      await onApplyGoal(proposal.payload);
      setProposal(null);
      setExplanation("");
      setPrompt("");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("errorGeneric"));
    }
  };

  const handleDismiss = () => {
    setProposal(null);
    setExplanation("");
    setError(null);
  };

  const chips = [
    t("chipLower"),
    t("chipTogether"),
    t("chipOpenToHelp"),
  ];

  const activeConstraints: string[] = [];
  if (proposal) {
    if (proposal.payload.constraints?.women_only) {
      activeConstraints.push(tWizard("womenOnlyLabel"));
    }
    if (proposal.payload.constraints?.no_middle) {
      activeConstraints.push(tWizard("noMiddleLabel"));
    }
    if (proposal.payload.constraints?.same_coach_only) {
      activeConstraints.push(tWizard("sameCoachOnlyLabel"));
    }
    if (proposal.payload.constraints?.verified_only) {
      activeConstraints.push(tWizard("verifiedOnlyLabel"));
    }
  }

  return (
    <section
      aria-labelledby="concierge-heading"
      className="space-y-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow)]"
    >
      <div className="space-y-1">
        <h2 id="concierge-heading" className="text-lg font-bold text-[var(--text)]">
          {t("title")}
        </h2>
        <p className="text-xs text-[var(--text-muted)]">{t("subtitle")}</p>
      </div>

      <div className="flex flex-wrap gap-2">
        {chips.map((chip) => (
          <button
            key={chip}
            type="button"
            onClick={() => setPrompt(chip)}
            className="min-h-[48px] rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-3.5 py-2 text-xs font-semibold text-[var(--text)] hover:border-[var(--primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]"
          >
            {chip}
          </button>
        ))}
      </div>

      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="space-y-1.5">
          <label
            htmlFor="ai-concierge-input"
            className="block text-sm font-medium text-[var(--text)]"
          >
            {t("inputLabel")}
          </label>
          <textarea
            id="ai-concierge-input"
            rows={2}
            maxLength={1000}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={t("inputPlaceholder")}
            className="min-h-[48px] w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="submit"
            variant="primary"
            size="md"
            loading={streaming}
            disabled={!prompt.trim()}
          >
            {streaming ? t("thinking") : t("askCta")}
          </Button>
        </div>
      </form>

      {error ? (
        <p
          role="alert"
          className="rounded-[var(--radius-sm)] border border-[var(--danger)] bg-[var(--surface-2)] px-3 py-2 text-xs font-semibold text-[var(--danger-text)]"
        >
          {error}
        </p>
      ) : null}

      <div aria-live="polite" className="space-y-3">
        {explanation ? (
          <p className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] p-3 text-sm text-[var(--text)]">
            {explanation}
          </p>
        ) : null}

        {proposal ? (
          <div className="space-y-3 rounded-[var(--radius-sm)] border border-[var(--secondary)] bg-[var(--surface-2)] p-4">
            <div className="space-y-1">
              <p className="text-xs font-semibold uppercase tracking-wide text-[var(--secondary)]">
                {t("proposalTitle")}
              </p>
              <p className="text-base font-bold text-[var(--text)]">
                {tWizard(GOAL_LABEL_KEY[proposal.payload.goal_type])}
              </p>
              <p className="text-xs text-[var(--text-muted)]">
                {t("moversCount", { count: (proposal.payload.movers ?? []).length })}
                {proposal.payload.preferred_seats && proposal.payload.preferred_seats.length > 0
                  ? ` · ${proposal.payload.preferred_seats.join(", ")}`
                  : ""}
              </p>
            </div>

            {activeConstraints.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {activeConstraints.map((label) => (
                  <span
                    key={label}
                    className="rounded-full border border-[var(--border)] bg-[var(--surface)] px-2.5 py-0.5 text-xs font-medium text-[var(--text)]"
                  >
                    {label}
                  </span>
                ))}
              </div>
            ) : null}

            <p className="text-xs text-[var(--text-muted)]">{t("privacyHint")}</p>

            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="primary"
                size="md"
                loading={applyingGoal}
                onClick={() => void handleConfirm()}
              >
                {t("confirmCta")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="md"
                disabled={applyingGoal}
                onClick={handleDismiss}
              >
                {t("dismissCta")}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
