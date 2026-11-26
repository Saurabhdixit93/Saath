"use client";

import { use, useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BottomSheet, Button, EmptyState, useToast } from "@saath/ui";
import {
  parseProblemDetail,
  type CoachMapSeatDTO,
  type MatchCardDTO,
  type SeatInviteResponse,
} from "@saath/contracts";
import { Link, useRouter } from "@/i18n/navigation";
import { useAuth } from "@/components/AuthProvider";
import { subscribeBrowserWebPush } from "@/lib/notifications/pushClient";
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
  const locale = useLocale();
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
  const [notifySheetOpen, setNotifySheetOpen] = useState(false);
  const [subscribingPush, setSubscribingPush] = useState(false);
  const [seatInvite, setSeatInvite] = useState<SeatInviteResponse | null>(null);

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

  const createSeatInviteMutation = useMutation({
    mutationFn: async (target: { coach?: string; seat_no?: string }) => {
      const { data, error } = await apiClient.POST("/v1/journeys/{journey_id}/invite-seat", {
        params: { path: { journey_id: journeyId } },
        body: target,
      });
      if (error || !data) {
        throw new Error(parseProblemDetail(error)?.detail || t("inviteErrorToast"));
      }
      return data;
    },
    onSuccess: (created) => {
      setSelectedMapSeat(null);
      setSeatInvite(created);
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

  const handleSayHi = async (card: MatchCardDTO) => {
    if (authKind !== "user") {
      openOtpModal();
      return;
    }
    const { data, error } = await apiClient.POST("/v1/conversations", {
      body: { card_id: card.card_id },
    });
    if (error || !data) {
      showToast({
        variant: "error",
        message: parseProblemDetail(error)?.detail || tCommon("errorBody"),
      });
      return;
    }
    router.push(`/inbox/${data.id}`);
  };

  const handleEnableMatchAlerts = async () => {
    if (authKind !== "user") {
      setNotifySheetOpen(false);
      openOtpModal();
      return;
    }
    setSubscribingPush(true);
    try {
      await subscribeBrowserWebPush(apiClient);
      await apiClient.PATCH("/v1/me", {
        body: { notification_channels: { push: true, whatsapp: true } },
      });
      setNotifySheetOpen(false);
      showToast({ variant: "success", message: t("notifyEnabledToast") });
    } catch (err) {
      showToast({
        variant: "error",
        message: err instanceof Error ? err.message : tCommon("errorBody"),
      });
    } finally {
      setSubscribingPush(false);
    }
  };

  const seatLinkedCard = selectedMapSeat?.card_id
    ? items.find((c) => c.card_id === selectedMapSeat.card_id) ?? null
    : null;
  const activeCoach =
    selectedCoach ||
    coachMapQuery.data?.coach ||
    hub.seat_holders?.find((s) => s.coach)?.coach ||
    undefined;

  const shareMessage = seatInvite
    ? locale === "hi"
      ? seatInvite.message_hi
      : seatInvite.message_en
    : "";

  const handleCopySeatInvite = async () => {
    if (!seatInvite) return;
    try {
      await navigator.clipboard.writeText(shareMessage);
      showToast({ variant: "success", message: t("inviteCopiedToast") });
    } catch {
      showToast({ variant: "info", message: seatInvite.invite_url });
    }
  };

  const handleNativeShareInvite = async () => {
    if (!seatInvite || typeof navigator.share !== "function") return;
    try {
      await navigator.share({
        title: t("inviteSheetTitle"),
        text: shareMessage,
        url: seatInvite.invite_url,
      });
    } catch {
      // User dismissed share sheet
    }
  };

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

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            loading={createSeatInviteMutation.isPending}
            onClick={() =>
              createSeatInviteMutation.mutate(activeCoach ? { coach: activeCoach } : {})
            }
          >
            {activeCoach
              ? t("inviteCoachCta", { coach: activeCoach })
              : t("emptyInviteCta")}
          </Button>
          <Link
            href={`/journeys/${journeyId}`}
            className="inline-flex min-h-[48px] items-center rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-4 text-sm font-semibold text-[var(--text)] hover:bg-[var(--surface-2)]"
          >
            ← {tCommon("back")}
          </Link>
        </div>
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
                  <Button
                    variant="secondary"
                    loading={createSeatInviteMutation.isPending}
                    onClick={() =>
                      createSeatInviteMutation.mutate(
                        activeCoach ? { coach: activeCoach } : {}
                      )
                    }
                  >
                    {t("emptyInviteCta")}
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => setNotifySheetOpen(true)}
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
                  onSayHi={(c) => void handleSayHi(c)}
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
            ) : selectedMapSeat.state === "unknown" || selectedMapSeat.state === "occupied" ? (
              <Button
                variant="secondary"
                className="w-full"
                loading={createSeatInviteMutation.isPending}
                onClick={() =>
                  createSeatInviteMutation.mutate({
                    coach: coachMapQuery.data?.coach || activeCoach,
                    seat_no: selectedMapSeat.seat_no,
                  })
                }
              >
                {t("inviteSeatCta", { seat: selectedMapSeat.seat_no })}
              </Button>
            ) : null}
          </div>
        ) : null}
      </BottomSheet>

      <BottomSheet
        open={Boolean(seatInvite)}
        onClose={() => setSeatInvite(null)}
        title={t("inviteSheetTitle")}
        description={t("inviteSheetBody")}
        closeLabel={tCommon("close")}
      >
        {seatInvite ? (
          <div className="space-y-4">
            <div className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] p-3 text-xs text-[var(--text)]">
              <p className="break-all font-semibold" style={{ fontFamily: "var(--font-mono)" }}>
                {seatInvite.invite_url}
              </p>
              <p className="mt-2 leading-relaxed text-[var(--text-muted)]">{shareMessage}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <a
                href={`https://wa.me/?text=${encodeURIComponent(shareMessage)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-[48px] flex-1 items-center justify-center rounded-[var(--radius-sm)] bg-[var(--primary-btn-bg)] px-4 text-sm font-bold text-[var(--primary-ink)]"
              >
                {t("inviteWhatsappCta")}
              </a>
              <Button variant="secondary" onClick={() => void handleCopySeatInvite()}>
                {t("inviteCopyCta")}
              </Button>
              {typeof navigator !== "undefined" && typeof navigator.share === "function" ? (
                <Button variant="ghost" onClick={() => void handleNativeShareInvite()}>
                  {t("inviteNativeShareCta")}
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
      </BottomSheet>

      <RequestSwapSheet
        open={Boolean(requestCard)}
        card={requestCard}
        loading={createSwapMutation.isPending}
        error={requestError}
        defaultLang={locale === "hi" ? "hi" : "en"}
        onDraftMessage={async ({ cardId, lang, tone }) => {
          const { data, error } = await apiClient.POST("/v1/ai/draft-request", {
            body: { card_id: cardId, lang, tone },
          });
          if (error || !data) {
            const problem = parseProblemDetail(error);
            if (problem?.status === 429) {
              throw new Error(t("draftErrorRateLimit"));
            }
            throw new Error(problem?.detail || t("draftErrorGeneric"));
          }
          return data.text;
        }}
        onClose={() => setRequestCard(null)}
        onSubmit={async (cardId, note) => {
          await createSwapMutation.mutateAsync({ cardId, note });
        }}
      />

      <BottomSheet
        open={notifySheetOpen}
        onClose={() => setNotifySheetOpen(false)}
        title={t("notifySheetTitle")}
        description={t("notifySheetBody")}
      >
        <div className="flex flex-wrap gap-2 pt-2">
          <Button
            variant="primary"
            loading={subscribingPush}
            onClick={() => void handleEnableMatchAlerts()}
          >
            {t("notifyConfirmCta")}
          </Button>
          <Button variant="ghost" onClick={() => setNotifySheetOpen(false)}>
            {tCommon("close")}
          </Button>
        </div>
      </BottomSheet>
    </div>
  );
}
