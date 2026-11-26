import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { JsonLd } from "@/components/JsonLd";
import { BLOG_ARTICLES } from "@/lib/blogArticles";
import {
  buildBreadcrumbJsonLd,
  buildLocalizedPath,
  buildMetadata,
  getAppBaseUrl,
} from "@/lib/seo";

export const revalidate = 3600;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "seo.blog" });
  return buildMetadata({
    locale,
    path: "/blog",
    title: t("indexMetaTitle"),
    description: t("indexMetaDescription"),
  });
}

export default async function BlogIndexPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "seo.blog" });
  const tCommon = await getTranslations({ locale, namespace: "common" });

  const baseUrl = getAppBaseUrl();
  const isHi = locale === "hi";
  const jsonLd = buildBreadcrumbJsonLd([
    { name: tCommon("brand"), url: `${baseUrl}${buildLocalizedPath(locale, "/")}` },
    { name: t("indexTitle"), url: `${baseUrl}${buildLocalizedPath(locale, "/blog")}` },
  ]);

  return (
    <div className="space-y-6">
      <JsonLd data={jsonLd} />

      <header className="space-y-2">
        <h1
          className="text-3xl font-extrabold text-[var(--text)]"
          style={{ fontFamily: "var(--font-display)" }}
        >
          {t("indexTitle")}
        </h1>
        <p className="text-sm text-[var(--text-muted)]">{t("indexSubtitle")}</p>
      </header>

      <div className="space-y-4">
        {BLOG_ARTICLES.map((article) => {
          const content = isHi ? article.hi : article.en;
          return (
            <article
              key={article.slug}
              className="space-y-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow)]"
            >
              <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)]">
                <span>{article.publishedAt}</span>
                <span>·</span>
                <span>{t("readingTime", { minutes: article.readingMinutes })}</span>
              </div>
              <h2
                className="text-xl font-extrabold text-[var(--text)]"
                style={{ fontFamily: "var(--font-display)" }}
              >
                {content.title}
              </h2>
              <p className="text-sm text-[var(--text-muted)]">{content.description}</p>
              <div className="pt-1">
                <Link
                  href={`/blog/${article.slug}`}
                  className="inline-flex min-h-[48px] items-center rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-4 text-sm font-bold text-[var(--text)]"
                >
                  {t("readMoreCta")}
                </Link>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
