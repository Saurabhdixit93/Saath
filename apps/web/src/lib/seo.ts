import type { Metadata } from "next";
import { publicEnv } from "./env";

export interface BuildSeoMetadataInput {
  locale: string;
  path: string;
  title: string;
  description: string;
  ogTitle?: string;
  type?: "website" | "article";
  noIndex?: boolean;
}

export function getAppBaseUrl(): string {
  return publicEnv.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "");
}

export function buildLocalizedPath(locale: string, path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  if (locale === "hi") {
    return normalized === "/" ? "/hi" : `/hi${normalized}`;
  }
  return normalized;
}

export function buildMetadata(input: BuildSeoMetadataInput): Metadata {
  const baseUrl = getAppBaseUrl();
  const enPath = buildLocalizedPath("en", input.path);
  const hiPath = buildLocalizedPath("hi", input.path);
  const canonicalPath = input.locale === "hi" ? hiPath : enPath;

  return {
    metadataBase: new URL(baseUrl),
    title: input.title,
    description: input.description,
    alternates: {
      canonical: `${baseUrl}${canonicalPath}`,
      languages: {
        en: `${baseUrl}${enPath}`,
        hi: `${baseUrl}${hiPath}`,
      },
    },
    openGraph: {
      title: input.ogTitle ?? input.title,
      description: input.description,
      url: `${baseUrl}${canonicalPath}`,
      siteName: "Saath",
      locale: input.locale === "hi" ? "hi_IN" : "en_IN",
      type: input.type ?? "website",
    },
    twitter: {
      card: "summary_large_image",
      title: input.ogTitle ?? input.title,
      description: input.description,
    },
    robots: input.noIndex ? { index: false, follow: false } : undefined,
  };
}

export function buildBreadcrumbJsonLd(
  items: Array<{ name: string; url: string }>
): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, idx) => ({
      "@type": "ListItem",
      position: idx + 1,
      name: item.name,
      item: item.url,
    })),
  };
}

export function buildFaqJsonLd(
  faqs: Array<{ question: string; answer: string }>
): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map((faq) => ({
      "@type": "Question",
      name: faq.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: faq.answer,
      },
    })),
  };
}

export function buildArticleJsonLd(input: {
  title: string;
  description: string;
  url: string;
  datePublished: string;
  dateModified: string;
  locale: string;
}): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: input.title,
    description: input.description,
    mainEntityOfPage: input.url,
    datePublished: input.datePublished,
    dateModified: input.dateModified,
    inLanguage: input.locale === "hi" ? "hi-IN" : "en-IN",
    author: {
      "@type": "Organization",
      name: "Saath",
    },
    publisher: {
      "@type": "Organization",
      name: "Saath",
    },
  };
}
