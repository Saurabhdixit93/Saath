"use client";

import { useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { Button, useToast } from "@saath/ui";

type GrievanceCategory =
  | "catConsent"
  | "catAccess"
  | "catErasure"
  | "catMinor"
  | "catSafety"
  | "catOther";

const CATEGORIES: GrievanceCategory[] = [
  "catConsent",
  "catAccess",
  "catErasure",
  "catMinor",
  "catSafety",
  "catOther",
];

function generateReferenceId(): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `SAATH-GRV-${yyyy}${mm}${dd}-${rand}`;
}

export function GrievanceForm() {
  const t = useTranslations("grievance");
  const { showToast } = useToast();

  const [category, setCategory] = useState<GrievanceCategory>("catConsent");
  const [subject, setSubject] = useState("");
  const [details, setDetails] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [refId, setRefId] = useState<string | null>(null);

  const handleSubmit = (ev: FormEvent) => {
    ev.preventDefault();
    setErrorMsg(null);
    if (!subject.trim() || !details.trim()) {
      setErrorMsg(t("errorMissingFields"));
      return;
    }
    setRefId(generateReferenceId());
  };

  const categoryLabel = t(category);
  const summaryText = refId
    ? `Reference: ${refId}\nCategory: ${categoryLabel}\nSubject: ${subject.trim()}\n\n${details.trim()}`
    : "";
  const mailtoHref = refId
    ? `mailto:grievance@saath.example?subject=${encodeURIComponent(
        `[${refId}] ${categoryLabel}: ${subject.trim()}`
      )}&body=${encodeURIComponent(summaryText)}`
    : "#";

  const handleCopySummary = async () => {
    if (!summaryText) return;
    try {
      await navigator.clipboard.writeText(summaryText);
      showToast({ variant: "success", message: t("copiedToast") });
    } catch {
      showToast({ variant: "info", message: summaryText });
    }
  };

  return (
    <section className="space-y-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow)]">
      <div>
        <h2
          className="text-lg font-bold text-[var(--text)]"
          style={{ fontFamily: "var(--font-display)" }}
        >
          {t("formTitle")}
        </h2>
        <p className="mt-1 text-xs text-[var(--text-muted)]">{t("formSubtitle")}</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        <div>
          <label
            htmlFor="grievance-category"
            className="mb-1.5 block text-sm font-medium text-[var(--text)]"
          >
            {t("categoryLabel")}
          </label>
          <select
            id="grievance-category"
            value={category}
            onChange={(ev) => setCategory(ev.target.value as GrievanceCategory)}
            className="min-h-[48px] w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] px-3.5 text-sm text-[var(--text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]"
          >
            {CATEGORIES.map((cat) => (
              <option key={cat} value={cat}>
                {t(cat)}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label
            htmlFor="grievance-subject"
            className="mb-1.5 block text-sm font-medium text-[var(--text)]"
          >
            {t("subjectLabel")}
          </label>
          <input
            id="grievance-subject"
            type="text"
            maxLength={120}
            value={subject}
            onChange={(ev) => {
              setSubject(ev.target.value);
              setErrorMsg(null);
            }}
            placeholder={t("subjectPlaceholder")}
            className="min-h-[48px] w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] px-3.5 text-sm text-[var(--text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]"
          />
        </div>

        <div>
          <label
            htmlFor="grievance-details"
            className="mb-1.5 block text-sm font-medium text-[var(--text)]"
          >
            {t("detailsLabel")}
          </label>
          <textarea
            id="grievance-details"
            rows={4}
            maxLength={2000}
            value={details}
            onChange={(ev) => {
              setDetails(ev.target.value);
              setErrorMsg(null);
            }}
            placeholder={t("detailsPlaceholder")}
            className="w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] p-3.5 text-sm text-[var(--text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]"
          />
        </div>

        {errorMsg ? (
          <p role="alert" className="text-sm font-medium text-[var(--danger-text)]">
            {errorMsg}
          </p>
        ) : null}

        <Button type="submit" variant="primary">
          {t("generateCta")}
        </Button>
      </form>

      {refId ? (
        <div
          role="status"
          aria-live="polite"
          className="space-y-3 rounded-[var(--radius-sm)] border border-[var(--secondary)] bg-[var(--surface-2)] p-4"
        >
          <h3 className="text-sm font-bold text-[var(--text)]">
            {t("refReadyTitle", { refId })}
          </h3>
          <p className="text-xs leading-relaxed text-[var(--text-muted)]">
            {t("refReadyBody", { refId })}
          </p>
          <div className="flex flex-wrap gap-3">
            <a
              href={mailtoHref}
              className="inline-flex min-h-[48px] items-center justify-center rounded-[var(--radius-sm)] bg-[var(--primary-btn-bg)] px-4 text-sm font-bold text-[var(--primary-ink)] hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]"
            >
              {t("sendEmailCta")}
            </a>
            <Button type="button" variant="secondary" onClick={() => void handleCopySummary()}>
              {t("copySummaryCta")}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
