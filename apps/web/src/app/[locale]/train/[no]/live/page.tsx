import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import type { PublicTrainLiveResponse } from "@saath/contracts";
import { EmptyState } from "@saath/ui";
import { Link } from "@/i18n/navigation";
import { JsonLd } from "@/components/JsonLd";
import { fetchPublicJson } from "@/lib/serverApi";
import {
  buildBreadcrumbJsonLd,
  buildFaqJsonLd,
  buildLocalizedPath,
  buildMetadata,
  getAppBaseUrl,
} from "@/lib/seo";
import { computeFallbackChartTime, getTrainMeta, isValidTrainNo } from "@/lib/topTrains";

export const revalidate = 60;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; no: string }>;
}): Promise<Metadata> {
  const { locale, no } = await params;
  const meta = getTrainMeta(no);
  const t = await getTranslations({ locale, namespace: "seo.trainLive" });
  return buildMetadata({
    locale,
    path: `/train/${no}/live`,
    title: t("metaTitle", { trainNo: no }),
    description: t("metaDescription", {
      trainNo: no,
      trainName: meta?.trainName ?? `Train ${no}`,
    }),
  });
}

export default async function PublicTrainLivePage({
  params,
}: {
  params: Promise<{ locale: string; no: string }>;
}) {
  const { locale, no } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "seo.trainLive" });
  const tSeo = await getTranslations({ locale, namespace: "seo" });
  const tNotFound = await getTranslations({ locale, namespace: "seo.notFound" });
  const tCommon = await getTranslations({ locale, namespace: "common" });

  if (!isValidTrainNo(no)) {
    return (
      <EmptyState
        title={tNotFound("title")}
        description={tNotFound("trainBody", { trainNo: no })}
        primaryAction={
          <Link
            href="/"
            className="inline-flex min-h-[48px] items-center justify-center rounded-[var(--radius-sm)] bg-[var(--primary-btn-bg)] px-5 text-sm font-bold text-[var(--primary-ink)]"
          >
            {tNotFound("homeCta")}
          </Link>
        }
      />
    );
  }

  const res = await fetchPublicJson<PublicTrainLiveResponse>(
    `/v1/public/train/${encodeURIComponent(no)}/live`,
    { revalidate: 60 }
  );

  if (res.status === 404) {
    return (
      <EmptyState
        title={tNotFound("title")}
        description={tNotFound("trainBody", { trainNo: no })}
        primaryAction={
          <Link
            href="/"
            className="inline-flex min-h-[48px] items-center justify-center rounded-[var(--radius-sm)] bg-[var(--primary-btn-bg)] px-5 text-sm font-bold text-[var(--primary-ink)]"
          >
            {tNotFound("homeCta")}
          </Link>
        }
      />
    );
  }

  const fallbackMeta = getTrainMeta(no);
  const fallbackChart = computeFallbackChartTime(no);
  const data: PublicTrainLiveResponse = res.data ?? {
    train_no: no,
    train_name: fallbackMeta?.trainName ?? `Express ${no}`,
    from_code: fallbackMeta?.fromCode ?? null,
    to_code: fallbackMeta?.toCode ?? null,
    service_date: fallbackChart.date,
    current_station: fallbackMeta?.fromCode ?? "NDLS",
    delay_minutes: 0,
    chart_state: "pending",
    chart_due_at: fallbackChart.chart_due_at,
  };

  const baseUrl = getAppBaseUrl();
  const faqs = [{ question: t("faq1Q", { trainNo: no }), answer: t("faq1A") }];
  const jsonLd = [
    buildBreadcrumbJsonLd([
      { name: tCommon("brand"), url: `${baseUrl}${buildLocalizedPath(locale, "/")}` },
      { name: t("title", { trainNo: no }), url: `${baseUrl}${buildLocalizedPath(locale, `/train/${no}/live`)}` },
    ]),
    buildFaqJsonLd(faqs),
  ];

  return (
    <div className="space-y-6">
      <JsonLd data={jsonLd} />

      <header className="space-y-1">
        <h1
          className="text-3xl font-extrabold text-[var(--text)]"
          style={{ fontFamily: "var(--font-display)" }}
        >
          {t("title", { trainNo: data.train_no })}
        </h1>
        <p className="text-sm font-semibold text-[var(--text-muted)]">
          {data.train_name}
          {data.from_code && data.to_code ? ` · ${data.from_code} → ${data.to_code}` : ""}
        </p>
      </header>

      <section className="grid grid-cols-1 gap-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow)] sm:grid-cols-2">
        <div>
          <p className="text-xs text-[var(--text-muted)]">{t("currentStationLabel")}</p>
          <p className="text-lg font-bold text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>
            {data.current_station ?? "—"}
          </p>
        </div>
        <div>
          <p className="text-xs text-[var(--text-muted)]">{t("delayLabel")}</p>
          <p className="text-lg font-bold text-[var(--secondary)]">
            {data.delay_minutes === 0
              ? t("onTime")
              : t("delayedMinutes", { minutes: data.delay_minutes })}
          </p>
        </div>
        <div>
          <p className="text-xs text-[var(--text-muted)]">{t("chartStatusLabel")}</p>
          <p className="text-sm font-bold text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>
            {data.chart_state}
          </p>
        </div>
        <div>
          <p className="text-xs text-[var(--text-muted)]">{t("chartTimeLabel")}</p>
          <p className="text-sm font-bold text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>
            {data.chart_due_at ?? "—"}
          </p>
        </div>
      </section>

      <nav className="flex flex-wrap gap-3">
        <Link
          href={`/train/${no}/coach-position`}
          className="inline-flex min-h-[48px] items-center justify-center rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-4 text-sm font-semibold text-[var(--text)]"
        >
          {t("coachPositionLink")}
        </Link>
        <Link
          href={`/train/${no}/chart-time`}
          className="inline-flex min-h-[48px] items-center justify-center rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-4 text-sm font-semibold text-[var(--text)]"
        >
          {t("chartTimeLink")}
        </Link>
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
      </nav>

      <section className="space-y-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow)]">
        <h2
          className="text-lg font-extrabold text-[var(--text)]"
          style={{ fontFamily: "var(--font-display)" }}
        >
          {tSeo("faqHeading")}
        </h2>
        {faqs.map((f) => (
          <div key={f.question} className="space-y-1">
            <h3 className="text-sm font-bold text-[var(--text)]">{f.question}</h3>
            <p className="text-sm text-[var(--text-muted)]">{f.answer}</p>
          </div>
        ))}
      </section>
    </div>
  );
}
