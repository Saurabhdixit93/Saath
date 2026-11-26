import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { JsonLd } from "@/components/JsonLd";
import {
  buildBreadcrumbJsonLd,
  buildFaqJsonLd,
  buildLocalizedPath,
  buildMetadata,
  getAppBaseUrl,
} from "@/lib/seo";
import { PnrStatusClient } from "./PnrStatusClient";

export const revalidate = 60;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "seo.pnrStatus" });
  return buildMetadata({
    locale,
    path: "/pnr-status",
    title: t("metaTitle"),
    description: t("metaDescription"),
  });
}

export default async function PublicPnrStatusPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "seo.pnrStatus" });
  const tSeo = await getTranslations({ locale, namespace: "seo" });
  const tCommon = await getTranslations({ locale, namespace: "common" });

  const baseUrl = getAppBaseUrl();
  const faqs = [
    { question: t("faq1Q"), answer: t("faq1A") },
    { question: t("faq2Q"), answer: t("faq2A") },
  ];
  const jsonLd = [
    buildBreadcrumbJsonLd([
      { name: tCommon("brand"), url: `${baseUrl}${buildLocalizedPath(locale, "/")}` },
      { name: t("title"), url: `${baseUrl}${buildLocalizedPath(locale, "/pnr-status")}` },
    ]),
    buildFaqJsonLd(faqs),
  ];

  return (
    <div className="space-y-6">
      <JsonLd data={jsonLd} />

      <header className="space-y-2">
        <h1
          className="text-3xl font-extrabold text-[var(--text)]"
          style={{ fontFamily: "var(--font-display)" }}
        >
          {t("title")}
        </h1>
        <p className="text-sm text-[var(--text-muted)]">{t("subtitle")}</p>
      </header>

      <PnrStatusClient />

      <section className="flex flex-wrap gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-2)] p-4">
        <Link
          href="/"
          className="inline-flex min-h-[48px] items-center justify-center rounded-[var(--radius-sm)] bg-[var(--primary-btn-bg)] px-5 text-sm font-bold text-[var(--primary-ink)]"
        >
          {tSeo("findSwapCta")}
        </Link>
        <Link
          href="/"
          className="inline-flex min-h-[48px] items-center justify-center rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-4 text-sm font-semibold text-[var(--text)]"
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
        <div className="space-y-3">
          {faqs.map((f) => (
            <div key={f.question} className="space-y-1">
              <h3 className="text-sm font-bold text-[var(--text)]">{f.question}</h3>
              <p className="text-sm text-[var(--text-muted)]">{f.answer}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
