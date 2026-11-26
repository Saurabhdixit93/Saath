import type { Metadata } from "next";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { routing } from "@/i18n/routing";
import { Link } from "@/i18n/navigation";
import { JsonLd } from "@/components/JsonLd";
import { DPDP_PURPOSES, ESSENTIAL_DPDP_PURPOSES } from "@/lib/dpdp";
import {
  buildBreadcrumbJsonLd,
  buildLocalizedPath,
  buildMetadata,
  getAppBaseUrl,
} from "@/lib/seo";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const appLocale = hasLocale(routing.locales, locale) ? locale : routing.defaultLocale;
  const t = await getTranslations({ locale: appLocale, namespace: "legal.privacy" });
  return buildMetadata({
    locale: appLocale,
    path: "/legal/privacy",
    title: t("metaTitle"),
    description: t("metaDescription"),
  });
}

export default async function PrivacyPolicyPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const appLocale = hasLocale(routing.locales, locale) ? locale : routing.defaultLocale;
  setRequestLocale(appLocale);

  const t = await getTranslations({ locale: appLocale, namespace: "legal.privacy" });
  const tLegal = await getTranslations({ locale: appLocale, namespace: "legal" });
  const tDpdp = await getTranslations({ locale: appLocale, namespace: "dpdp" });
  const tCommon = await getTranslations({ locale: appLocale, namespace: "common" });

  const baseUrl = getAppBaseUrl();
  const jsonLd = buildBreadcrumbJsonLd([
    { name: tCommon("brand"), url: `${baseUrl}${buildLocalizedPath(appLocale, "/")}` },
    {
      name: t("title"),
      url: `${baseUrl}${buildLocalizedPath(appLocale, "/legal/privacy")}`,
    },
  ]);

  return (
    <div className="space-y-6">
      <JsonLd data={jsonLd} />

      <div>
        <Link
          href="/"
          className="inline-flex min-h-[48px] items-center text-sm font-semibold text-[var(--secondary)] underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]"
        >
          {tLegal("backHome")}
        </Link>
      </div>

      <header className="space-y-2">
        <h1
          className="text-3xl font-extrabold text-[var(--text)]"
          style={{ fontFamily: "var(--font-display)" }}
        >
          {t("title")}
        </h1>
        <p className="text-sm text-[var(--text-muted)]">{t("subtitle")}</p>
        <p className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] p-3 text-xs text-[var(--text-muted)]">
          {t("effectiveNote")}
        </p>
      </header>

      <section className="space-y-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow)]">
        <h2
          className="text-lg font-bold text-[var(--text)]"
          style={{ fontFamily: "var(--font-display)" }}
        >
          {tDpdp("noticeTitle", { version: "1.0" })}
        </h2>
        <p className="text-sm text-[var(--text-muted)]">{tDpdp("noticeCompactSummary")}</p>
        <ul className="space-y-2.5">
          {DPDP_PURPOSES.map((purpose) => {
            const isEssential = ESSENTIAL_DPDP_PURPOSES.has(purpose);
            return (
              <li
                key={purpose}
                className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] p-3.5"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-bold text-[var(--text)]">
                    {tDpdp(`purpose_${purpose}_title`)}
                  </span>
                  <code
                    className="rounded border border-[var(--border)] bg-[var(--surface-2)] px-2 py-0.5 text-xs text-[var(--text)]"
                    style={{ fontFamily: "var(--font-mono)" }}
                  >
                    {purpose}
                  </code>
                  <span className="rounded border border-[var(--border)] bg-[var(--surface-2)] px-2 py-0.5 text-xs font-semibold text-[var(--text-muted)]">
                    {isEssential ? tDpdp("essentialBadge") : tDpdp("optionalBadge")}
                  </span>
                </div>
                <p className="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">
                  {tDpdp(`purpose_${purpose}_desc`)}
                </p>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="space-y-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow)]">
        <h2
          className="text-lg font-bold text-[var(--text)]"
          style={{ fontFamily: "var(--font-display)" }}
        >
          {t("collectedHeading")}
        </h2>
        <ul className="list-disc space-y-2 pl-5 text-sm leading-relaxed text-[var(--text-muted)]">
          <li>{t("collectedPhone")}</li>
          <li>{t("collectedProfile")}</li>
          <li>{t("collectedJourney")}</li>
          <li>{t("collectedConsents")}</li>
        </ul>
      </section>

      <section className="space-y-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow)]">
        <h2
          className="text-lg font-bold text-[var(--text)]"
          style={{ fontFamily: "var(--font-display)" }}
        >
          {t("neverStoredHeading")}
        </h2>
        <ul className="list-disc space-y-2 pl-5 text-sm leading-relaxed text-[var(--text-muted)]">
          <li>{t("neverStoredPnr")}</li>
          <li>{t("neverStoredNames")}</li>
          <li>{t("neverStoredImages")}</li>
          <li>{t("neverStoredLlm")}</li>
        </ul>
      </section>

      <section className="space-y-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow)]">
        <h2
          className="text-lg font-bold text-[var(--text)]"
          style={{ fontFamily: "var(--font-display)" }}
        >
          {t("processorsHeading")}
        </h2>
        <ul className="list-disc space-y-2 pl-5 text-sm leading-relaxed text-[var(--text-muted)]">
          <li>{t("processorCloudflare")}</li>
          <li>{t("processorRailway")}</li>
          <li>{t("processorPosthog")}</li>
          <li>{t("processorMsg91")}</li>
          <li>{t("processorMeta")}</li>
          <li>{t("processorAnthropic")}</li>
        </ul>
      </section>

      <section className="space-y-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow)]">
        <h2
          className="text-lg font-bold text-[var(--text)]"
          style={{ fontFamily: "var(--font-display)" }}
        >
          {t("retentionHeading")}
        </h2>
        <ul className="list-disc space-y-2 pl-5 text-sm leading-relaxed text-[var(--text-muted)]">
          <li>{t("retentionJourney")}</li>
          <li>{t("retentionSwaps")}</li>
          <li>{t("retentionReports")}</li>
          <li>{t("retentionInvites")}</li>
          <li>{t("retentionErasure")}</li>
        </ul>
      </section>

      <section className="space-y-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow)]">
        <h2
          className="text-lg font-bold text-[var(--text)]"
          style={{ fontFamily: "var(--font-display)" }}
        >
          {t("rightsHeading")}
        </h2>
        <p className="text-sm leading-relaxed text-[var(--text-muted)]">{t("rightsBody")}</p>
        <div className="flex flex-wrap gap-3">
          <Link
            href="/profile"
            className="inline-flex min-h-[48px] items-center justify-center rounded-[var(--radius-sm)] bg-[var(--primary-btn-bg)] px-4 text-sm font-bold text-[var(--primary-ink)] hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]"
          >
            {t("manageProfileCta")}
          </Link>
          <Link
            href="/grievance"
            className="inline-flex min-h-[48px] items-center justify-center rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-4 text-sm font-semibold text-[var(--text)] hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]"
          >
            {t("grievanceCta")}
          </Link>
        </div>
      </section>
    </div>
  );
}
