"use client";

import {
  useRef,
  useState,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { useTranslations } from "next-intl";
import { BottomSheet, Button, EmptyState, useToast } from "@saath/ui";
import { parsePnrInput } from "@/lib/pnr";
import { useAuth } from "./AuthProvider";

type ModeTab = "train" | "flight" | "bus";
type InfoSheetKey = "how" | "safety" | "tools" | "faq" | null;

const MODES: ModeTab[] = ["train", "flight", "bus"];

export function HomeTabs() {
  const t = useTranslations("home");
  const tCommon = useTranslations("common");
  const { ensureAuth } = useAuth();
  const { showToast } = useToast();

  const [activeMode, setActiveMode] = useState<ModeTab>("train");
  const [pnrText, setPnrText] = useState("");
  const [pnrHint, setPnrHint] = useState<string | null>(null);
  const [pnrError, setPnrError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [flightMessage, setFlightMessage] = useState<string | null>(null);
  const [infoSheet, setInfoSheet] = useState<InfoSheetKey>(null);

  const tabRefs = useRef<Record<ModeTab, HTMLButtonElement | null>>({
    train: null,
    flight: null,
    bus: null,
  });

  const handleTabKeyDown = (ev: KeyboardEvent<HTMLButtonElement>, idx: number) => {
    let nextIdx: number | null = null;
    if (ev.key === "ArrowRight") {
      nextIdx = (idx + 1) % MODES.length;
    } else if (ev.key === "ArrowLeft") {
      nextIdx = (idx - 1 + MODES.length) % MODES.length;
    }
    if (nextIdx !== null) {
      ev.preventDefault();
      const nextMode = MODES[nextIdx];
      if (nextMode) {
        setActiveMode(nextMode);
        tabRefs.current[nextMode]?.focus();
      }
    }
  };

  const applyPnrValue = (value: string, isPaste = false) => {
    setPnrError(null);
    setStatusMessage(null);
    const parsed = parsePnrInput(value);
    if (parsed.isValid && parsed.pnr && (parsed.extractedFromSms || isPaste)) {
      setPnrText(parsed.pnr);
      setPnrHint(t("pnrExtracted", { pnr: parsed.pnr }));
      return;
    }
    setPnrHint(null);
    if (/^\d{0,10}$/.test(value.trim())) {
      setPnrText(value.trim());
    } else {
      setPnrText(value);
    }
  };

  const handlePnrPaste = (ev: ClipboardEvent<HTMLInputElement>) => {
    const pasted = ev.clipboardData.getData("text");
    const parsed = parsePnrInput(pasted);
    if (parsed.isValid && parsed.pnr) {
      ev.preventDefault();
      setPnrText(parsed.pnr);
      setPnrError(null);
      setPnrHint(t("pnrExtracted", { pnr: parsed.pnr }));
    }
  };

  const handleVerifyTrain = async (ev: FormEvent) => {
    ev.preventDefault();
    setPnrError(null);
    setStatusMessage(null);

    const parsed = parsePnrInput(pnrText);
    if (!parsed.isValid || !parsed.pnr) {
      setPnrError(t("pnrInvalid"));
      return;
    }
    setPnrText(parsed.pnr);
    await ensureAuth();
    const readyMsg = t("trainSessionReady", { pnr: parsed.pnr });
    setStatusMessage(readyMsg);
    showToast({ variant: "info", message: readyMsg });
  };

  const sheetCopy =
    infoSheet === "how"
      ? { title: t("sheetHowTitle"), body: t("sheetHowBody") }
      : infoSheet === "safety"
        ? { title: t("sheetSafetyTitle"), body: t("sheetSafetyBody") }
        : infoSheet === "tools"
          ? { title: t("sheetToolsTitle"), body: t("sheetToolsBody") }
          : infoSheet === "faq"
            ? { title: t("sheetFaqTitle"), body: t("sheetFaqBody") }
            : null;

  return (
    <div className="space-y-6">
      <div
        role="tablist"
        aria-label={t("modeTabsLabel")}
        className="grid grid-cols-3 gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-2)] p-1.5"
      >
        {MODES.map((mode, idx) => {
          const selected = activeMode === mode;
          const label =
            mode === "train"
              ? t("tabTrain")
              : mode === "flight"
                ? t("tabFlight")
                : t("tabBus");
          return (
            <button
              key={mode}
              ref={(el) => {
                tabRefs.current[mode] = el;
              }}
              id={`tab-${mode}`}
              role="tab"
              type="button"
              aria-selected={selected}
              aria-controls={`panel-${mode}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActiveMode(mode)}
              onKeyDown={(ev) => handleTabKeyDown(ev, idx)}
              className={`min-h-[48px] rounded-[var(--radius-sm)] px-3 text-sm font-semibold transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)] ${
                selected
                  ? "bg-[var(--surface)] text-[var(--primary-text)] shadow-sm"
                  : "text-[var(--text-muted)] hover:text-[var(--text)]"
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>

      {activeMode === "train" ? (
        <section
          id="panel-train"
          role="tabpanel"
          aria-labelledby="tab-train"
          className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow)]"
        >
          <form onSubmit={handleVerifyTrain} className="space-y-3" noValidate>
            <label
              htmlFor="pnr-input"
              className="block text-sm font-semibold text-[var(--text)]"
            >
              {t("pnrLabel")}
            </label>
            <div className="flex flex-col gap-3 sm:flex-row">
              <input
                id="pnr-input"
                type="text"
                inputMode="numeric"
                value={pnrText}
                onPaste={handlePnrPaste}
                onChange={(ev) => applyPnrValue(ev.target.value)}
                placeholder={t("pnrPlaceholder")}
                className="min-h-[48px] flex-1 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] px-4 text-lg tracking-wider text-[var(--text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]"
                style={{ fontFamily: "var(--font-mono)" }}
              />
              <Button type="submit" variant="primary" className="shrink-0">
                {t("verifyCta")}
              </Button>
            </div>

            {pnrHint ? (
              <p className="text-sm font-medium text-[var(--secondary)]">
                {pnrHint}
              </p>
            ) : null}
            {pnrError ? (
              <p role="alert" className="text-sm font-medium text-[var(--danger-text)]">
                {pnrError}
              </p>
            ) : null}
            {statusMessage ? (
              <p
                role="status"
                className="rounded-[var(--radius-sm)] border border-[var(--secondary)] bg-[var(--surface-2)] px-3.5 py-2.5 text-sm text-[var(--text)]"
              >
                {statusMessage}
              </p>
            ) : null}
          </form>
        </section>
      ) : null}

      {activeMode === "flight" ? (
        <section
          id="panel-flight"
          role="tabpanel"
          aria-labelledby="tab-flight"
          className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow)]"
        >
          <div className="flex flex-col gap-3 sm:flex-row">
            <Button
              variant="primary"
              fullWidth
              onClick={() => setFlightMessage(t("flightScaffoldHint"))}
            >
              {t("flightScanCta")}
            </Button>
            <Button
              variant="ghost"
              fullWidth
              onClick={() => setFlightMessage(t("flightScaffoldHint"))}
            >
              {t("flightManualCta")}
            </Button>
          </div>
          {flightMessage ? (
            <p
              role="status"
              className="mt-3 rounded-[var(--radius-sm)] bg-[var(--surface-2)] px-3.5 py-2.5 text-sm text-[var(--text-muted)]"
            >
              {flightMessage}
            </p>
          ) : null}
        </section>
      ) : null}

      {activeMode === "bus" ? (
        <section
          id="panel-bus"
          role="tabpanel"
          aria-labelledby="tab-bus"
        >
          <EmptyState
            title={t("busTitle")}
            description={t("busDescription")}
            primaryAction={
              <Button variant="secondary" onClick={() => setActiveMode("train")}>
                {t("busBackCta")}
              </Button>
            }
          />
        </section>
      ) : null}

      <div className="flex items-start gap-2.5 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3 text-sm text-[var(--text)]">
        <svg
          className="mt-0.5 h-5 w-5 shrink-0 text-[var(--secondary)]"
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden="true"
        >
          <path
            fillRule="evenodd"
            d="M10 1a4.5 4.5 0 00-4.5 4.5V9H5a2 2 0 00-2 2v6a2 2 0 002 2h10a2 2 0 002-2v-6a2 2 0 00-2-2h-.5V5.5A4.5 4.5 0 0010 1zm3 8V5.5a3 3 0 10-6 0V9h6z"
            clipRule="evenodd"
          />
        </svg>
        <p>{t("privacyBanner")}</p>
      </div>

      <p className="text-center text-xs font-medium text-[var(--text-muted)]">
        {t("liveTicker")}
      </p>

      <div className="flex flex-wrap justify-center gap-2">
        <Button variant="ghost" onClick={() => setInfoSheet("how")}>
          {t("chipHowItWorks")}
        </Button>
        <Button variant="ghost" onClick={() => setInfoSheet("safety")}>
          {t("chipSafety")}
        </Button>
        <Button variant="ghost" onClick={() => setInfoSheet("tools")}>
          {t("chipTools")}
        </Button>
        <Button variant="ghost" onClick={() => setInfoSheet("faq")}>
          {t("chipFaq")}
        </Button>
      </div>

      <BottomSheet
        open={sheetCopy !== null}
        onClose={() => setInfoSheet(null)}
        title={sheetCopy?.title ?? ""}
        closeLabel={tCommon("close")}
      >
        <p className="text-sm leading-relaxed text-[var(--text-muted)]">
          {sheetCopy?.body}
        </p>
      </BottomSheet>
    </div>
  );
}
