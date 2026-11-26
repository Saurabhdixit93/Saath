"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import QRCode from "qrcode";
import { Button } from "@saath/ui";
import type { SwapCardDTO } from "@saath/contracts";
import { Link } from "@/i18n/navigation";

export interface SwapCardProps {
  card: SwapCardDTO;
  initialLocale?: "en" | "hi";
  onDownloadPng?: (locale: "en" | "hi") => Promise<void>;
  downloadingPng?: boolean;
  offline?: boolean;
}

function formatIstTime(iso: string | null | undefined): string {
  if (!iso) return "";
  try {
    const dt = new Date(iso);
    return new Intl.DateTimeFormat("en-IN", {
      timeZone: "Asia/Kolkata",
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      numberingSystem: "latn",
    }).format(dt) + " IST";
  } catch {
    return iso;
  }
}

function buildQrPathD(value: string): { size: number; pathD: string } {
  const qr = QRCode.create(value, { errorCorrectionLevel: "M" });
  const size = qr.modules.size;
  const data = qr.modules.data;
  const cmds: string[] = [];
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (data[r * size + c]) {
        cmds.push(`M${c},${r}h1v1h-1z`);
      }
    }
  }
  return { size, pathD: cmds.join("") };
}

const CARD_COPY = {
  en: {
    header: "SAATH SWAP CARD",
    revoked: "Revoked — chart changed or invalidated",
    tteNote: "Subject to TTE approval. Thank you!",
    qrHint: "Scan to verify (no personal data shown)",
    agreedPrefix: "Agreed",
    toggleLabel: "हिंदी में दिखाएँ",
    downloadPng: "Download PNG",
    verifyLink: "Public verify link",
    offline: "Showing offline cached Swap Card.",
  },
  hi: {
    header: "साथ स्वैप कार्ड (SAATH SWAP CARD)",
    revoked: "रद्द — चार्ट बदलने से अमान्य",
    tteNote: "TTE की स्वीकृति के अधीन (Subject to TTE approval)। धन्यवाद!",
    qrHint: "सत्यापन के लिए स्कैन करें (कोई व्यक्तिगत डेटा नहीं)",
    agreedPrefix: "सहमति",
    toggleLabel: "Show in English",
    downloadPng: "PNG डाउनलोड करें",
    verifyLink: "सार्वजनिक सत्यापन लिंक",
    offline: "ऑफ़लाइन सहेजा गया स्वैप कार्ड दिखाया जा रहा है।",
  },
} as const;

export function SwapCard({
  card,
  initialLocale,
  onDownloadPng,
  downloadingPng = false,
  offline = false,
}: SwapCardProps) {
  const routeLocale = useLocale() === "hi" ? "hi" : "en";
  const t = useTranslations("swaps");
  const [cardLocale, setCardLocale] = useState<"en" | "hi">(initialLocale ?? routeLocale);
  const prevHtmlLangRef = useRef<string | null>(null);

  useEffect(() => {
    if (typeof document === "undefined") return;
    if (prevHtmlLangRef.current === null) {
      prevHtmlLangRef.current = document.documentElement.lang;
    }
    document.documentElement.lang = cardLocale;
  }, [cardLocale]);

  useEffect(() => {
    return () => {
      if (typeof document !== "undefined" && prevHtmlLangRef.current !== null) {
        document.documentElement.lang = prevHtmlLangRef.current;
      }
    };
  }, []);

  const copy = CARD_COPY[cardLocale];
  const qrGeom = useMemo(() => buildQrPathD(card.qr_url), [card.qr_url]);

  return (
    <div className="space-y-4">
      {offline ? (
        <p
          role="status"
          className="rounded-[var(--radius-sm)] border border-[var(--secondary)] bg-[var(--surface-2)] px-3 py-2 text-xs font-semibold text-[var(--text)]"
        >
          {copy.offline}
        </p>
      ) : null}

      <section
        lang={cardLocale}
        className="overflow-hidden rounded-[var(--radius)] border-2 border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow)]"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 bg-[var(--secondary)] px-5 py-4 text-[var(--secondary-ink)]">
          <div>
            <p className="text-xs font-bold tracking-wider uppercase">{copy.header}</p>
            <p
              className="text-xl font-extrabold"
              style={{ fontFamily: "var(--font-mono)" }}
            >
              #{card.public_code}
            </p>
          </div>
          <span
            className={`rounded-full px-3 py-1 text-xs font-bold ${
              card.revoked
                ? "bg-[var(--danger)] text-[var(--danger-ink)]"
                : "bg-[var(--success-btn-bg)] text-[var(--success-ink)]"
            }`}
          >
            {card.revoked ? t("verifyRevokedBadge") : "✓ Ed25519"}
          </span>
        </div>

        {card.revoked ? (
          <div
            role="alert"
            className="bg-[var(--danger)] px-5 py-2.5 text-sm font-bold text-[var(--danger-ink)]"
          >
            {copy.revoked}
          </div>
        ) : null}

        <div className="grid gap-5 p-5 sm:grid-cols-[1fr_auto]">
          <div className="space-y-4">
            <div>
              <p
                className="text-base font-bold text-[var(--text)]"
                style={{ fontFamily: "var(--font-mono)" }}
              >
                {card.service} · {card.date}
              </p>
            </div>

            <ul className="space-y-2.5">
              {card.participants.map((p, idx) => (
                <li
                  key={`${p.alias}-${idx}`}
                  className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5"
                >
                  <p
                    className="text-base font-extrabold text-[var(--text)]"
                    style={{ fontFamily: "var(--font-mono)" }}
                  >
                    {p.from_seat} ⇄ {p.to_seat}
                  </p>
                  <p className="text-xs text-[var(--text-muted)]">
                    {p.alias}
                    {p.decided_at ? ` · ${copy.agreedPrefix} ${formatIstTime(p.decided_at)}` : ""}
                  </p>
                </li>
              ))}
            </ul>

            <p className="text-sm font-semibold text-[var(--secondary)]">{copy.tteNote}</p>
          </div>

          <div className="flex flex-col items-center justify-center gap-2 rounded-[var(--radius-sm)] border border-[var(--border)] bg-white p-3 text-[#1C1A17]">
            <svg
              viewBox={`-2 -2 ${qrGeom.size + 4} ${qrGeom.size + 4}`}
              className="h-36 w-36"
              role="img"
              aria-label={`QR code for ${card.public_code}`}
            >
              <rect
                x={-2}
                y={-2}
                width={qrGeom.size + 4}
                height={qrGeom.size + 4}
                fill="#FFFFFF"
              />
              <path d={qrGeom.pathD} fill="#1C1A17" />
            </svg>
            <p className="max-w-[160px] text-center text-[11px] font-medium text-[#6B645A]">
              {copy.qrHint}
            </p>
          </div>
        </div>
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="secondary"
          onClick={() => setCardLocale((prev) => (prev === "en" ? "hi" : "en"))}
        >
          {copy.toggleLabel}
        </Button>

        {onDownloadPng ? (
          <Button
            variant="primary"
            loading={downloadingPng}
            onClick={() => void onDownloadPng(cardLocale)}
          >
            {copy.downloadPng}
          </Button>
        ) : null}

        <Link
          href={`/v/${card.public_code}`}
          className="inline-flex min-h-[48px] items-center justify-center rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-4 text-sm font-semibold text-[var(--text)] hover:bg-[var(--surface-2)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]"
        >
          {copy.verifyLink}
        </Link>
      </div>
    </div>
  );
}
