"use client";

import { Suspense, useState, type FormEvent } from "react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button, EmptyState, useToast } from "@saath/ui";
import { parseProblemDetail } from "@saath/contracts";
import { Link, useRouter } from "@/i18n/navigation";
import { useAuth } from "@/components/AuthProvider";
import { parsePnrInput } from "@/lib/pnr";

function PartyJoinContent() {
  const t = useTranslations("partyJoin");
  const tHome = useTranslations("home");
  const tFlight = useTranslations("flight");
  const tCommon = useTranslations("common");
  const searchParams = useSearchParams();
  const inviteToken = searchParams.get("token") ?? "";
  const router = useRouter();
  const { ensureAuth, apiClient } = useAuth();
  const { showToast } = useToast();

  const [mode, setMode] = useState<"train" | "flight">("train");
  const [pnr, setPnr] = useState("");
  const [bcbp, setBcbp] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsUpgrade, setNeedsUpgrade] = useState(false);

  if (!inviteToken) {
    return (
      <EmptyState
        title={t("title")}
        description={t("missingToken")}
        primaryAction={
          <Link
            href="/"
            className="inline-flex min-h-[48px] items-center rounded-[var(--radius-sm)] bg-[var(--primary-btn-bg)] px-4 text-sm font-semibold text-[var(--primary-ink)]"
          >
            {tCommon("navHome")}
          </Link>
        }
      />
    );
  }

  const handleJoin = async (ev: FormEvent) => {
    ev.preventDefault();
    setError(null);
    setNeedsUpgrade(false);

    const parsedPnr = parsePnrInput(pnr);
    if (mode === "train" && (!parsedPnr.isValid || !parsedPnr.pnr)) {
      setError(tHome("pnrInvalid"));
      return;
    }

    setSubmitting(true);
    try {
      await ensureAuth();
      const { data, error: apiErr } = await apiClient.POST("/v1/party/join", {
        body:
          mode === "train"
            ? { invite_token: inviteToken, mode: "train", pnr: parsedPnr.pnr! }
            : { invite_token: inviteToken, mode: "flight", bcbp: bcbp.trim() },
      });

      if (apiErr || !data) {
        const problem = parseProblemDetail(apiErr);
        if (problem?.code === "organiser_pass_required") {
          setNeedsUpgrade(true);
        }
        setError(problem?.detail || tCommon("errorBody"));
        return;
      }

      showToast({ variant: "success", message: t("joinedToast") });
      router.push(`/journeys/${data.journey.id}`);
    } catch {
      setError(tCommon("errorBody"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h1
          className="text-2xl font-bold text-[var(--text)]"
          style={{ fontFamily: "var(--font-display)" }}
        >
          {t("title")}
        </h1>
        <p className="text-sm text-[var(--text-muted)]">{t("subtitle")}</p>
      </section>

      <div className="flex gap-2">
        <Button
          type="button"
          variant={mode === "train" ? "primary" : "ghost"}
          onClick={() => setMode("train")}
        >
          {tHome("tabTrain")}
        </Button>
        <Button
          type="button"
          variant={mode === "flight" ? "primary" : "ghost"}
          onClick={() => setMode("flight")}
        >
          {tHome("tabFlight")}
        </Button>
      </div>

      <form
        onSubmit={(ev) => void handleJoin(ev)}
        className="space-y-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow)]"
      >
        {mode === "train" ? (
          <div>
            <label
              htmlFor="join-pnr-input"
              className="mb-1.5 block text-sm font-semibold text-[var(--text)]"
            >
              {tHome("pnrLabel")}
            </label>
            <input
              id="join-pnr-input"
              type="text"
              inputMode="numeric"
              value={pnr}
              onChange={(ev) => setPnr(ev.target.value)}
              placeholder={tHome("pnrPlaceholder")}
              className="min-h-[48px] w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] px-4 text-base text-[var(--text)]"
              style={{ fontFamily: "var(--font-mono)" }}
            />
          </div>
        ) : (
          <div>
            <label
              htmlFor="join-bcbp-input"
              className="mb-1.5 block text-sm font-semibold text-[var(--text)]"
            >
              {tFlight("pasteBcbpLabel")}
            </label>
            <textarea
              id="join-bcbp-input"
              rows={3}
              value={bcbp}
              onChange={(ev) => setBcbp(ev.target.value)}
              placeholder={tFlight("pasteBcbpPlaceholder")}
              className="w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] p-3 text-xs text-[var(--text)]"
              style={{ fontFamily: "var(--font-mono)" }}
            />
          </div>
        )}

        {error ? (
          <p role="alert" className="text-sm font-medium text-[var(--danger-text)]">
            {error}
          </p>
        ) : null}

        {needsUpgrade ? (
          <div className="space-y-2 rounded-[var(--radius-sm)] border border-[var(--primary-btn-bg)] bg-[var(--surface-2)] p-4">
            <h2 className="text-sm font-bold text-[var(--text)]">{t("upgradeTitle")}</h2>
            <p className="text-xs text-[var(--text-muted)]">{t("upgradeDescription")}</p>
            <Link
              href="/pricing"
              className="inline-flex min-h-[48px] items-center rounded-[var(--radius-sm)] bg-[var(--primary-btn-bg)] px-4 text-xs font-semibold text-[var(--primary-ink)]"
            >
              {t("upgradeButton")}
            </Link>
          </div>
        ) : null}

        <Button type="submit" variant="primary" loading={submitting} fullWidth>
          {t("joinCta")}
        </Button>
      </form>
    </div>
  );
}

export default function PartyJoinPage() {
  return (
    <Suspense
      fallback={
        <div
          className="h-48 animate-pulse rounded-[var(--radius)] bg-[var(--surface-2)]"
          role="status"
          aria-busy="true"
        />
      }
    >
      <PartyJoinContent />
    </Suspense>
  );
}
