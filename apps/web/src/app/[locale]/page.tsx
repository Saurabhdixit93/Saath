import { useTranslations } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { HomeTabs } from "@/components/HomeTabs";

export default async function HomePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  return <HomeView />;
}

function HomeView() {
  const t = useTranslations("home");

  return (
    <div className="space-y-6">
      <section className="space-y-2 text-center sm:text-left">
        <h1
          className="text-3xl font-extrabold tracking-tight text-[var(--text)] sm:text-4xl"
          style={{ fontFamily: "var(--font-display)" }}
        >
          {t("headline")}
        </h1>
        <p className="text-base text-[var(--text-muted)]">{t("subtitle")}</p>
      </section>

      <HomeTabs />
    </div>
  );
}
