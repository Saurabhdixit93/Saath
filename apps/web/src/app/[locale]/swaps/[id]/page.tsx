"use client";

import { use, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, EmptyState, useToast } from "@saath/ui";
import { parseProblemDetail } from "@saath/contracts";
import { Link } from "@/i18n/navigation";
import { useAuth } from "@/components/AuthProvider";
import { CycleSwapDiagram } from "@/components/CycleSwapDiagram";

export default function SwapDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: swapId } = use(params);
  const t = useTranslations("swaps");
  const tCommon = useTranslations("common");
  const queryClient = useQueryClient();
  const { authKind, ensureAuth, apiClient } = useAuth();
  const { showToast } = useToast();
  const [declineReason, setDeclineReason] = useState("");

  useEffect(() => {
    if (authKind === "uninitialized") {
      void ensureAuth();
    }
  }, [authKind, ensureAuth]);

  const swapQuery = useQuery({
    queryKey: ["swap", swapId],
    enabled: authKind !== "uninitialized",
    queryFn: async () => {
      const { data, error } = await apiClient.GET("/v1/swaps/{swap_id}", {
        params: { path: { swap_id: swapId } },
      });
      if (error || !data) {
        throw new Error(parseProblemDetail(error)?.detail || tCommon("errorBody"));
      }
      return data;
    },
  });

  const acceptMutation = useMutation({
    mutationFn: async (version: number) => {
      const { data, error } = await apiClient.POST("/v1/swaps/{swap_id}/accept", {
        params: { path: { swap_id: swapId } },
        body: { version },
      });
      if (error || !data) {
        const problem = parseProblemDetail(error);
        if (problem?.status === 409) {
          throw new Error(t("conflictToast"));
        }
        throw new Error(problem?.detail || tCommon("errorBody"));
      }
      return data;
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(["swap", swapId], updated);
      showToast({ variant: "success", message: t("acceptedToast") });
    },
    onError: async (err) => {
      await queryClient.invalidateQueries({ queryKey: ["swap", swapId] });
      showToast({ variant: "error", message: err.message });
    },
  });

  const declineMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await apiClient.POST("/v1/swaps/{swap_id}/decline", {
        params: { path: { swap_id: swapId } },
        body: declineReason.trim() ? { reason: declineReason.trim() } : {},
      });
      if (error || !data) {
        throw new Error(parseProblemDetail(error)?.detail || tCommon("errorBody"));
      }
      return data;
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(["swap", swapId], updated);
      showToast({ variant: "info", message: t("declinedToast") });
    },
    onError: (err) => {
      showToast({ variant: "error", message: err.message });
    },
  });

  const cancelMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await apiClient.POST("/v1/swaps/{swap_id}/cancel", {
        params: { path: { swap_id: swapId } },
      });
      if (error || !data) {
        throw new Error(parseProblemDetail(error)?.detail || tCommon("errorBody"));
      }
      return data;
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(["swap", swapId], updated);
      showToast({ variant: "info", message: t("cancelledToast") });
    },
    onError: (err) => {
      showToast({ variant: "error", message: err.message });
    },
  });

  const confirmMutation = useMutation({
    mutationFn: async (answer: "yes" | "no" | "did_not_board") => {
      const { data, error } = await apiClient.POST(
        "/v1/swaps/{swap_id}/confirm-completion",
        {
          params: { path: { swap_id: swapId } },
          body: { answer },
        }
      );
      if (error || !data) {
        throw new Error(parseProblemDetail(error)?.detail || tCommon("errorBody"));
      }
      return { updated: data, answer };
    },
    onSuccess: ({ updated, answer }) => {
      queryClient.setQueryData(["swap", swapId], updated);
      showToast({
        variant: answer === "yes" ? "success" : "info",
        message: answer === "yes" ? t("confirmThanks") : t("confirmDisputed"),
      });
    },
    onError: (err) => {
      showToast({ variant: "error", message: err.message });
    },
  });

  if (swapQuery.isLoading || authKind === "uninitialized") {
    return <div className="h-48 animate-pulse rounded-[var(--radius)] bg-[var(--surface-2)]" />;
  }

  if (swapQuery.isError || !swapQuery.data) {
    return (
      <EmptyState
        title={tCommon("errorTitle")}
        description={swapQuery.error?.message || tCommon("errorBody")}
        primaryAction={
          <Button onClick={() => void swapQuery.refetch()}>{tCommon("retry")}</Button>
        }
      />
    );
  }

  const swap = swapQuery.data;
  const partners = swap.participants.filter((p) => !p.is_me);

  const statusLabelKey: Record<string, string> = {
    pending: "statusPending",
    confirmed: "statusConfirmed",
    declined: "statusDeclined",
    cancelled: "statusCancelled",
    expired: "statusExpired",
    invalidated: "statusInvalidated",
    awaiting_confirmation: "statusAwaitingConfirmation",
    completed: "statusCompleted",
    not_completed: "statusNotCompleted",
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1
            className="text-2xl font-extrabold text-[var(--text)]"
            style={{ fontFamily: "var(--font-display)" }}
          >
            {t("detailTitle")} ·{" "}
            <span style={{ fontFamily: "var(--font-mono)" }}>{swap.service}</span>
          </h1>
          <p className="text-sm text-[var(--text-muted)]">{swap.date}</p>
        </div>

        <span className="rounded-full bg-[var(--secondary)] px-3 py-1 text-xs font-bold text-[var(--secondary-ink)]">
          {t(statusLabelKey[swap.status] ?? "statusPending")}
        </span>
      </div>

      {swap.status === "confirmed" || swap.status === "awaiting_confirmation" || swap.status === "completed" ? (
        <section className="space-y-3 rounded-[var(--radius)] border border-[var(--success)] bg-[var(--surface)] p-5 shadow-[var(--shadow)]">
          <h2 className="text-lg font-bold text-[var(--text)]">{t("confirmedCalmTitle")}</h2>
          <p className="text-sm text-[var(--text-muted)]">{t("confirmedCalmBody")}</p>
          <Link
            href={`/swaps/${swap.id}/card`}
            className="inline-flex min-h-[48px] items-center justify-center rounded-[var(--radius-sm)] bg-[var(--primary-btn-bg)] px-5 text-sm font-bold text-[var(--primary-ink)]"
          >
            {t("viewSwapCardCta")}
          </Link>
        </section>
      ) : null}

      {partners.length >= 2 ? (
        <CycleSwapDiagram
          kind={swap.kind}
          youGive={swap.you_give}
          youGetLabel={swap.you_get_summary}
          others={partners.map((p) => ({
            alias: p.alias,
            trust: "verified",
            reliability: "—",
            responds_in: "—",
          }))}
        />
      ) : null}

      <section className="space-y-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow)]">
        <h2 className="text-base font-bold text-[var(--text)]">{t("participantsTitle")}</h2>
        <ul className="space-y-2">
          {swap.participants.map((p, idx) => (
            <li
              key={`${p.alias}-${idx}`}
              className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-sm)] bg-[var(--surface-2)] px-3 py-2.5"
            >
              <div>
                <p className="text-sm font-bold text-[var(--text)]">
                  {p.alias} {p.is_me ? "(You)" : ""}
                </p>
                <p
                  className="text-xs text-[var(--text-muted)]"
                  style={{ fontFamily: "var(--font-mono)" }}
                >
                  {p.gives_seat ?? `${p.gives_coach} ${p.gives_seat_type}`} ⇄{" "}
                  {p.gets_seat ?? `${p.gets_coach} ${p.gets_seat_type}`}
                </p>
              </div>
              <span className="rounded-full border border-[var(--border)] bg-[var(--surface)] px-2.5 py-0.5 text-xs font-semibold text-[var(--text)]">
                {p.decision === "accepted"
                  ? t("decisionAccepted")
                  : p.decision === "declined"
                    ? t("decisionDeclined")
                    : t("decisionPending")}
              </span>
            </li>
          ))}
        </ul>

        {swap.note ? (
          <p className="rounded-[var(--radius-sm)] bg-[var(--surface-2)] px-3 py-2 text-xs text-[var(--text)]">
            {swap.note}
          </p>
        ) : null}
      </section>

      {swap.status === "pending" ? (
        <section className="space-y-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow)]">
          <div className="flex flex-wrap gap-3">
            {swap.can_accept ? (
              <Button
                variant="primary"
                loading={acceptMutation.isPending}
                onClick={() => acceptMutation.mutate(swap.version)}
              >
                {t("acceptCta")}
              </Button>
            ) : null}

            <Button
              variant="secondary"
              loading={declineMutation.isPending}
              onClick={() => declineMutation.mutate()}
            >
              {t("declineCta")}
            </Button>

            {swap.can_cancel ? (
              <Button
                variant="ghost"
                loading={cancelMutation.isPending}
                onClick={() => cancelMutation.mutate()}
              >
                {t("cancelCta")}
              </Button>
            ) : null}
          </div>

          <input
            type="text"
            value={declineReason}
            onChange={(e) => setDeclineReason(e.target.value)}
            placeholder={t("declineReasonPlaceholder")}
            aria-label={t("declineReasonPlaceholder")}
            className="min-h-[48px] w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--text)]"
          />
        </section>
      ) : null}

      {swap.can_confirm_completion ? (
        <section className="space-y-3 rounded-[var(--radius)] border border-[var(--secondary)] bg-[var(--surface)] p-5 shadow-[var(--shadow)]">
          <h2 className="text-base font-bold text-[var(--text)]">
            {t("confirmTitle", { alias: partners[0]?.alias ?? "co-traveller" })}
          </h2>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              loading={confirmMutation.isPending}
              onClick={() => confirmMutation.mutate("yes")}
            >
              {t("confirmYesCta")}
            </Button>
            <Button
              variant="secondary"
              loading={confirmMutation.isPending}
              onClick={() => confirmMutation.mutate("no")}
            >
              {t("confirmNoCta")}
            </Button>
            <Button
              variant="ghost"
              loading={confirmMutation.isPending}
              onClick={() => confirmMutation.mutate("did_not_board")}
            >
              {t("confirmDidNotBoardCta")}
            </Button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
