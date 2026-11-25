"use client";

import { use, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BottomSheet, Button, EmptyState, useToast } from "@saath/ui";
import {
  parseProblemDetail,
  type CoachMapSeatDTO,
  type MatchCardDTO,
} from "@saath/contracts";
import { Link, useRouter } from "@/i18n/navigation";
import { useAuth } from "@/components/AuthProvider";
import { MatchCard } from "@/components/MatchCard";
import { CoachMap } from "@/components/CoachMap";
import { CabinMap } from "@/components/CabinMap";
import { RequestSwapSheet } from "@/components/RequestSwapSheet";

type TabMode = "list" | "map";
type KindFilter = "all" | "pair" | "cycle" | "plan";

export default function JourneyMatchesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: journeyId } = use(params);
  const t = useTranslations("matches");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const queryClient = useQueryClient();
  const { authKind, ensureAuth, apiClient, openOtpModal } = useAuth();
  const { showToast } = useToast();

  const [tab, setTab] = useState<TabMode>("list");
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [selectedCoach, setSelectedCoach] = useState<string | undefined>(undefined);
  const [requestCard, setRequestCard] = useState<MatchCardDTO | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [selectedMapSeat, setSelectedMapSeat] = useState<CoachMapSeatDTO | null>(null);

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

  const partyId = hubQuery.data?.party.id;

  const matchesQuery = useQuery({
    queryKey: ["matches", partyId, kindFilter],
    enabled: Boolean(partyId) && authKind !== "uninitialized",
    queryFn: async () => {
      const { data, error } = await apiClient.GET("/v1/parties/{party_id}/matches", {
        params: {
          path: { party_id: partyId! },
          query: kindFilter === "all" ? {} : { kind: kindFilter },
        },
      });
      if (error || !data) {
        throw new Error(parseProblemDetail(error)?.detail || tCommon("errorBody"));
      }
      return data;
    },
  });

  const coachMapQuery = useQuery({
    queryKey: ["coach-map", journeyId, selectedCoach ?? "default"],
    enabled: Boolean(hubQuery.data) && tab === "map",
    queryFn: async () => {
      const { data, error } = await apiClient.GET("/v1/journeys/{journey_id}/coach-map", {
        params: {
          path: { journey_id: journeyId },
          query: selectedCoach ? { coach: selectedCoach } : {},
        },
      });
      if (error || !data) {
        throw new Error(parseProblemDetail(error)?.detail || tCommon("errorBody"));
      }
      return data;
    },
  });

  const createSwapMutation = useMutation({
    mutationFn: async (args: { cardId: string; note?: string }) => {
      const { data, error } = await apiClient.POST("/v1/swaps", {
        body: args.note ? { card_id: args.cardId, note: args.note } : { card_id: args.cardId },
      });
      if (error || !data) {
        const problem = parseProblemDetail(error);
        throw new Error(problem?.detail || tCommon("errorBody"));
      }
      return data;
    },
    onSuccess: (created) => {
      setRequestCard(null);
      setRequestError(null);
      showToast({ variant: "success", message: t("requestSentToast") });
      router.push(`/swaps/${created.id}`);
    },
    onError: (err) => {
      setRequestError(err.message);
    },
  });

  const openToHelpMutation = useMutation({
    mutationFn: async () => {
      if (!hubQuery.data) {
        throw new Error(tCommon("errorBody"));
      }
      const { data, error } = await apiClient.PUT("/v1/parties/{party_id}/goal", {
        params: { path: { party_id: hubQuery.data.party.id } },
        body: {
          goal_type: "open_to_help",
          movers: hubQuery.data.party.members.map((m) => m.id),
          constraints: {
            women_only: Boolean(hubQuery.data.goal?.constraints?.women_only),
            no_middle: false,
            same_coach_only: false,
            verified_only: false,
          },
          standing_offer: { give_to: "anyone" },
        },
      });
      if (error || !data) {
        throw new Error(parseProblemDetail(error)?.detail || tCommon("errorBody"));
      }
      return data;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["journey", journeyId] });
      await queryClient.invalidateQueries({ queryKey: ["matches", partyId] });
      showToast({ variant: "success", message: t("openToHelpToast") });
    },
    onError: (err) => {
      showToast({ variant: "error", message: err.message });
    },
  });

  if (hubQuery.isLoading || authKind === "uninitialized") {
    return (
      <div className="space-y-4" role="status">
        <div className="h-20 animate-pulse rounded-[var(--radius)] bg-[var(--surface-2)]" />
        <div className="h-48 animate-pulse rounded-[var(--radius)] bg-[var(--surface-2)]" />
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
  const isFlight = hub.journey.mode === "flight";
  const items = matchesQuery.data?.items ?? [];

  const handleOpenRequest = (card: MatchCardDTO) => {
    if (authKind !== "user") {
      openOtpModal();
      return;
    }
    setRequestError(null);
    setRequestCard(card);
  };

  const seatLinkedCard = selectedMapSeat?.card_id
    ? items.find((c) => c.card_id === selectedMapSeat.card_id) ?? null
    : null;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1
            className="text-2xl font-extrabold text-[var(--text)]"
            style={{ fontFamily: "var(--font-display)" }}
          >
            {t("title")} ·{" "}
            <span style={{ fontFamily: "var(--font-mono)" }}>{hub.journey.service_no}</span>
          </h1>
          <p className="text-sm text-[var(--text-muted)]">{t("subtitle")}</p>
        </div>

        <Link
          href={`/journeys/${journeyId}`}
          className="inline-flex min-h-[48px] items-center rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-4 text-sm font-semibold text-[var(--text)] hover:bg-[var(--surface-2)]"
        >
          ← {tCommon("back")}
        </Link>
      </div>

      <div
        role="tablist"
        aria-label={t("title")}
        className="inline-grid w-full max-w-sm grid-cols-2 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] p-1"
      >
        <button
          type="button"
          role="tab"
          aria-selected={tab === "list"}
          onClick={() => setTab("list")}
          className={`min-h-[48px] rounded-[var(--radius-sm)] px-4 text-sm font-bold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)] ${
            tab === "list"
              ? "bg-[var(--surface)] text-[var(--text)] shadow-sm"
              : "text-[var(--text-muted)]"
          }`}
        >
          {t("tabList")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "map"}
          onClick={() => setTab("map")}
          className={`min-h-[48px] rounded-[var(--radius-sm)] px-4 text-sm font-bold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)] ${
            tab === "map"
              ? "bg-[var(--surface)] text-[var(--text)] shadow-sm"
              : "text-[var(--text-muted)]"
          }`}
        >
          {isFlight ? t("tabCabinMap") : t("tabCoachMap")}
        </button>
      </div>

      {tab === "list" ? (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {(
              [
                ["all", t("filterAll")],
                ["pair", t("filterPair")],
                ["cycle", t("filterCycle")],
                ["plan", t("filterPlan")],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                aria-pressed={kindFilter === k}
                onClick={() => setKindFilter(k)}
                className={`min-h-[48px] rounded-full border px-4 text-xs font-bold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)] ${
                  kindFilter === k
                    ? "border-[var(--secondary)] bg-[var(--secondary)] text-[var(--secondary-ink)]"
                    : "border-[var(--border)] bg-[var(--surface)] text-[var(--text)]"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {matchesQuery.isLoading ? (
            <div className="h-44 animate-pulse rounded-[var(--radius)] bg-[var(--surface-2)]" />
          ) : items.length === 0 ? (
            <EmptyState
              title={t("emptyTitle")}
              description={t("emptyDescription")}
              primaryAction={
                <Button
                  variant="primary"
                  loading={openToHelpMutation.isPending}
                  onClick={() => openToHelpMutation.mutate()}
                >
                  {t("emptyOpenToHelpCta")}
                </Button>
              }
              secondaryAction={
                <div className="flex flex-wrap gap-2">
                  <Link
                    href={`/journeys/${journeyId}`}
                    className="inline-flex min-h-[48px] items-center rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-4 text-sm font-semibold text-[var(--text)]"
                  >
                    {t("emptyInviteCta")}
                  </Link>
                  <Button
                    variant="secondary"
                    onClick={() =>
                      showToast({ variant: "info", message: t("notifyEnabledToast") })
                    }
                  >
                    {t("emptyNotifyCta")}
                  </Button>
                </div>
              }
            />
          ) : (
            <div className="space-y-4">
              {items.map((card) => (
                <MatchCard
                  key={card.card_id}
                  card={card}
                  mode={hub.journey.mode}
                  onRequestSwap={handleOpenRequest}
                  requesting={createSwapMutation.isPending && requestCard?.card_id === card.card_id}
                />
              ))}
            </div>
          )}
        </div>
      ) : coachMapQuery.isLoading ? (
        <div className="h-72 animate-pulse rounded-[var(--radius)] bg-[var(--surface-2)]" />
      ) : coachMapQuery.data ? (
        isFlight ? (
          <CabinMap
            layoutRef={coachMapQuery.data.layout_ref}
            carrierCode={hub.journey.carrier_code}
            coachMapSeats={coachMapQuery.data.seats}
            womenOnly={Boolean(hub.goal?.constraints?.women_only)}
            onSelectMatchSeat={(seat) => setSelectedMapSeat(seat)}
          />
        ) : (
          <CoachMap
            mapData={coachMapQuery.data}
            womenOnly={Boolean(hub.goal?.constraints?.women_only)}
            onSelectCoach={(c) => setSelectedCoach(c)}
            onSelectMatchSeat={(seat) => setSelectedMapSeat(seat)}
          />
        )
      ) : null}

      <BottomSheet
        open={Boolean(selectedMapSeat)}
        onClose={() => setSelectedMapSeat(null)}
        title={t("seatDetailTitle")}
        description={selectedMapSeat?.alias ?? undefined}
      >
        {selectedMapSeat ? (
          <div className="space-y-4">
            <p
              className="text-sm font-bold text-[var(--text)]"
              style={{ fontFamily: "var(--font-mono)" }}
            >
              {selectedMapSeat.seat_no} · {selectedMapSeat.seat_type} · Bay {selectedMapSeat.bay}
            </p>
            <p className="text-xs text-[var(--text-muted)]">{t("privacyLine")}</p>
            {seatLinkedCard ? (
              <Button
                variant="primary"
                className="w-full"
                onClick={() => {
                  const target = seatLinkedCard;
                  setSelectedMapSeat(null);
                  handleOpenRequest(target);
                }}
              >
                {t("requestSwapCta")}
              </Button>
            ) : null}
          </div>
        ) : null}
      </BottomSheet>

      <RequestSwapSheet
        open={Boolean(requestCard)}
        card={requestCard}
        loading={createSwapMutation.isPending}
        error={requestError}
        onClose={() => setRequestCard(null)}
        onSubmit={async (cardId, note) => {
          await createSwapMutation.mutateAsync({ cardId, note });
        }}
      />
    </div>
  );
}
