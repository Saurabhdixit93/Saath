"use client";

import { useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { Button, EmptyState, useToast } from "@saath/ui";
import { parseProblemDetail, type PublicSeatInviteResponse } from "@saath/contracts";
import { Link, useRouter } from "@/i18n/navigation";
import { useAuth } from "@/components/AuthProvider";
import { parsePnrInput } from "@/lib/pnr";

export function InviteLandingClient({
  token,
  invite,
}: {
  token: string;
  invite: PublicSeatInviteResponse | null;
}) {
  const t = useTranslations("invite");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const { ensureAuth, apiClient } = useAuth();
  const { showToast } = useToast();

  const [pnrText, setPnrText] = useState("");
  const [openToHelp, setOpenToHelp] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  if (!invite) {
    return (
      <div className="mx-auto max-w-xl py-4">
        <EmptyState
          title={t("expiredTitle")}
          description={t("expiredBody")}
          primaryAction={
            <Link
              href="/"
              className="inline-flex min-h-[48px] items-center justify-center rounded-[var(--radius-sm)] bg-[var(--primary-btn-bg)] px-5 text-sm font-bold text-[var(--primary-ink)] hover:opacity-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]"
            >
              {t("expiredHomeCta")}
            </Link>
          }
        />
      </div>
    );
  }

  const handleSubmit = async (ev: FormEvent) => {
    ev.preventDefault();
    setErrorMsg(null);

    const parsed = parsePnrInput(pnrText);
    if (!parsed.isValid || !parsed.pnr) {
      setErrorMsg(t("pnrInvalid"));
      return;
    }

    setSubmitting(true);
    try {
      await ensureAuth();
      const { data, error } = await apiClient.POST("/v1/journeys/verify", {
        body: {
          mode: "train",
          pnr: parsed.pnr,
          invite_token: token,
          open_to_help: openToHelp,
        },
      });
      if (error || !data) {
        const problem = parseProblemDetail(error);
        setErrorMsg(problem?.detail || tCommon("errorBody"));
        return;
      }
      showToast({ variant: "success", message: tCommon("brand") });
      router.push(`/journeys/${data.journey.id}`);
    } catch {
      setErrorMsg(tCommon("errorBody"));
    } finally {
      setSubmitting(false);
    }
  };

  const targetBanner =
    invite.target_coach && invite.target_seat_no
      ? t("targetSeatBanner", {
          coach: invite.target_coach,
          seat: invite.target_seat_no,
        })
      : invite.target_coach
        ? t("targetCoachBanner", { coach: invite.target_coach })
        : null;

  return (
    <div className="mx-auto max-w-xl space-y-5">
      <section className="space-y-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-6 shadow-[var(--shadow)]">
        <div className="space-y-2">
          {targetBanner ? (
            <span
              className="inline-flex items-center rounded-full border border-[var(--secondary)] bg-[var(--surface-2)] px-3 py-1 text-xs font-bold text-[var(--secondary)]"
              style={{ fontFamily: "var(--font-mono)" }}
            >
              {targetBanner}
            </span>
          ) : null}
          <h1
            className="text-2xl font-extrabold text-[var(--text)]"
            style={{ fontFamily: "var(--font-display)" }}
          >
            {t("title")}
          </h1>
          <p className="text-sm text-[var(--text-muted)]">
            {t("subtitle", {
              serviceNo: invite.service_no,
              date: invite.service_date,
            })}
          </p>
          {(invite.conversions_count ?? 0) > 0 ? (
            <p className="text-xs font-semibold text-[var(--secondary)]">
              {t("conversionsNote", { count: invite.conversions_count ?? 0 })}
            </p>
          ) : null}
        </div>

        <form onSubmit={(ev) => void handleSubmit(ev)} className="space-y-4" noValidate>
          <div>
            <label
              htmlFor="invite-pnr-input"
              className="mb-1.5 block text-sm font-semibold text-[var(--text)]"
            >
              {t("pnrInputLabel")}
            </label>
            <input
              id="invite-pnr-input"
              type="text"
              inputMode="numeric"
              value={pnrText}
              onChange={(ev) => {
                setPnrText(ev.target.value);
                setErrorMsg(null);
              }}
              placeholder={t("pnrPlaceholder")}
              className="min-h-[48px] w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] px-4 text-base tracking-wider text-[var(--text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]"
              style={{ fontFamily: "var(--font-mono)" }}
            />
          </div>

          <label
            htmlFor="invite-open-to-help"
            className="flex min-h-[48px] cursor-pointer items-start gap-3 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] p-3"
          >
            <input
              id="invite-open-to-help"
              type="checkbox"
              checked={openToHelp}
              onChange={(ev) => setOpenToHelp(ev.target.checked)}
              className="mt-0.5 h-6 w-6 shrink-0 accent-[var(--primary)]"
            />
            <span className="space-y-0.5">
              <span className="block text-sm font-bold text-[var(--text)]">
                {t("openToHelpLabel")}
              </span>
              <span className="block text-xs text-[var(--text-muted)]">
                {t("openToHelpHint")}
              </span>
            </span>
          </label>

          {errorMsg ? (
            <p role="alert" className="text-sm font-medium text-[var(--danger-text)]">
              {errorMsg}
            </p>
          ) : null}

          <Button type="submit" variant="primary" loading={submitting} fullWidth>
            {submitting ? t("verifyingCta") : t("verifyJoinCta")}
          </Button>
        </form>

        {invite.mode === "flight" ? (
          <p className="text-xs text-[var(--text-muted)]">
            {t("flightScanHint", { serviceNo: invite.service_no })}{" "}
            <Link href="/" className="font-semibold text-[var(--secondary)] underline">
              {t("expiredHomeCta")}
            </Link>
          </p>
        ) : null}

        <p className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-3.5 py-2.5 text-xs text-[var(--text-muted)]">
          {t("privacyNote")}
        </p>
      </section>
    </div>
  );
}
