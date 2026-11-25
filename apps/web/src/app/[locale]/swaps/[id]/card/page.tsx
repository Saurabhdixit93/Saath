"use client";

import { use, useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useQuery } from "@tanstack/react-query";
import { Button, EmptyState, useToast } from "@saath/ui";
import { parseProblemDetail, type SwapCardDTO } from "@saath/contracts";
import { useAuth } from "@/components/AuthProvider";
import { SwapCard } from "@/components/SwapCard";
import { publicEnv } from "@/lib/env";

const CACHE_KEY_PREFIX = "saath:swap-card:";

export default function SwapCardPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: swapId } = use(params);
  const routeLocale = useLocale() === "hi" ? "hi" : "en";
  const tCommon = useTranslations("common");
  const { authKind, ensureAuth, apiClient, accessToken } = useAuth();
  const { showToast } = useToast();

  const [cachedCard, setCachedCard] = useState<SwapCardDTO | null>(null);
  const [downloadingPng, setDownloadingPng] = useState(false);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(`${CACHE_KEY_PREFIX}${swapId}`);
      if (raw) {
        setCachedCard(JSON.parse(raw) as SwapCardDTO);
      }
    } catch {
      // ignore storage errors
    }
  }, [swapId]);

  useEffect(() => {
    if (authKind === "uninitialized") {
      void ensureAuth();
    }
  }, [authKind, ensureAuth]);

  const cardQuery = useQuery({
    queryKey: ["swap-card", swapId],
    enabled: authKind !== "uninitialized",
    retry: false,
    queryFn: async () => {
      const { data, error } = await apiClient.GET("/v1/swaps/{swap_id}/card", {
        params: { path: { swap_id: swapId }, query: { format: "json" } },
      });
      if (error || !data) {
        throw new Error(parseProblemDetail(error)?.detail || tCommon("errorBody"));
      }
      try {
        window.localStorage.setItem(`${CACHE_KEY_PREFIX}${swapId}`, JSON.stringify(data));
      } catch {
        // ignore storage errors
      }
      return data;
    },
  });

  const activeCard = cardQuery.data ?? cachedCard;
  const isOfflineFallback = !cardQuery.data && Boolean(cachedCard);

  const handleDownloadPng = async (locale: "en" | "hi") => {
    if (!activeCard) return;
    setDownloadingPng(true);
    try {
      let res = await fetch("/api/swap-cards/png", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ card: activeCard, locale }),
      });
      if (!res.ok && accessToken) {
        res = await fetch(
          `${publicEnv.NEXT_PUBLIC_API_URL}/v1/swaps/${swapId}/card?format=png`,
          {
            headers: { Authorization: `Bearer ${accessToken}` },
          }
        );
      }
      if (!res.ok) {
        throw new Error("PNG export failed");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `saath-swap-${activeCard.public_code}.png`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      showToast({
        variant: "error",
        message: err instanceof Error ? err.message : tCommon("errorBody"),
      });
    } finally {
      setDownloadingPng(false);
    }
  };

  if (!activeCard && (cardQuery.isLoading || authKind === "uninitialized")) {
    return <div className="h-64 animate-pulse rounded-[var(--radius)] bg-[var(--surface-2)]" />;
  }

  if (!activeCard) {
    return (
      <EmptyState
        title={tCommon("errorTitle")}
        description={cardQuery.error?.message || tCommon("errorBody")}
        primaryAction={
          <Button onClick={() => void cardQuery.refetch()}>{tCommon("retry")}</Button>
        }
      />
    );
  }

  return (
    <SwapCard
      card={activeCard}
      initialLocale={routeLocale}
      onDownloadPng={handleDownloadPng}
      downloadingPng={downloadingPng}
      offline={isOfflineFallback}
    />
  );
}
