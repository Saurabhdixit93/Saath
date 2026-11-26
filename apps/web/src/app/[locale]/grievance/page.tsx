import type { Metadata } from "next";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { routing } from "@/i18n/routing";
import { Link } from "@/i18n/navigation";
import { JsonLd } from "@/components/JsonLd";
import { GrievanceForm } from "@/components/GrievanceForm";
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
  const t = await getTranslations({ locale: appLocale, namespace: "grievance" });
  return buildMetadata({
    locale: appLocale,
    path: "/grievance",
    title: t("metaTitle"),
    description: t("metaDescription"),
  });
}

export default async function GrievancePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const appLocale = hasLocale(routing.locales, locale) ? locale : routing.defaultLocale;
  setRequestLocale(appLocale);

  const t = await getTranslations({ locale: appLocale, namespace: "grievance" });
  const tLegal = await getTranslations({ locale: appLocale, namespace: "legal" });
  const tCommon = await getTranslations({ locale: appLocale, namespace: "common" });

  const baseUrl = getAppBaseUrl();
  const jsonLd = buildBreadcrumbJsonLd([
    { name: tCommon("brand"), url: `${baseUrl}${buildLocalizedPath(appLocale, "/")}` },
    {
      name: t("title"),
      url: `${baseUrl}${buildLocalizedPath(appLocale, "/grievance")}`,
    },
  ]);

  const officerRows = [
    { label: t("officerNameLabel"), value: t("officerNameValue") },
    { label: t("officerRoleLabel"), value: t("officerRoleValue") },
    { label: t("officerEntityLabel"), value: t("officerEntityValue") },
    { label: t("officerEmailLabel"), value: t("officerEmailValue") },
    { label: t("officerHoursLabel"), value: t("officerHoursValue") },
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
      </header>

      <section className="space-y-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow)]">
        <h2
          className="text-lg font-bold text-[var(--text)]"
          style={{ fontFamily: "var(--font-display)" }}
        >
          {t("officerCardTitle")}
        </h2>
        <dl className="divide-y divide-[var(--border)]">
          {officerRows.map((row) => (
            <div key={row.label} className="grid gap-1 py-2.5 sm:grid-cols-3 sm:gap-4">
              <dt className="text-xs font-semibold text-[var(--text-muted)]">{row.label}</dt>
              <dd className="text-sm font-medium text-[var(--text)] sm:col-span-2">{row.value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="space-y-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow)]">
        <h2
          className="text-lg font-bold text-[var(--text)]"
          style={{ fontFamily: "var(--font-display)" }}
        >
          {t("timelinesTitle")}
        </h2>
        <ul className="list-disc space-y-2 pl-5 text-sm leading-relaxed text-[var(--text-muted)]">
          <li>{t("timelineAck")}</li>
          <li>{t("timelineResolve")}</li>
          <li>{t("timelineErasure")}</li>
        </ul>
      </section>

      <section className="space-y-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow)]">
        <h2
          className="text-lg font-bold text-[var(--text)]"
          style={{ fontFamily: "var(--font-display)" }}
        >
          {t("dpbiTitle")}
        </h2>
        <p className="text-sm leading-relaxed text-[var(--text-muted)]">{t("dpbiBody")}</p>
      </section>

      <section className="space-y-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow)]">
        <h2
          className="text-lg font-bold text-[var(--text)]"
          style={{ fontFamily: "var(--font-display)" }}
        >
          {t("selfServiceTitle")}
        </h2>
        <p className="text-sm leading-relaxed text-[var(--text-muted)]">{t("selfServiceBody")}</p>
        <div className="flex flex-wrap gap-3">
          <Link
            href="/profile"
            className="inline-flex min-h-[48px] items-center justify-center rounded-[var(--radius-sm)] bg-[var(--primary-btn-bg)] px-4 text-sm font-bold text-[var(--primary-ink)] hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]"
          >
            {t("profileRightsCta")}
          </Link>
          <Link
            href="/legal/privacy"
            className="inline-flex min-h-[48px] items-center justify-center rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-4 text-sm font-semibold text-[var(--text)] hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]"
          >
            {t("privacyLinkCta")}
          </Link>
        </div>
      </section>

      <GrievanceForm />
    </div>
  );
}
