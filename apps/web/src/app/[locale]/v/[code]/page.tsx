"use client";

import { use } from "react";
import { useTranslations } from "next-intl";
import { useQuery } from "@tanstack/react-query";
import { EmptyState } from "@saath/ui";
import { createSaathClient, parseProblemDetail } from "@saath/contracts";
import { publicEnv } from "@/lib/env";

const publicClient = createSaathClient({
  baseUrl: publicEnv.NEXT_PUBLIC_API_URL,
  getAccessToken: () => null,
});

export default function PublicVerifySwapCardPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = use(params);
  const t = useTranslations("swaps");

  const query = useQuery({
    queryKey: ["public-swap-card", code],
    retry: false,
    queryFn: async () => {
      const { data, error } = await publicClient.GET("/v1/public/swap-cards/{code}", {
        params: { path: { code } },
      });
      if (error || !data) {
        const problem = parseProblemDetail(error);
        throw new Error(problem?.detail || t("verifyNotFoundBody"));
      }
      return data;
    },
  });

  if (query.isLoading) {
    return <div className="h-44 animate-pulse rounded-[var(--radius)] bg-[var(--surface-2)]" />;
  }

  if (query.isError || !query.data) {
    return (
      <EmptyState
        title={t("verifyNotFoundTitle")}
        description={query.error?.message || t("verifyNotFoundBody")}
      />
    );
  }

  const card = query.data;

  return (
    <section className="space-y-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-6 shadow-[var(--shadow)]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1
            className="text-xl font-extrabold text-[var(--text)]"
            style={{ fontFamily: "var(--font-display)" }}
          >
            {t("verifyPageTitle")}
          </h1>
          <p
            className="text-base font-bold text-[var(--secondary)]"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            #{card.public_code}
          </p>
        </div>

        <span
          className={`rounded-full px-3.5 py-1 text-xs font-bold ${
            card.valid && !card.revoked
              ? "bg-[var(--success-btn-bg)] text-[var(--success-ink)]"
              : "bg-[var(--danger)] text-[var(--danger-ink)]"
          }`}
        >
          {card.valid && !card.revoked
            ? `✓ ${t("verifyValidBadge")}`
            : t("verifyRevokedBadge")}
        </span>
      </div>

      <div className="grid gap-3 rounded-[var(--radius-sm)] bg-[var(--surface-2)] p-4 sm:grid-cols-2">
        <div>
          <p className="text-xs text-[var(--text-muted)]">{t("verifyServiceLabel")}</p>
          <p
            className="text-sm font-bold text-[var(--text)]"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            {card.service} · {card.date}
          </p>
        </div>
        <div>
          <p className="text-xs text-[var(--text-muted)]">{t("verifySeatsLabel")}</p>
          <p
            className="text-sm font-bold text-[var(--text)]"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            {card.seats}
          </p>
        </div>
      </div>

      <p className="text-xs text-[var(--text-muted)]">{t("verifyZeroPiiNote")}</p>
    </section>
  );
}
