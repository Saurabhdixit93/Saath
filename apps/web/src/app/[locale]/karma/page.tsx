"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, useToast } from "@saath/ui";
import {
  parseProblemDetail,
  type KarmaBadgeDTO,
  type RewardsCatalogueResponse,
} from "@saath/contracts";
import { Link } from "@/i18n/navigation";
import { useAuth } from "@/components/AuthProvider";
import { CANONICAL_BADGE_CODES, KarmaBadge } from "@/components/KarmaBadge";

export default function KarmaPage() {
  const t = useTranslations("karma");
  const tCommon = useTranslations("common");
  const locale = useLocale() === "hi" ? "hi" : "en";
  const { authKind, user, apiClient, openOtpModal, setUser } = useAuth();
  const { showToast } = useToast();
  const queryClient = useQueryClient();

  const [seenBadges, setSeenBadges] = useState<string[] | null>(null);
  const [aliasInput, setAliasInput] = useState("");
  const [showAliasForm, setShowAliasForm] = useState(false);

  const meQuery = useQuery({
    queryKey: ["me"],
    enabled: authKind === "user",
    queryFn: async () => {
      const { data, error } = await apiClient.GET("/v1/me");
      if (error || !data) {
        throw new Error(parseProblemDetail(error)?.detail || tCommon("errorBody"));
      }
      return data;
    },
  });

  useEffect(() => {
    if (meQuery.data) {
      setUser(meQuery.data);
      setAliasInput(meQuery.data.display_alias ?? "");
    }
  }, [meQuery.data, setUser]);

  const karmaQuery = useQuery({
    queryKey: ["karma"],
    enabled: authKind === "user",
    queryFn: async () => {
      const { data, error } = await apiClient.GET("/v1/karma");
      if (error || !data) {
        throw new Error(parseProblemDetail(error)?.detail || tCommon("errorBody"));
      }
      return data;
    },
  });

  const rewardsQuery = useQuery({
    queryKey: ["karma-rewards"],
    enabled: authKind === "user",
    retry: false,
    queryFn: async (): Promise<RewardsCatalogueResponse> => {
      const { data, error, response } = await apiClient.GET("/v1/karma/rewards");
      if (response?.status === 403) {
        return { enabled: false, items: [], redemptions: [] };
      }
      if (error || !data) {
        const problem = parseProblemDetail(error);
        if (problem?.status === 403 || problem?.code === "rewards_disabled") {
          return { enabled: false, items: [], redemptions: [] };
        }
        throw new Error(problem?.detail || tCommon("errorBody"));
      }
      return data;
    },
  });

  const activeUserId = meQuery.data?.id ?? user?.id ?? null;

  useEffect(() => {
    if (!activeUserId || !karmaQuery.data?.badges) return;
    const storageKey = `saath_seen_badges_${activeUserId}`;
    try {
      const raw = window.localStorage.getItem(storageKey);
      const parsed = raw ? (JSON.parse(raw) as unknown) : [];
      const prior = Array.isArray(parsed) ? parsed.map(String) : [];
      setSeenBadges(prior);
      const currentCodes = karmaQuery.data.badges.map((b) => b.code);
      const merged = Array.from(new Set([...prior, ...currentCodes]));
      window.localStorage.setItem(storageKey, JSON.stringify(merged));
    } catch {
      // Storage may be unavailable in restricted contexts
    }
  }, [activeUserId, karmaQuery.data?.badges]);

  const optInMutation = useMutation({
    mutationFn: async (args: { optIn: boolean; alias?: string | null }) => {
      const body: { leaderboard_opt_in: boolean; display_alias?: string | null } = {
        leaderboard_opt_in: args.optIn,
      };
      if (args.alias !== undefined) {
        body.display_alias = args.alias;
      }
      const { data, error } = await apiClient.PATCH("/v1/me", { body });
      if (error || !data) {
        throw new Error(parseProblemDetail(error)?.detail || tCommon("errorBody"));
      }
      return data;
    },
    onSuccess: async (updated) => {
      setUser(updated);
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      await queryClient.invalidateQueries({ queryKey: ["karma"] });
      setShowAliasForm(false);
      showToast({ variant: "success", message: t("leaderboardOptInUpdated") });
    },
    onError: (err) => {
      showToast({ variant: "error", message: err.message });
    },
  });

  const redeemMutation = useMutation({
    mutationFn: async (rewardCode: string) => {
      const { data, error } = await apiClient.POST("/v1/karma/rewards/redeem", {
        body: { reward_code: rewardCode },
      });
      if (error || !data) {
        throw new Error(parseProblemDetail(error)?.detail || tCommon("errorBody"));
      }
      return data;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["karma"] });
      await queryClient.invalidateQueries({ queryKey: ["karma-rewards"] });
      showToast({ variant: "success", message: t("rewardsRedeemedToast") });
    },
    onError: (err) => {
      showToast({ variant: "error", message: err.message });
    },
  });

  const badgeByCode = useMemo(() => {
    const map = new Map<string, KarmaBadgeDTO>();
    for (const b of karmaQuery.data?.badges ?? []) {
      map.set(b.code, b);
    }
    return map;
  }, [karmaQuery.data?.badges]);

  const allBadgeCodes = useMemo(() => {
    const extras = (karmaQuery.data?.badges ?? [])
      .map((b) => b.code)
      .filter((code) => !(CANONICAL_BADGE_CODES as readonly string[]).includes(code));
    return [...CANONICAL_BADGE_CODES, ...extras];
  }, [karmaQuery.data?.badges]);

  const leaderboardOptIn = meQuery.data?.leaderboard_opt_in ?? user?.leaderboard_opt_in ?? false;
  const currentAlias = meQuery.data?.display_alias ?? user?.display_alias ?? "";

  const handleToggleLeaderboard = () => {
    const next = !leaderboardOptIn;
    if (next && !currentAlias.trim()) {
      setShowAliasForm(true);
    }
    optInMutation.mutate({ optIn: next });
  };

  const handleSaveAlias = (ev: FormEvent) => {
    ev.preventDefault();
    optInMutation.mutate({
      optIn: true,
      alias: aliasInput.trim() || null,
    });
  };

  const formatDate = (iso: string) =>
    new Intl.DateTimeFormat("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    }).format(new Date(iso));

  const resolveReasonLabel = (reason: string) => {
    const map: Record<string, string> = {
      swap_confirmed_pending: t("reason_swap_confirmed_pending"),
      swap_completed: t("reason_swap_completed"),
      "dispute:no": t("reason_dispute_no"),
      "dispute:did_not_board": t("reason_dispute_did_not_board"),
      swap_disputed: t("reason_swap_disputed"),
    };
    return map[reason] ?? reason;
  };

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1
            className="text-2xl font-bold text-[var(--text)]"
            style={{ fontFamily: "var(--font-display)" }}
          >
            {t("title")}
          </h1>
          <p className="text-sm text-[var(--text-muted)]">{t("subtitle")}</p>
        </div>
        {authKind === "user" ? (
          <Link
            href="/profile"
            className="inline-flex min-h-[48px] items-center rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-4 text-sm font-semibold text-[var(--text)] hover:bg-[var(--surface-2)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]"
          >
            {t("profileLinkCta")}
          </Link>
        ) : null}
      </header>

      {authKind !== "user" ? (
        <section className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-6 text-center shadow-[var(--shadow)]">
          <h2
            className="text-lg font-bold text-[var(--text)]"
            style={{ fontFamily: "var(--font-display)" }}
          >
            {t("anonTitle")}
          </h2>
          <p className="mx-auto mt-1.5 max-w-md text-sm text-[var(--text-muted)]">
            {t("anonDescription")}
          </p>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
            <Button variant="primary" onClick={openOtpModal}>
              {t("anonVerifyCta")}
            </Button>
          </div>
        </section>
      ) : karmaQuery.isLoading ? (
        <section
          role="status"
          aria-live="polite"
          className="space-y-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow)]"
        >
          <p className="text-sm font-medium text-[var(--text-muted)]">
            {t("loadingWallet")}
          </p>
          <div className="h-10 w-36 animate-pulse rounded bg-[var(--surface-2)]" />
          <div className="h-20 w-full animate-pulse rounded-[var(--radius-sm)] bg-[var(--surface-2)]" />
        </section>
      ) : karmaQuery.isError || !karmaQuery.data ? (
        <section className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-6 text-center shadow-[var(--shadow)]">
          <h2
            className="text-lg font-bold text-[var(--text)]"
            style={{ fontFamily: "var(--font-display)" }}
          >
            {t("loadErrorTitle")}
          </h2>
          <p className="mx-auto mt-1.5 max-w-md text-sm text-[var(--text-muted)]">
            {karmaQuery.error?.message || t("loadErrorDescription")}
          </p>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
            <Button variant="primary" onClick={() => void karmaQuery.refetch()}>
              {tCommon("retry")}
            </Button>
          </div>
        </section>
      ) : (
        <div className="space-y-6">
          {/* Wallet Summary */}
          <section className="grid grid-cols-1 gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow)] sm:grid-cols-3">
            <div>
              <p className="text-xs font-semibold text-[var(--text-muted)]">
                {t("balanceLabel")}
              </p>
              <p
                className="mt-1 text-3xl font-extrabold text-[var(--primary-text)]"
                style={{ fontFamily: "var(--font-mono)" }}
              >
                {t("pointsUnit", { points: karmaQuery.data.balance })}
              </p>
            </div>
            <div>
              <p className="text-xs font-semibold text-[var(--text-muted)]">
                {t("pendingLabel")}
              </p>
              <p
                className="mt-1 text-xl font-bold text-[var(--secondary)]"
                style={{ fontFamily: "var(--font-mono)" }}
              >
                {t("pointsUnit", { points: karmaQuery.data.pending })}
              </p>
            </div>
            <div>
              <p className="text-xs font-semibold text-[var(--text-muted)]">
                {t("availableLabel")}
              </p>
              <p
                className="mt-1 text-xl font-bold text-[var(--text)]"
                style={{ fontFamily: "var(--font-mono)" }}
              >
                {t("pointsUnit", { points: karmaQuery.data.available_balance })}
              </p>
            </div>
          </section>

          {/* Badges */}
          <section className="space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2
                className="text-lg font-bold text-[var(--text)]"
                style={{ fontFamily: "var(--font-display)" }}
              >
                {t("badgesTitle")}
              </h2>
              <p
                className="text-xs font-semibold text-[var(--text-muted)]"
                style={{ fontFamily: "var(--font-mono)" }}
              >
                {t("badgesSummary", {
                  earned: karmaQuery.data.badges.length,
                  total: allBadgeCodes.length,
                })}
              </p>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {allBadgeCodes.map((code) => {
                const earned = badgeByCode.get(code);
                const newlyUnlocked = Boolean(
                  earned &&
                    seenBadges !== null &&
                    !seenBadges.includes(code)
                );
                return (
                  <KarmaBadge
                    key={code}
                    code={code}
                    title={earned?.title}
                    description={earned?.description}
                    earnedAt={earned?.earned_at ?? null}
                    newlyUnlocked={newlyUnlocked}
                  />
                );
              })}
            </div>
          </section>

          {/* Pseudonymous Opt-In Leaderboard */}
          <section className="space-y-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow)]">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="space-y-1">
                <h2
                  className="text-lg font-bold text-[var(--text)]"
                  style={{ fontFamily: "var(--font-display)" }}
                >
                  {t("leaderboardTitle")}
                </h2>
                <p className="text-xs text-[var(--text-muted)]">
                  {t("leaderboardSubtitle")}
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={leaderboardOptIn}
                disabled={optInMutation.isPending}
                onClick={handleToggleLeaderboard}
                className={`inline-flex min-h-[48px] min-w-[48px] items-center gap-2 rounded-[var(--radius-sm)] border px-4 text-sm font-bold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)] ${
                  leaderboardOptIn
                    ? "border-[var(--success)] bg-[var(--success-btn-bg)] text-[var(--success-ink)]"
                    : "border-[var(--border)] bg-[var(--surface-2)] text-[var(--text)]"
                }`}
              >
                <span>{t("leaderboardOptInSwitch")}</span>
                <span style={{ fontFamily: "var(--font-mono)" }}>
                  {leaderboardOptIn ? "ON" : "OFF"}
                </span>
              </button>
            </div>

            {showAliasForm || (leaderboardOptIn && !currentAlias.trim()) ? (
              <form
                onSubmit={handleSaveAlias}
                className="flex flex-wrap items-end gap-2 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] p-3"
              >
                <div className="min-w-[200px] flex-1">
                  <label
                    htmlFor="karma-leaderboard-alias"
                    className="mb-1 block text-xs font-semibold text-[var(--text)]"
                  >
                    {t("leaderboardAliasLabel")}
                  </label>
                  <input
                    id="karma-leaderboard-alias"
                    type="text"
                    maxLength={40}
                    value={aliasInput}
                    onChange={(ev) => setAliasInput(ev.target.value)}
                    placeholder={t("leaderboardAliasPlaceholder")}
                    className="min-h-[48px] w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]"
                  />
                </div>
                <Button type="submit" loading={optInMutation.isPending}>
                  {t("leaderboardSaveAliasCta")}
                </Button>
              </form>
            ) : null}

            {karmaQuery.data.leaderboard.length === 0 ? (
              <p className="text-sm text-[var(--text-muted)]">
                {t("leaderboardEmpty")}
              </p>
            ) : (
              <ol className="space-y-2">
                {karmaQuery.data.leaderboard.map((entry) => (
                  <li
                    key={`${entry.rank}-${entry.display_alias}`}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] px-3.5 py-2.5"
                  >
                    <div className="flex items-center gap-3">
                      <span
                        className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-[var(--surface-2)] text-xs font-bold text-[var(--text)]"
                        style={{ fontFamily: "var(--font-mono)" }}
                      >
                        #{entry.rank}
                      </span>
                      <div>
                        <p className="text-sm font-bold text-[var(--text)]">
                          {entry.display_alias}
                        </p>
                        <p
                          className="text-xs text-[var(--text-muted)]"
                          style={{ fontFamily: "var(--font-mono)" }}
                        >
                          {t("leaderboardSwapsCount", {
                            count: entry.swaps_completed,
                          })}
                        </p>
                      </div>
                    </div>
                    <span
                      className="text-sm font-extrabold text-[var(--primary-text)]"
                      style={{ fontFamily: "var(--font-mono)" }}
                    >
                      {t("pointsUnit", { points: entry.points })}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </section>

          {/* Ledger History */}
          <section className="space-y-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow)]">
            <h2
              className="text-lg font-bold text-[var(--text)]"
              style={{ fontFamily: "var(--font-display)" }}
            >
              {t("historyTitle")}
            </h2>
            {karmaQuery.data.history.length === 0 ? (
              <p className="text-sm text-[var(--text-muted)]">{t("historyEmpty")}</p>
            ) : (
              <ul className="space-y-2.5">
                {karmaQuery.data.history.map((row) => {
                  const stateLabel =
                    row.state === "credited"
                      ? t("stateCredited")
                      : row.state === "reversed"
                        ? t("stateReversed")
                        : t("statePending");
                  const statePillClass =
                    row.state === "credited"
                      ? "bg-[var(--success-btn-bg)] text-[var(--success-ink)]"
                      : row.state === "reversed"
                        ? "bg-[var(--danger)] text-[var(--danger-ink)]"
                        : "border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text)]";
                  const deltaDisplay =
                    row.delta >= 0 ? `+${row.delta}` : `${row.delta}`;

                  return (
                    <li
                      key={row.id}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] p-3.5"
                    >
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-bold ${statePillClass}`}
                          >
                            {stateLabel}
                          </span>
                          <span
                            className="text-xs text-[var(--text-muted)]"
                            style={{ fontFamily: "var(--font-mono)" }}
                          >
                            {formatDate(row.created_at)}
                          </span>
                        </div>
                        <p className="text-sm font-medium text-[var(--text)]">
                          {resolveReasonLabel(row.reason)}
                        </p>
                      </div>
                      <span
                        className="text-base font-extrabold text-[var(--text)]"
                        style={{ fontFamily: "var(--font-mono)" }}
                      >
                        {deltaDisplay}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* Feature-Flagged Rewards Catalogue (v1.1) */}
          <section className="space-y-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow)]">
            <h2
              className="text-lg font-bold text-[var(--text)]"
              style={{ fontFamily: "var(--font-display)" }}
            >
              {t("rewardsTitle")}
            </h2>
            {!rewardsQuery.data?.enabled ? (
              <div className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] p-4">
                <p className="text-sm font-bold text-[var(--text)]">
                  {t("rewardsDisabledTitle")}
                </p>
                <p className="mt-1 text-xs text-[var(--text-muted)]">
                  {t("rewardsDisabledBody")}
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {rewardsQuery.data.items.map((item) => {
                    const outOfStock = item.stock !== null && item.stock !== undefined && item.stock <= 0;
                    const canAfford = karmaQuery.data.available_balance >= item.cost_points;
                    return (
                      <article
                        key={item.code}
                        className="flex flex-col justify-between gap-3 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] p-4"
                      >
                        <div className="space-y-1">
                          <h3 className="text-sm font-bold text-[var(--text)]">
                            {locale === "hi" ? item.title_hi : item.title_en}
                          </h3>
                          {(locale === "hi" ? item.description_hi : item.description_en) ? (
                            <p className="text-xs text-[var(--text-muted)]">
                              {locale === "hi" ? item.description_hi : item.description_en}
                            </p>
                          ) : null}
                          <p
                            className="pt-1 text-xs font-semibold text-[var(--secondary)]"
                            style={{ fontFamily: "var(--font-mono)" }}
                          >
                            {t("rewardsCost", { cost: item.cost_points })} ·{" "}
                            {item.stock === null || item.stock === undefined
                              ? t("rewardsUnlimited")
                              : t("rewardsStock", { count: item.stock })}
                          </p>
                        </div>
                        <Button
                          variant="primary"
                          disabled={outOfStock || !canAfford}
                          loading={
                            redeemMutation.isPending &&
                            redeemMutation.variables === item.code
                          }
                          onClick={() => redeemMutation.mutate(item.code)}
                        >
                          {outOfStock ? t("rewardsOutOfStock") : t("rewardsRedeemCta")}
                        </Button>
                      </article>
                    );
                  })}
                </div>

                {rewardsQuery.data.redemptions.length > 0 ? (
                  <div className="space-y-2">
                    <h3 className="text-sm font-bold text-[var(--text)]">
                      {t("rewardsMyRedemptionsTitle")}
                    </h3>
                    <ul className="space-y-2">
                      {rewardsQuery.data.redemptions.map((red) => (
                        <li
                          key={red.id}
                          className="flex items-center justify-between rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-xs"
                        >
                          <span className="font-semibold text-[var(--text)]">
                            {red.reward_code}
                          </span>
                          <span
                            className="font-mono text-[var(--text-muted)]"
                            style={{ fontFamily: "var(--font-mono)" }}
                          >
                            -{red.points_spent} · {red.status}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
