import type { Metadata } from "next";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { routing } from "@/i18n/routing";
import { Link } from "@/i18n/navigation";
import { JsonLd } from "@/components/JsonLd";
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
  const t = await getTranslations({ locale: appLocale, namespace: "legal.terms" });
  return buildMetadata({
    locale: appLocale,
    path: "/legal/terms",
    title: t("metaTitle"),
    description: t("metaDescription"),
  });
}

export default async function TermsOfUsePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const appLocale = hasLocale(routing.locales, locale) ? locale : routing.defaultLocale;
  setRequestLocale(appLocale);

  const t = await getTranslations({ locale: appLocale, namespace: "legal.terms" });
  const tLegal = await getTranslations({ locale: appLocale, namespace: "legal" });
  const tCommon = await getTranslations({ locale: appLocale, namespace: "common" });

  const baseUrl = getAppBaseUrl();
  const jsonLd = buildBreadcrumbJsonLd([
    { name: tCommon("brand"), url: `${baseUrl}${buildLocalizedPath(appLocale, "/")}` },
    {
      name: t("title"),
      url: `${baseUrl}${buildLocalizedPath(appLocale, "/legal/terms")}`,
    },
  ]);

  const sections = [
    { heading: t("ageHeading"), body: t("ageBody") },
    { heading: t("tteHeading"), body: t("tteBody") },
    { heading: t("affiliationHeading"), body: t("affiliationBody") },
    { heading: t("freeHeading"), body: t("freeBody") },
    { heading: t("conductHeading"), body: t("conductBody") },
  ];

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
          {t("entityNote")}
        </p>
      </header>

      <div className="space-y-4">
        {sections.map((section) => (
          <section
            key={section.heading}
            className="space-y-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow)]"
          >
            <h2
              className="text-lg font-bold text-[var(--text)]"
              style={{ fontFamily: "var(--font-display)" }}
            >
              {section.heading}
            </h2>
            <p className="text-sm leading-relaxed text-[var(--text-muted)]">{section.body}</p>
          </section>
        ))}
      </div>

      <div className="flex flex-wrap gap-3">
        <Link
          href="/legal/privacy"
          className="inline-flex min-h-[48px] items-center justify-center rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-4 text-sm font-semibold text-[var(--text)] hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]"
        >
          {t("privacyLinkCta")}
        </Link>
        <Link
          href="/grievance"
          className="inline-flex min-h-[48px] items-center justify-center rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-4 text-sm font-semibold text-[var(--text)] hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]"
        >
          {t("grievanceLinkCta")}
        </Link>
      </div>
    </div>
  );
}
