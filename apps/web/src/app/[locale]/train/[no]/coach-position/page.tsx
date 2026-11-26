import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import type { PublicTrainCoachDTO, PublicTrainCompositionResponse } from "@saath/contracts";
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
import { getTrainMeta, isValidTrainNo } from "@/lib/topTrains";
import { CoachPositionViewer } from "./CoachPositionViewer";

export const revalidate = 300;

function buildFallbackCoaches(trainNo: string): PublicTrainCoachDTO[] {
  const meta = getTrainMeta(trainNo);
  const classes = meta?.classes?.length ? meta.classes : ["3A"];
  const prefixByClass: Record<string, string> = {
    "1A": "H",
    "2A": "A",
    "3A": "B",
    "3E": "M",
    SL: "S",
    CC: "C",
    EC: "E",
    "2S": "D",
  };
  const capByClass: Record<string, number> = {
    "1A": 24,
    "2A": 48,
    "3A": 72,
    "3E": 83,
    SL: 72,
    CC: 78,
    EC: 56,
    "2S": 108,
  };
  const out: PublicTrainCoachDTO[] = [];
  let pos = 1;
  for (const cls of classes) {
    const prefix = prefixByClass[cls] ?? "B";
    const cap = capByClass[cls] ?? 72;
    const count = cls === "1A" || cls === "EC" ? 1 : cls === "2A" ? 2 : 3;
    for (let i = 1; i <= count; i += 1) {
      out.push({ coach: `${prefix}${i}`, travel_class: cls, position: pos, capacity: cap });
      pos += 1;
    }
  }
  return out;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; no: string }>;
}): Promise<Metadata> {
  const { locale, no } = await params;
  const meta = getTrainMeta(no);
  const t = await getTranslations({ locale, namespace: "seo.trainCoachPosition" });
  return buildMetadata({
    locale,
    path: `/train/${no}/coach-position`,
    title: t("metaTitle", { trainNo: no }),
    description: t("metaDescription", {
      trainNo: no,
      trainName: meta?.trainName ?? `Train ${no}`,
    }),
  });
}

export default async function PublicTrainCoachPositionPage({
  params,
}: {
  params: Promise<{ locale: string; no: string }>;
}) {
  const { locale, no } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "seo.trainCoachPosition" });
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

  const res = await fetchPublicJson<PublicTrainCompositionResponse>(
    `/v1/public/train/${encodeURIComponent(no)}/composition`,
    { revalidate: 300 }
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
  const data: PublicTrainCompositionResponse = res.data ?? {
    train_no: no,
    train_name: fallbackMeta?.trainName ?? `Express ${no}`,
    from_code: fallbackMeta?.fromCode ?? null,
    to_code: fallbackMeta?.toCode ?? null,
    service_date: new Date().toISOString().slice(0, 10),
    coaches: buildFallbackCoaches(no),
  };

  const baseUrl = getAppBaseUrl();
  const faqs = [{ question: t("faq1Q", { trainNo: no }), answer: t("faq1A") }];
  const jsonLd = [
    buildBreadcrumbJsonLd([
      { name: tCommon("brand"), url: `${baseUrl}${buildLocalizedPath(locale, "/")}` },
      {
        name: t("title", { trainNo: no }),
        url: `${baseUrl}${buildLocalizedPath(locale, `/train/${no}/coach-position`)}`,
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
          {data.train_name}
          {data.from_code && data.to_code ? ` · ${data.from_code} → ${data.to_code}` : ""}
        </p>
      </header>

      <CoachPositionViewer coaches={data.coaches} />

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
