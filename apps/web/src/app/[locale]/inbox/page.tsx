"use client";

import { useEffect } from "react";
import { useTranslations } from "next-intl";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, EmptyState, useToast } from "@saath/ui";
import { parseProblemDetail, type SwapDetailDTO } from "@saath/contracts";
import { Link } from "@/i18n/navigation";
import { useAuth } from "@/components/AuthProvider";

export default function InboxPage() {
  const t = useTranslations("inbox");
  const tSwaps = useTranslations("swaps");
  const tCommon = useTranslations("common");
  const queryClient = useQueryClient();
  const { authKind, ensureAuth, apiClient } = useAuth();
  const { showToast } = useToast();

  useEffect(() => {
    if (authKind === "uninitialized") {
      void ensureAuth();
    }
  }, [authKind, ensureAuth]);

  const swapsQuery = useQuery({
    queryKey: ["swaps", "all"],
    enabled: authKind !== "uninitialized",
    queryFn: async () => {
      const { data, error } = await apiClient.GET("/v1/swaps", {
        params: { query: { state: "all" } },
      });
      if (error || !data) {
        throw new Error(parseProblemDetail(error)?.detail || tCommon("errorBody"));
      }
      return data;
    },
  });

  const conversationsQuery = useQuery({
    queryKey: ["conversations"],
    enabled: authKind === "user",
    queryFn: async () => {
      const { data, error } = await apiClient.GET("/v1/conversations");
      if (error || !data) {
        throw new Error(parseProblemDetail(error)?.detail || tCommon("errorBody"));
      }
      return data;
    },
  });

  const confirmMutation = useMutation({
    mutationFn: async (args: {
      swapId: string;
      answer: "yes" | "no" | "did_not_board";
    }) => {
      const { data, error } = await apiClient.POST(
        "/v1/swaps/{swap_id}/confirm-completion",
        {
          params: { path: { swap_id: args.swapId } },
          body: { answer: args.answer },
        }
      );
      if (error || !data) {
        throw new Error(parseProblemDetail(error)?.detail || tCommon("errorBody"));
      }
      return { updated: data, answer: args.answer };
    },
    onSuccess: async ({ answer }) => {
      await queryClient.invalidateQueries({ queryKey: ["swaps"] });
      await queryClient.invalidateQueries({ queryKey: ["karma"] });
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      showToast({
        variant: answer === "yes" ? "success" : "info",
        message: answer === "yes" ? tSwaps("confirmThanks") : tSwaps("confirmDisputed"),
      });
    },
    onError: (err) => {
      showToast({ variant: "error", message: err.message });
    },
  });

  if (
    swapsQuery.isLoading ||
    (authKind === "user" && conversationsQuery.isLoading) ||
    authKind === "uninitialized"
  ) {
    return <div className="h-48 animate-pulse rounded-[var(--radius)] bg-[var(--surface-2)]" />;
  }

  const allSwaps = swapsQuery.data?.items ?? [];
  const conversations = conversationsQuery.data?.items ?? [];
  const confirmable = allSwaps.filter((s) => s.can_confirm_completion);
  const activeSwaps = allSwaps.filter((s) =>
    ["pending", "confirmed", "awaiting_confirmation"].includes(s.status)
  );
  const pastSwaps = allSwaps.filter(
    (s) => !["pending", "confirmed", "awaiting_confirmation"].includes(s.status)
  );

  if (allSwaps.length === 0 && conversations.length === 0) {
    return (
      <EmptyState
        title={t("emptyTitle")}
        description={t("emptyDescription")}
        primaryAction={
          <Link
            href="/journeys"
            className="inline-flex min-h-[48px] items-center justify-center rounded-[var(--radius-sm)] bg-[var(--primary-btn-bg)] px-5 text-sm font-bold text-[var(--primary-ink)]"
          >
            {t("emptyCta")}
          </Link>
        }
      />
    );
  }

  const renderSwapRow = (swap: SwapDetailDTO) => (
    <li
      key={swap.id}
      className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--shadow)]"
    >
      <div className="space-y-1">
        <p
          className="text-sm font-bold text-[var(--text)]"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          {swap.service} · {swap.date}
        </p>
        <p className="text-xs text-[var(--text-muted)]">
          {swap.you_give} ⇄ {swap.you_get_summary} · {swap.status}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Link
          href={`/swaps/${swap.id}`}
          className="inline-flex min-h-[48px] items-center rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-4 text-xs font-bold text-[var(--text)]"
        >
          {t("openSwapCta")}
        </Link>
        {swap.swap_card_code ? (
          <Link
            href={`/swaps/${swap.id}/card`}
            className="inline-flex min-h-[48px] items-center rounded-[var(--radius-sm)] bg-[var(--secondary)] px-4 text-xs font-bold text-[var(--secondary-ink)]"
          >
            {t("openCardCta")}
          </Link>
        ) : null}
      </div>
    </li>
  );

  return (
    <div className="space-y-6">
      <div>
        <h1
          className="text-2xl font-extrabold text-[var(--text)]"
          style={{ fontFamily: "var(--font-display)" }}
        >
          {t("title")}
        </h1>
        <p className="text-sm text-[var(--text-muted)]">{t("subtitle")}</p>
      </div>

      {confirmable.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-base font-bold text-[var(--text)]">
            {t("confirmSectionTitle")}
          </h2>
          {confirmable.map((swap) => {
            const partnerAlias =
              swap.participants.find((p) => !p.is_me)?.alias ?? "co-traveller";
            return (
              <div
                key={swap.id}
                className="space-y-3 rounded-[var(--radius)] border border-[var(--secondary)] bg-[var(--surface)] p-4 shadow-[var(--shadow)]"
              >
                <p className="text-sm font-bold text-[var(--text)]">
                  {tSwaps("confirmTitle", { alias: partnerAlias })}
                </p>
                <p
                  className="text-xs text-[var(--text-muted)]"
                  style={{ fontFamily: "var(--font-mono)" }}
                >
                  {swap.service} · {swap.you_give}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="primary"
                    loading={confirmMutation.isPending}
                    onClick={() =>
                      confirmMutation.mutate({ swapId: swap.id, answer: "yes" })
                    }
                  >
                    {tSwaps("confirmYesCta")}
                  </Button>
                  <Button
                    variant="secondary"
                    loading={confirmMutation.isPending}
                    onClick={() =>
                      confirmMutation.mutate({ swapId: swap.id, answer: "no" })
                    }
                  >
                    {tSwaps("confirmNoCta")}
                  </Button>
                  <Button
                    variant="ghost"
                    loading={confirmMutation.isPending}
                    onClick={() =>
                      confirmMutation.mutate({
                        swapId: swap.id,
                        answer: "did_not_board",
                      })
                    }
                  >
                    {tSwaps("confirmDidNotBoardCta")}
                  </Button>
                </div>
              </div>
            );
          })}
        </section>
      ) : null}

      {conversations.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-base font-bold text-[var(--text)]">
            {t("conversationsTitle")}
          </h2>
          <ul className="space-y-3">
            {conversations.map((convo) => (
              <li
                key={convo.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--shadow)]"
              >
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-bold text-[var(--text)]">
                      {convo.partner_alias}
                    </p>
                    <span className="rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-0.5 text-[11px] font-semibold text-[var(--secondary)]">
                      {convo.unmasked ? t("unmaskedPill") : t("maskedPill")}
                    </span>
                  </div>
                  <p
                    className="text-xs text-[var(--text-muted)]"
                    style={{ fontFamily: "var(--font-mono)" }}
                  >
                    {convo.service} · {convo.date}
                  </p>
                  {convo.last_message ? (
                    <p className="line-clamp-1 text-xs text-[var(--text-muted)]">
                      {convo.last_message.body}
                    </p>
                  ) : null}
                </div>
                <Link
                  href={`/inbox/${convo.id}`}
                  className="inline-flex min-h-[48px] items-center rounded-[var(--radius-sm)] bg-[var(--primary-btn-bg)] px-4 text-xs font-bold text-[var(--primary-ink)]"
                >
                  {t("openChatCta")}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {activeSwaps.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-base font-bold text-[var(--text)]">
            {t("activeSwapsTitle")}
          </h2>
          <ul className="space-y-3">{activeSwaps.map(renderSwapRow)}</ul>
        </section>
      ) : null}

      {pastSwaps.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-base font-bold text-[var(--text)]">
            {t("pastSwapsTitle")}
          </h2>
          <ul className="space-y-3">{pastSwaps.map(renderSwapRow)}</ul>
        </section>
      ) : null}
    </div>
  );
}
