import type { MetadataRoute } from "next";
import { AIRCRAFT_LAYOUTS } from "@/lib/aircraftLayouts";
import { BLOG_ARTICLES } from "@/lib/blogArticles";
import { getAppBaseUrl } from "@/lib/seo";
import { TOP_TRAINS } from "@/lib/topTrains";

export const revalidate = 3600;

export default function sitemap(): MetadataRoute.Sitemap {
  const baseUrl = getAppBaseUrl();
  const now = new Date();
  const entries: MetadataRoute.Sitemap = [];

  const withAlternates = (path: string, priority: number, changeFrequency: "daily" | "weekly" | "hourly") => ({
    url: `${baseUrl}${path}`,
    lastModified: now,
    changeFrequency,
    priority,
    alternates: {
      languages: {
        en: `${baseUrl}${path}`,
        hi: `${baseUrl}${path === "/" ? "/hi" : `/hi${path}`}`,
      },
    },
  });

  entries.push(withAlternates("/", 1.0, "daily"));
  entries.push(withAlternates("/pnr-status", 0.9, "hourly"));
  entries.push(withAlternates("/pricing", 0.6, "weekly"));
  entries.push(withAlternates("/blog", 0.7, "weekly"));
  entries.push(withAlternates("/legal/privacy", 0.5, "weekly"));
  entries.push(withAlternates("/legal/terms", 0.5, "weekly"));
  entries.push(withAlternates("/grievance", 0.5, "weekly"));

  for (const article of BLOG_ARTICLES) {
    entries.push(withAlternates(`/blog/${article.slug}`, 0.7, "weekly"));
  }

  for (const spec of Object.values(AIRCRAFT_LAYOUTS)) {
    if (spec.layoutRef.startsWith("generic:")) continue;
    const modelPart = spec.layoutRef.includes(":")
      ? spec.layoutRef.split(":", 2)[1]!
      : spec.layoutRef;
    entries.push(
      withAlternates(`/flights/${spec.carrierCode}/${modelPart}/seat-map`, 0.7, "weekly")
    );
  }

  for (const train of TOP_TRAINS) {
    entries.push(withAlternates(`/train/${train.trainNo}/live`, 0.8, "hourly"));
    entries.push(withAlternates(`/train/${train.trainNo}/coach-position`, 0.7, "weekly"));
    entries.push(withAlternates(`/train/${train.trainNo}/chart-time`, 0.8, "daily"));
  }

  return entries;
}
