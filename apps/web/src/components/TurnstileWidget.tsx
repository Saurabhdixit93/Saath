"use client";

import { useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import { publicEnv } from "@/lib/env";

declare global {
  interface Window {
    turnstile?: {
      render: (
        el: HTMLElement,
        opts: {
          sitekey: string;
          callback: (token: string) => void;
          "expired-callback"?: () => void;
          "error-callback"?: () => void;
        }
      ) => string;
      remove?: (id: string) => void;
    };
  }
}

export interface TurnstileWidgetProps {
  onToken: (token: string | null) => void;
  resetKey?: number;
}

export function TurnstileWidget({ onToken, resetKey = 0 }: TurnstileWidgetProps) {
  const t = useTranslations("auth");
  const containerRef = useRef<HTMLDivElement>(null);
  const mode = publicEnv.NEXT_PUBLIC_TURNSTILE_MODE;
  const siteKey = publicEnv.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

  useEffect(() => {
    if (mode === "fake" || !siteKey) {
      onToken("fake-turnstile-token");
      return;
    }

    onToken(null);
    let widgetId: string | null = null;
    let active = true;

    const mountWidget = () => {
      if (!active || !containerRef.current || !window.turnstile) {
        return;
      }
      widgetId = window.turnstile.render(containerRef.current, {
        sitekey: siteKey,
        callback: (tok) => onToken(tok),
        "expired-callback": () => onToken(null),
        "error-callback": () => onToken(null),
      });
    };

    if (window.turnstile) {
      mountWidget();
    } else {
      const existing = document.querySelector<HTMLScriptElement>(
        'script[src*="challenges.cloudflare.com/turnstile"]'
      );
      if (!existing) {
        const script = document.createElement("script");
        script.src =
          "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
        script.async = true;
        script.defer = true;
        script.onload = mountWidget;
        document.head.appendChild(script);
      } else {
        existing.addEventListener("load", mountWidget, { once: true });
      }
    }

    return () => {
      active = false;
      if (widgetId && window.turnstile?.remove) {
        window.turnstile.remove(widgetId);
      }
    };
  }, [mode, onToken, resetKey, siteKey]);

  if (mode === "fake" || !siteKey) {
    return (
      <div
        data-testid="turnstile-fake-badge"
        className="flex items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs text-[var(--text-muted)]"
      >
        <span
          aria-hidden="true"
          className="inline-block h-2.5 w-2.5 rounded-full bg-[var(--success)]"
        />
        <span>{t("turnstileVerified")}</span>
      </div>
    );
  }

  return (
    <div>
      <div ref={containerRef} aria-label={t("turnstileWaiting")} />
    </div>
  );
}
