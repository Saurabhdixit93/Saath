import type { Metadata } from "next";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import type { PublicFlightLayoutsResponse } from "@saath/contracts";
import { EmptyState } from "@saath/ui";
import { routing } from "@/i18n/routing";
import { Link } from "@/i18n/navigation";
import { CabinMap } from "@/components/CabinMap";
import { JsonLd } from "@/components/JsonLd";
import { AIRCRAFT_LAYOUTS, type AircraftLayoutSpec } from "@/lib/aircraftLayouts";
import { fetchPublicJson } from "@/lib/serverApi";
import {
  buildBreadcrumbJsonLd,
  buildFaqJsonLd,
  buildLocalizedPath,
  buildMetadata,
  getAppBaseUrl,
} from "@/lib/seo";

export const revalidate = 3600;

function findExactLocalLayout(airline: string, aircraft: string): AircraftLayoutSpec | null {
  const airlineUpper = airline.trim().toUpperCase();
  const aircraftLower = aircraft.trim().toLowerCase();
  for (const spec of Object.values(AIRCRAFT_LAYOUTS)) {
    if (spec.layoutRef.startsWith("generic:")) continue;
    const modelPart = spec.layoutRef.includes(":")
      ? spec.layoutRef.split(":", 2)[1]!.toLowerCase()
      : spec.layoutRef.toLowerCase();
    if (spec.carrierCode.toUpperCase() === airlineUpper && modelPart === aircraftLower) {
      return spec;
    }
  }
  return null;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; airline: string; aircraft: string }>;
}): Promise<Metadata> {
  const { locale, airline, aircraft } = await params;
  const appLocale = hasLocale(routing.locales, locale) ? locale : routing.defaultLocale;
  const t = await getTranslations({ locale: appLocale, namespace: "seo.flightSeatMap" });
  return buildMetadata({
    locale: appLocale,
    path: `/flights/${airline}/${aircraft}/seat-map`,
    title: t("metaTitle", { airline: airline.toUpperCase(), aircraft }),
    description: t("metaDescription", { airline: airline.toUpperCase(), aircraft }),
  });
}

export default async function PublicFlightSeatMapPage({
  params,
}: {
  params: Promise<{ locale: string; airline: string; aircraft: string }>;
}) {
  const { locale, airline, aircraft } = await params;
  const appLocale = hasLocale(routing.locales, locale) ? locale : routing.defaultLocale;
  setRequestLocale(appLocale);
  const t = await getTranslations({ locale: appLocale, namespace: "seo.flightSeatMap" });
  const tSeo = await getTranslations({ locale: appLocale, namespace: "seo" });
  const tNotFound = await getTranslations({ locale: appLocale, namespace: "seo.notFound" });
  const tCommon = await getTranslations({ locale: appLocale, namespace: "common" });

  const res = await fetchPublicJson<PublicFlightLayoutsResponse>(
    `/v1/public/flight-layouts?airline=${encodeURIComponent(airline)}&aircraft=${encodeURIComponent(aircraft)}`,
    { revalidate: 3600 }
  );

  const apiItem = res.ok && res.data?.items?.length ? res.data.items[0] : null;
  const localSpec = !res.ok && res.networkError ? findExactLocalLayout(airline, aircraft) : null;

  const matched = apiItem
    ? {
        layoutRef: apiItem.layout_ref,
        carrierCode: apiItem.carrier_code,
        aircraftName: apiItem.aircraft_name,
        configuration: apiItem.configuration,
        totalSeats: apiItem.total_seats,
      }
    : localSpec
      ? {
          layoutRef: localSpec.layoutRef,
          carrierCode: localSpec.carrierCode,
          aircraftName: localSpec.aircraftName,
          configuration: localSpec.configuration,
          totalSeats: localSpec.totalSeats,
        }
      : null;

  if (!matched) {
    return (
      <EmptyState
        title={tNotFound("title")}
        description={tNotFound("flightBody", {
          airline: airline.toUpperCase(),
          aircraft,
        })}
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

  const baseUrl = getAppBaseUrl();
  const faqs = [{ question: t("faq1Q"), answer: t("faq1A") }];
  const jsonLd = [
    buildBreadcrumbJsonLd([
      { name: tCommon("brand"), url: `${baseUrl}${buildLocalizedPath(appLocale, "/")}` },
      {
        name: matched.aircraftName,
        url: `${baseUrl}${buildLocalizedPath(appLocale, `/flights/${airline}/${aircraft}/seat-map`)}`,
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
          {t("title", { airline: matched.carrierCode, aircraft })}
        </h1>
        <p className="text-sm font-semibold text-[var(--text-muted)]">
          {matched.aircraftName} ·{" "}
          {t("configSummary", {
            config: matched.configuration,
            totalSeats: matched.totalSeats,
          })}
        </p>
      </header>

      <CabinMap layoutRef={matched.layoutRef} carrierCode={matched.carrierCode} />

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
