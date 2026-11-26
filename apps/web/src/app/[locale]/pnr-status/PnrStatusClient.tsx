"use client";

import { useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@saath/ui";
import { parseProblemDetail, type PublicPnrStatusResponse } from "@saath/contracts";
import { Link } from "@/i18n/navigation";
import { createPublicBrowserClient } from "@/lib/serverApi";

const publicClient = createPublicBrowserClient();

export function PnrStatusClient() {
  const t = useTranslations("seo.pnrStatus");
  const tSeo = useTranslations("seo");

  const [pnrInput, setPnrInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [result, setResult] = useState<PublicPnrStatusResponse | null>(null);

  const handleSubmit = async (ev: FormEvent) => {
    ev.preventDefault();
    setErrorMsg(null);
    setResult(null);

    const cleaned = pnrInput.trim();
    if (!/^[0-9]{10}$/.test(cleaned)) {
      setErrorMsg(t("invalidError"));
      return;
    }

    setLoading(true);
    try {
      const { data, error } = await publicClient.GET("/v1/public/pnr-status/{pnr}", {
        params: { path: { pnr: cleaned } },
      });
      if (error || !data) {
        const problem = parseProblemDetail(error);
        setErrorMsg(problem?.detail || t("invalidError"));
        return;
      }
      setResult(data);
    } catch {
      setErrorMsg(t("invalidError"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-5">
      <section className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow)]">
        <form onSubmit={(ev) => void handleSubmit(ev)} className="space-y-3" noValidate>
          <label
            htmlFor="public-pnr-input"
            className="block text-sm font-semibold text-[var(--text)]"
          >
            {t("inputLabel")}
          </label>
          <div className="flex flex-col gap-3 sm:flex-row">
            <input
              id="public-pnr-input"
              type="text"
              inputMode="numeric"
              value={pnrInput}
              onChange={(ev) => {
                setPnrInput(ev.target.value);
                setErrorMsg(null);
              }}
              placeholder={t("inputPlaceholder")}
              className="min-h-[48px] flex-1 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] px-4 text-base tracking-wider text-[var(--text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]"
              style={{ fontFamily: "var(--font-mono)" }}
            />
            <Button type="submit" variant="primary" loading={loading} className="shrink-0">
              {loading ? t("checkingCta") : t("submitCta")}
            </Button>
          </div>

          {errorMsg ? (
            <p role="alert" className="text-sm font-medium text-[var(--danger-text)]">
              {errorMsg}
            </p>
          ) : null}
        </form>
      </section>

      {result ? (
        <section className="space-y-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow)]">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2
              className="text-lg font-extrabold text-[var(--text)]"
              style={{ fontFamily: "var(--font-display)" }}
            >
              {t("summaryTitle")}
            </h2>
            <span
              className="rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1 text-xs font-bold text-[var(--secondary)]"
              style={{ fontFamily: "var(--font-mono)" }}
            >
              {t("countsLabel", {
                cnf: result.confirmed_count,
                rac: result.rac_count,
                wl: result.wl_count,
              })}
            </span>
          </div>

          <dl className="grid grid-cols-1 gap-3 rounded-[var(--radius-sm)] bg-[var(--surface-2)] p-4 sm:grid-cols-2">
            <div>
              <dt className="text-xs text-[var(--text-muted)]">{t("trainLabel")}</dt>
              <dd className="text-sm font-bold text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>
                {result.train_no} · {result.train_name}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--text-muted)]">{t("routeLabel")}</dt>
              <dd className="text-sm font-bold text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>
                {result.from_code} → {result.to_code}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--text-muted)]">{t("dateLabel")}</dt>
              <dd className="text-sm font-bold text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>
                {result.service_date}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--text-muted)]">{t("classLabel")} / {t("chartLabel")}</dt>
              <dd className="text-sm font-bold text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>
                {result.travel_class} · {result.chart_state}
              </dd>
            </div>
          </dl>

          {result.coaches.length > 0 ? (
            <p className="text-xs font-semibold text-[var(--text-muted)]">
              {t("coachesLabel", { coaches: result.coaches.join(", ") })}
            </p>
          ) : null}

          <div className="flex flex-wrap gap-2">
            {result.status_summary.map((item) => (
              <span
                key={item.pax_seq}
                className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] px-3 py-1.5 text-xs font-semibold text-[var(--text)]"
                style={{ fontFamily: "var(--font-mono)" }}
              >
                #{item.pax_seq}: {item.current_status}
                {item.coach ? ` · ${item.coach}` : ""}
                {item.seat_type ? ` (${item.seat_type})` : ""}
              </span>
            ))}
          </div>

          <div className="flex flex-wrap gap-3 pt-1">
            <Link
              href="/"
              className="inline-flex min-h-[48px] items-center justify-center rounded-[var(--radius-sm)] bg-[var(--primary-btn-bg)] px-5 text-sm font-bold text-[var(--primary-ink)]"
            >
              {tSeo("findSwapCta")}
            </Link>
            <Link
              href="/"
              className="inline-flex min-h-[48px] items-center justify-center rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-4 text-sm font-semibold text-[var(--text)]"
            >
              {tSeo("openToHelpCta")}
            </Link>
          </div>
        </section>
      ) : null}
    </div>
  );
}
