"use client";

import { use, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, EmptyState, useToast } from "@saath/ui";
import { parseProblemDetail, type PutGoalRequest } from "@saath/contracts";
import { Link, useRouter } from "@/i18n/navigation";
import { useAuth } from "@/components/AuthProvider";
import { useRealtime } from "@/lib/realtime/RealtimeProvider";
import { ChartStatusPill } from "@/components/ChartStatusPill";
import { PartyAvatarRow } from "@/components/PartyAvatarRow";
import { GoalCard } from "@/components/GoalCard";
import { GoalWizardSheet } from "@/components/GoalWizardSheet";
import { CoachBerthMap } from "@/components/CoachBerthMap";
import { CabinMap } from "@/components/CabinMap";

export default function JourneyHubPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: journeyId } = use(params);
  const t = useTranslations("journeys");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const queryClient = useQueryClient();
  const { authKind, ensureAuth, apiClient } = useAuth();
  const { showToast } = useToast();
  const { lastChartEventByJourney } = useRealtime();

  const [wizardOpen, setWizardOpen] = useState(false);
  const [presetGoalType, setPresetGoalType] = useState<string | undefined>(undefined);
  const [presetMovers, setPresetMovers] = useState<string[] | undefined>(undefined);
  const [goalError, setGoalError] = useState<string | null>(null);

  useEffect(() => {
    if (authKind === "uninitialized") {
      void ensureAuth();
    }
  }, [authKind, ensureAuth]);

  const hubQuery = useQuery({
    queryKey: ["journey", journeyId],
    enabled: authKind !== "uninitialized",
    queryFn: async () => {
      const { data, error } = await apiClient.GET("/v1/journeys/{journey_id}", {
        params: { path: { journey_id: journeyId } },
      });
      if (error || !data) {
        throw new Error(parseProblemDetail(error)?.detail || tCommon("errorBody"));
      }
      return data;
    },
  });

  const reverifyMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await apiClient.POST("/v1/journeys/{journey_id}/reverify", {
        params: { path: { journey_id: journeyId } },
      });
      if (error || !data) {
        throw new Error(parseProblemDetail(error)?.detail || tCommon("errorBody"));
      }
      return data;
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(["journey", journeyId], updated);
      showToast({ variant: "success", message: t("reverifiedToast") });
    },
    onError: (err) => {
      showToast({ variant: "error", message: err.message });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await apiClient.DELETE("/v1/journeys/{journey_id}", {
        params: { path: { journey_id: journeyId } },
      });
      if (error || !data) {
        throw new Error(parseProblemDetail(error)?.detail || tCommon("errorBody"));
      }
      return data;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["journeys"] });
      showToast({ variant: "info", message: t("deletedToast") });
      router.push("/journeys");
    },
    onError: (err) => {
      showToast({ variant: "error", message: err.message });
    },
  });

  const goalMutation = useMutation({
    mutationFn: async (args: { partyId: string; payload: PutGoalRequest }) => {
      const { data, error } = await apiClient.PUT("/v1/parties/{party_id}/goal", {
        params: { path: { party_id: args.partyId } },
        body: args.payload,
      });
      if (error || !data) {
        throw new Error(parseProblemDetail(error)?.detail || tCommon("errorBody"));
      }
      return data;
    },
    onSuccess: async () => {
      setGoalError(null);
      setWizardOpen(false);
      await queryClient.invalidateQueries({ queryKey: ["journey", journeyId] });
      showToast({ variant: "success", message: t("goalSavedToast") });
    },
    onError: (err) => {
      setGoalError(err.message);
    },
  });

  const clearGoalMutation = useMutation({
    mutationFn: async (partyId: string) => {
      const { data, error } = await apiClient.DELETE("/v1/parties/{party_id}/goal", {
        params: { path: { party_id: partyId } },
      });
      if (error || !data) {
        throw new Error(parseProblemDetail(error)?.detail || tCommon("errorBody"));
      }
      return data;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["journey", journeyId] });
      showToast({ variant: "info", message: t("goalClearedToast") });
    },
  });

  const handleGenerateInvite = async (): Promise<string | null> => {
    const { data, error } = await apiClient.POST("/v1/journeys/{journey_id}/party/invite", {
      params: { path: { journey_id: journeyId } },
    });
    if (error || !data) {
      showToast({
        variant: "error",
        message: parseProblemDetail(error)?.detail || tCommon("errorBody"),
      });
      return null;
    }
    return data.invite_url;
  };

  const handleRemoveMember = async (partyId: string, seatHolderId: string) => {
    const { data, error } = await apiClient.DELETE(
      "/v1/party/{party_id}/members/{seat_holder_id}",
      { params: { path: { party_id: partyId, seat_holder_id: seatHolderId } } }
    );
    if (error || !data) {
      showToast({
        variant: "error",
        message: parseProblemDetail(error)?.detail || tCommon("errorBody"),
      });
      return;
    }
    queryClient.setQueryData(["journey", journeyId], data);
    showToast({ variant: "info", message: t("memberRemovedToast") });
  };

  if (hubQuery.isLoading || authKind === "uninitialized") {
    return (
      <div className="space-y-4" role="status">
        <div className="h-28 animate-pulse rounded-[var(--radius)] bg-[var(--surface-2)]" />
        <div className="h-44 animate-pulse rounded-[var(--radius)] bg-[var(--surface-2)]" />
      </div>
    );
  }

  if (hubQuery.isError || !hubQuery.data) {
    return (
      <EmptyState
        title={tCommon("errorTitle")}
        description={hubQuery.error?.message || tCommon("errorBody")}
        primaryAction={
          <Button onClick={() => void hubQuery.refetch()}>{tCommon("retry")}</Button>
        }
      />
    );
  }

  const hub = hubQuery.data;
  const chartEvent = lastChartEventByJourney[journeyId];
  const showLiveChartBanner =
    hub.chart.state === "final" ||
    hub.chart.state === "first" ||
    Boolean(chartEvent);
  const primaryCoach = hub.party.members.find((m) => m.coach)?.coach ?? null;
  const mySeatNos = hub.party.members
    .map((m) => m.seat_no)
    .filter((s): s is string => Boolean(s));

  const trustBadge =
    hub.booking.trust_tier === "verified_provider"
      ? t("trustVerifiedProvider")
      : hub.booking.trust_tier === "verified_bcbp"
        ? t("trustVerifiedBcbp")
        : hub.booking.trust_tier === "verified_doc"
          ? t("trustVerifiedDoc")
          : t("trustDeclared");

  return (
    <div className="space-y-5">
      <section className="space-y-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow)]">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1
                className="text-2xl font-extrabold text-[var(--text)]"
                style={{ fontFamily: "var(--font-mono)" }}
              >
                {hub.journey.service_no}
              </h1>
              <span className="rounded-full border border-[var(--secondary)] bg-[var(--surface-2)] px-2.5 py-0.5 text-xs font-semibold text-[var(--secondary)]">
                {trustBadge}
              </span>
              <ChartStatusPill chart={hub.chart} />
            </div>
            <p className="text-sm text-[var(--text-muted)]">
              {hub.booking.from_code ?? ""} → {hub.booking.to_code ?? ""} ·{" "}
              {hub.journey.service_date}
            </p>
            <p className="text-xs font-medium text-[var(--text-muted)]">
              {t("coachActiveLabel", { count: hub.counts.coach_active_count })} ·{" "}
              {t("journeyActiveLabel", { count: hub.counts.journey_active_count })}
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <Link
              href={`/journeys/${journeyId}/matches`}
              className="inline-flex min-h-[48px] items-center rounded-[var(--radius-sm)] bg-[var(--primary-btn-bg)] px-4 text-sm font-bold text-[var(--primary-ink)] hover:bg-[var(--primary-hover-bg)]"
            >
              {t("viewMatchesCta")}
            </Link>
            <Button
              variant="secondary"
              size="md"
              className="px-3.5 py-2 text-sm"
              loading={reverifyMutation.isPending}
              onClick={() => reverifyMutation.mutate()}
            >
              {t("reverifyCta")}
            </Button>
            <Button
              variant="ghost"
              size="md"
              className="px-3.5 py-2 text-sm"
              loading={deleteMutation.isPending}
              onClick={() => deleteMutation.mutate()}
            >
              {t("deleteCta")}
            </Button>
          </div>
        </div>

        {hub.booking.claim_conflict_flagged ? (
          <p
            role="alert"
            className="rounded-[var(--radius-sm)] border border-[var(--warning)] bg-[var(--surface-2)] px-3 py-2 text-xs font-semibold text-[var(--danger-text)]"
          >
            {t("conflictFlagged")}
          </p>
        ) : null}

        {showLiveChartBanner ? (
          <div
            role="status"
            aria-live="polite"
            className="rounded-[var(--radius-sm)] border border-[var(--secondary)] bg-[var(--surface-2)] px-3 py-2 text-xs font-semibold text-[var(--text)]"
          >
            {chartEvent?.changed || hub.chart.state === "final"
              ? t("chartLiveFinalBanner")
              : t("chartLiveFirstBanner")}
          </div>
        ) : null}
      </section>

      <PartyAvatarRow
        party={hub.party}
        serviceNo={hub.journey.service_no}
        serviceDate={hub.journey.service_date}
        onGenerateInvite={handleGenerateInvite}
        onRemoveMember={(shId) => handleRemoveMember(hub.party.id, shId)}
      />

      <GoalCard
        goal={hub.goal}
        suggestions={hub.suggestions}
        onOpenWizard={(goalTypePreset, moversPreset) => {
          setPresetGoalType(goalTypePreset);
          setPresetMovers(moversPreset);
          setGoalError(null);
          setWizardOpen(true);
        }}
        onClearGoal={async () => {
          await clearGoalMutation.mutateAsync(hub.party.id);
        }}
        clearing={clearGoalMutation.isPending}
      />

      {hub.journey.mode === "train" ? (
        <CoachBerthMap
          travelClass={hub.booking.travel_class ?? "3A"}
          coachLabel={primaryCoach}
          mySeats={mySeatNos}
          selectedSeats={hub.goal?.preferred_seats ?? []}
          womenOnly={Boolean(hub.goal?.constraints?.women_only)}
        />
      ) : (
        <CabinMap
          layoutRef={hub.journey.layout_ref}
          carrierCode={hub.journey.carrier_code}
          mySeats={mySeatNos}
          selectedSeats={hub.goal?.preferred_seats ?? []}
          womenOnly={Boolean(hub.goal?.constraints?.women_only)}
        />
      )}

      <GoalWizardSheet
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        mode={hub.journey.mode}
        members={hub.party.members}
        initialGoal={hub.goal}
        presetGoalType={presetGoalType}
        presetMovers={presetMovers}
        loading={goalMutation.isPending}
        error={goalError}
        onSubmit={async (payload) => {
          await goalMutation.mutateAsync({ partyId: hub.party.id, payload });
        }}
      />
    </div>
  );
}
