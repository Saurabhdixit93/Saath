import type { MetadataRoute } from "next";
import { getAppBaseUrl } from "@/lib/seo";

export default function robots(): MetadataRoute.Robots {
  const baseUrl = getAppBaseUrl();
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/api/", "/inbox/", "/profile/", "/swaps/"],
      },
    ],
    sitemap: `${baseUrl}/sitemap.xml`,
  };
}
