import type { Metadata } from "next";
import { headers } from "next/headers";
import { hasLocale, NextIntlClientProvider } from "next-intl";
import { getMessages, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import {
  Bricolage_Grotesque,
  Inter,
  JetBrains_Mono,
  Noto_Sans_Devanagari,
} from "next/font/google";
import { ANTI_FOUC_THEME_SCRIPT } from "@saath/ui";
import { routing } from "@/i18n/routing";
import { AuthProvider } from "@/components/AuthProvider";
import { AppHeader } from "@/components/AppHeader";
import { AppFooter } from "@/components/AppFooter";
import { BottomNav } from "@/components/BottomNav";
import "../globals.css";

const bricolage = Bricolage_Grotesque({
  subsets: ["latin"],
  variable: "--font-bricolage",
  display: "swap",
});

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const devanagari = Noto_Sans_Devanagari({
  subsets: ["devanagari"],
  variable: "--font-devanagari",
  display: "swap",
});

const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Saath — Sit together. Safely.",
  description:
    "Verified peer-to-peer seat swaps for Indian trains and flights. Always free for passengers.",
  manifest: "/manifest.webmanifest",
};

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }

  setRequestLocale(locale);
  const messages = await getMessages();
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return (
    <html
      lang={locale}
      suppressHydrationWarning
      className={`${bricolage.variable} ${inter.variable} ${devanagari.variable} ${jetbrains.variable}`}
    >
      <head>
        <script
          nonce={nonce}
          dangerouslySetInnerHTML={{ __html: ANTI_FOUC_THEME_SCRIPT }}
        />
      </head>
      <body className="min-h-dvh bg-[var(--bg)] text-[var(--text)] antialiased">
        <NextIntlClientProvider messages={messages} locale={locale}>
          <AuthProvider>
            <AppHeader />
            <main className="mx-auto w-full max-w-3xl px-4 pt-6 pb-12">
              {children}
            </main>
            <AppFooter />
            <BottomNav />
          </AuthProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
