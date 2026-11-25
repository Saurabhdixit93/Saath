"use client";

import { useEffect } from "react";
import { useTranslations } from "next-intl";
import { useQuery } from "@tanstack/react-query";
import { Button, EmptyState } from "@saath/ui";
import { parseProblemDetail } from "@saath/contracts";
import { Link } from "@/i18n/navigation";
import { useAuth } from "@/components/AuthProvider";

export default function JourneysListPage() {
  const t = useTranslations("journeys");
  const tCommon = useTranslations("common");
  const { authKind, ensureAuth, apiClient } = useAuth();

  useEffect(() => {
    if (authKind === "uninitialized") {
      void ensureAuth();
    }
  }, [authKind, ensureAuth]);

  const journeysQuery = useQuery({
    queryKey: ["journeys"],
    enabled: authKind !== "uninitialized",
    queryFn: async () => {
      const { data, error } = await apiClient.GET("/v1/journeys");
      if (error || !data) {
        throw new Error(parseProblemDetail(error)?.detail || tCommon("errorBody"));
      }
      return data;
    },
  });

  const trustLabel = (tier: string) => {
    if (tier === "verified_provider") return t("trustVerifiedProvider");
    if (tier === "verified_bcbp") return t("trustVerifiedBcbp");
    if (tier === "verified_doc") return t("trustVerifiedDoc");
    return t("trustDeclared");
  };

  return (
    <div className="space-y-6">
      <h1
        className="text-2xl font-bold text-[var(--text)]"
        style={{ fontFamily: "var(--font-display)" }}
      >
        {t("listTitle")}
      </h1>

      {journeysQuery.isLoading || authKind === "uninitialized" ? (
        <div className="space-y-3" role="status">
          <div className="h-24 animate-pulse rounded-[var(--radius)] bg-[var(--surface-2)]" />
          <div className="h-24 animate-pulse rounded-[var(--radius)] bg-[var(--surface-2)]" />
        </div>
      ) : journeysQuery.isError ? (
        <EmptyState
          title={tCommon("errorTitle")}
          description={journeysQuery.error.message}
          primaryAction={
            <Button onClick={() => void journeysQuery.refetch()}>
              {tCommon("retry")}
            </Button>
          }
        />
      ) : journeysQuery.data?.items.length === 0 ? (
        <EmptyState
          title={t("emptyTitle")}
          description={t("emptyDescription")}
          primaryAction={
            <Link
              href="/"
              className="inline-flex min-h-[48px] items-center rounded-[var(--radius-sm)] bg-[var(--primary-btn-bg)] px-5 text-sm font-semibold text-[var(--primary-ink)]"
            >
              {t("emptyCta")}
            </Link>
          }
        />
      ) : (
        <div className="space-y-3">
          {journeysQuery.data?.items.map((item) => (
            <article
              key={item.booking.id}
              className="flex flex-wrap items-center justify-between gap-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--shadow)]"
            >
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className="text-base font-bold text-[var(--text)]"
                    style={{ fontFamily: "var(--font-mono)" }}
                  >
                    {item.journey.service_no}
                  </span>
                  <span className="rounded-full border border-[var(--secondary)] bg-[var(--surface-2)] px-2.5 py-0.5 text-xs font-semibold text-[var(--secondary)]">
                    {trustLabel(item.booking.trust_tier)}
                  </span>
                </div>
                <p className="text-xs text-[var(--text-muted)]">
                  {item.booking.from_code ?? ""} → {item.booking.to_code ?? ""} ·{" "}
                  {item.journey.service_date} ·{" "}
                  {t("memberCount", { count: item.member_count })}
                </p>
              </div>

              <Link
                href={`/journeys/${item.journey.id}`}
                className="inline-flex min-h-[48px] items-center rounded-[var(--radius-sm)] bg-[var(--primary-btn-bg)] px-4 text-sm font-semibold text-[var(--primary-ink)] hover:opacity-95"
              >
                {t("openHubCta")}
              </Link>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
