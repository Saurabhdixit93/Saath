import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { routing } from "@/i18n/routing";
import { Link } from "@/i18n/navigation";
import { JsonLd } from "@/components/JsonLd";
import { BLOG_ARTICLES, getBlogArticle } from "@/lib/blogArticles";
import {
  buildArticleJsonLd,
  buildBreadcrumbJsonLd,
  buildFaqJsonLd,
  buildLocalizedPath,
  buildMetadata,
  getAppBaseUrl,
} from "@/lib/seo";

export const revalidate = 3600;

export function generateStaticParams() {
  return BLOG_ARTICLES.map((a) => ({ slug: a.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}): Promise<Metadata> {
  const { locale, slug } = await params;
  const appLocale = hasLocale(routing.locales, locale) ? locale : routing.defaultLocale;
  const article = getBlogArticle(slug);
  if (!article) {
    return buildMetadata({
      locale: appLocale,
      path: `/blog/${slug}`,
      title: "Guide not found — Saath",
      description: "Saath travel and seat-swap guides.",
      noIndex: true,
    });
  }
  const content = appLocale === "hi" ? article.hi : article.en;
  return buildMetadata({
    locale: appLocale,
    path: `/blog/${slug}`,
    title: `${content.title} — Saath`,
    description: content.description,
    type: "article",
  });
}

export default async function BlogArticlePage({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale, slug } = await params;
  const appLocale = hasLocale(routing.locales, locale) ? locale : routing.defaultLocale;
  setRequestLocale(appLocale);

  const article = getBlogArticle(slug);
  if (!article) {
    notFound();
  }

  const tSeo = await getTranslations({ locale: appLocale, namespace: "seo" });
  const tBlog = await getTranslations({ locale: appLocale, namespace: "seo.blog" });
  const tCommon = await getTranslations({ locale: appLocale, namespace: "common" });

  const isHi = appLocale === "hi";
  const content = isHi ? article.hi : article.en;
  const baseUrl = getAppBaseUrl();
  const pageUrl = `${baseUrl}${buildLocalizedPath(appLocale, `/blog/${slug}`)}`;

  const jsonLd: Array<Record<string, unknown>> = [
    buildArticleJsonLd({
      title: content.title,
      description: content.description,
      url: pageUrl,
      datePublished: article.publishedAt,
      dateModified: article.updatedAt,
      locale: appLocale,
    }),
    buildBreadcrumbJsonLd([
      { name: tCommon("brand"), url: `${baseUrl}${buildLocalizedPath(appLocale, "/")}` },
      { name: tBlog("allGuidesLink"), url: `${baseUrl}${buildLocalizedPath(appLocale, "/blog")}` },
      { name: content.title, url: pageUrl },
    ]),
  ];
  if (content.faqs.length > 0) {
    jsonLd.push(buildFaqJsonLd(content.faqs));
  }

  return (
    <article className="space-y-6">
      <JsonLd data={jsonLd} />

      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)]">
          <Link
            href="/blog"
            className="inline-flex min-h-[48px] items-center font-semibold text-[var(--secondary)] underline"
          >
            ← {tBlog("allGuidesLink")}
          </Link>
          <span>·</span>
          <span>{tBlog("readingTime", { minutes: article.readingMinutes })}</span>
        </div>
        <h1
          className="text-3xl font-extrabold text-[var(--text)]"
          style={{ fontFamily: "var(--font-display)" }}
        >
          {content.title}
        </h1>
        <p className="text-base text-[var(--text-muted)]">{content.description}</p>
      </header>

      <div className="space-y-5 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-6 shadow-[var(--shadow)]">
        {content.sections.map((section) => (
          <section key={section.heading} className="space-y-2">
            <h2
              className="text-xl font-extrabold text-[var(--text)]"
              style={{ fontFamily: "var(--font-display)" }}
            >
              {section.heading}
            </h2>
            {section.paragraphs.map((p, idx) => (
              <p key={idx} className="text-sm leading-relaxed text-[var(--text)]">
                {p}
              </p>
            ))}
          </section>
        ))}
      </div>

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

      {content.faqs.length > 0 ? (
        <section className="space-y-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow)]">
          <h2
            className="text-lg font-extrabold text-[var(--text)]"
            style={{ fontFamily: "var(--font-display)" }}
          >
            {tSeo("faqHeading")}
          </h2>
          {content.faqs.map((faq) => (
            <div key={faq.question} className="space-y-1">
              <h3 className="text-sm font-bold text-[var(--text)]">{faq.question}</h3>
              <p className="text-sm text-[var(--text-muted)]">{faq.answer}</p>
            </div>
          ))}
        </section>
      ) : null}
    </article>
  );
}
