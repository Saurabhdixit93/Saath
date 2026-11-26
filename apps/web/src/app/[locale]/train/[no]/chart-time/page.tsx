import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import type { PublicChartTimeResponse } from "@saath/contracts";
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
  const t = await getTranslations({ locale, namespace: "seo.trainChartTime" });
  return buildMetadata({
    locale,
    path: `/train/${no}/chart-time`,
    title: t("metaTitle", { trainNo: no }),
    description: t("metaDescription", {
      trainNo: no,
      trainName: meta?.trainName ?? `Train ${no}`,
    }),
  });
}

export default async function PublicTrainChartTimePage({
  params,
}: {
  params: Promise<{ locale: string; no: string }>;
}) {
  const { locale, no } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "seo.trainChartTime" });
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

  const res = await fetchPublicJson<PublicChartTimeResponse>(
    `/v1/public/train/${encodeURIComponent(no)}/chart-time`,
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

  const meta = getTrainMeta(no);
  const data: PublicChartTimeResponse = res.data ?? computeFallbackChartTime(no);

  const baseUrl = getAppBaseUrl();
  const faqs = [{ question: t("faq1Q"), answer: t("faq1A") }];
  const jsonLd = [
    buildBreadcrumbJsonLd([
      { name: tCommon("brand"), url: `${baseUrl}${buildLocalizedPath(locale, "/")}` },
      {
        name: t("title", { trainNo: no }),
        url: `${baseUrl}${buildLocalizedPath(locale, `/train/${no}/chart-time`)}`,
      },
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
          {meta?.trainName ?? `Express ${data.train_no}`}
        </p>
      </header>

      <section className="space-y-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow)]">
        <p className="text-xs font-semibold text-[var(--text-muted)]">{t("dueAtLabel")}</p>
        <p className="text-lg font-bold text-[var(--secondary)]" style={{ fontFamily: "var(--font-mono)" }}>
          {data.chart_due_at}
        </p>
        <h2
          className="pt-2 text-base font-extrabold text-[var(--text)]"
          style={{ fontFamily: "var(--font-display)" }}
        >
          {t("ruleHeading")}
        </h2>
        <p className="text-sm text-[var(--text-muted)]">
          {data.rule.includes("morning") ? t("ruleMorning") : t("ruleStandard")}
        </p>
      </section>

      <section className="flex flex-wrap gap-3">
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
      </section>

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
