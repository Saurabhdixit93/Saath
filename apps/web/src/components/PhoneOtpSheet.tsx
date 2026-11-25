"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { BottomSheet, Button, useToast } from "@saath/ui";
import { parseProblemDetail } from "@saath/contracts";
import { publicEnv } from "@/lib/env";
import { useAuth } from "./AuthProvider";
import { TurnstileWidget } from "./TurnstileWidget";

const indianPhoneSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s\-()]+/g, ""))
  .refine((v) => /^[6-9][0-9]{9}$/.test(v), { message: "invalid_phone" });

const otpCodeSchema = z
  .string()
  .trim()
  .refine((v) => /^[0-9]{6}$/.test(v), { message: "invalid_otp" });

export function normalizePhoneInput(raw: string): string {
  let digits = raw.replace(/\D/g, "");
  if (digits.length >= 12 && digits.startsWith("91")) {
    digits = digits.slice(2);
  } else if (digits.length === 11 && digits.startsWith("0")) {
    digits = digits.slice(1);
  }
  return digits.slice(0, 10);
}

export interface PhoneOtpSheetProps {
  open: boolean;
  onClose: () => void;
}

export function PhoneOtpSheet({ open, onClose }: PhoneOtpSheetProps) {
  const t = useTranslations("auth");
  const tCommon = useTranslations("common");
  const locale = useLocale() === "hi" ? "hi" : "en";
  const queryClient = useQueryClient();
  const { apiClient, setUserSession } = useAuth();
  const { showToast } = useToast();

  const [step, setStep] = useState<"phone" | "otp">("phone");
  const [phone, setPhone] = useState("");
  const [channel, setChannel] = useState<"whatsapp" | "sms">("whatsapp");
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileResetKey, setTurnstileResetKey] = useState(0);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [otpCode, setOtpCode] = useState("");
  const [resendSeconds, setResendSeconds] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const resetForm = useCallback(() => {
    setStep("phone");
    setOtpCode("");
    setRequestId(null);
    setResendSeconds(0);
    setErrorMsg(null);
    setSubmitting(false);
  }, []);

  useEffect(() => {
    if (!open) {
      resetForm();
    }
  }, [open, resetForm]);

  useEffect(() => {
    if (resendSeconds <= 0) {
      return;
    }
    const timer = window.setInterval(() => {
      setResendSeconds((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [resendSeconds]);

  // WebOTP auto-read when SMS OTP step is active
  useEffect(() => {
    if (!open || step !== "otp" || typeof navigator === "undefined" || !("credentials" in navigator)) {
      return;
    }
    const controller = new AbortController();
    const creds = navigator.credentials as unknown as {
      get?: (opts: Record<string, unknown>) => Promise<{ code?: string } | null>;
    };
    if (typeof creds.get === "function") {
      creds
        .get({
          otp: { transport: ["sms"] },
          signal: controller.signal,
        })
        .then((otp) => {
          if (otp?.code && /^\d{6}$/.test(otp.code)) {
            setOtpCode(otp.code);
          }
        })
        .catch(() => {
          // Ignore abort / unsupported browser errors
        });
    }
    return () => controller.abort();
  }, [open, step]);

  const mapProblemMessage = (code?: string, detail?: string): string => {
    switch (code) {
      case "rate_limited":
      case "otp_resend_cooldown":
        return t("errRateLimit");
      case "otp_invalid":
        return t("errInvalidOtp");
      case "otp_expired":
        return t("errExpiredOtp");
      case "otp_max_attempts":
        return t("errMaxAttempts");
      case "invalid_phone":
        return t("phoneInvalid");
      case "turnstile_failed":
        return t("errTurnstile");
      case "messaging_unavailable":
        return t("errMessagingUnavailable");
      default:
        return detail || t("errRateLimit");
    }
  };

  const resetTurnstileIfCloudflare = useCallback(() => {
    if (publicEnv.NEXT_PUBLIC_TURNSTILE_MODE === "cloudflare") {
      setTurnstileToken(null);
      setTurnstileResetKey((prev) => prev + 1);
    }
  }, []);

  const handleStartOtp = async (e?: FormEvent) => {
    e?.preventDefault();
    setErrorMsg(null);

    const parsed = indianPhoneSchema.safeParse(phone);
    if (!parsed.success) {
      setErrorMsg(t("phoneInvalid"));
      return;
    }
    if (!turnstileToken) {
      setErrorMsg(t("turnstileWaiting"));
      return;
    }

    setSubmitting(true);
    try {
      const { data, error } = await apiClient.POST("/v1/auth/otp/start", {
        body: {
          phone: parsed.data,
          channel,
          turnstile: turnstileToken,
          locale,
        },
      });
      if (error || !data) {
        const problem = parseProblemDetail(error);
        setErrorMsg(mapProblemMessage(problem?.code, problem?.detail));
        resetTurnstileIfCloudflare();
        return;
      }
      setPhone(parsed.data);
      setRequestId(data.request_id);
      setResendSeconds(data.resend_after);
      setStep("otp");
      resetTurnstileIfCloudflare();
    } catch {
      setErrorMsg(t("errRateLimit"));
      resetTurnstileIfCloudflare();
    } finally {
      setSubmitting(false);
    }
  };

  const handleVerifyOtp = async (e: FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    const parsedOtp = otpCodeSchema.safeParse(otpCode);
    if (!parsedOtp.success || !requestId) {
      setErrorMsg(t("errInvalidOtp"));
      return;
    }

    setSubmitting(true);
    try {
      const { data, error } = await apiClient.POST("/v1/auth/otp/verify", {
        body: {
          request_id: requestId,
          code: parsedOtp.data,
        },
      });
      if (error || !data) {
        const problem = parseProblemDetail(error);
        setErrorMsg(mapProblemMessage(problem?.code, problem?.detail));
        return;
      }

      setUserSession({
        access: data.access,
        refresh: data.refresh,
        user: data.user,
      });
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      showToast({ variant: "success", message: t("otpSuccess") });
      onClose();
    } catch {
      setErrorMsg(t("errInvalidOtp"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={t("sheetTitle")}
      description={t("sheetDescription")}
      closeLabel={tCommon("close")}
    >
      {step === "phone" ? (
        <form onSubmit={handleStartOtp} className="space-y-4" noValidate>
          <div>
            <label
              htmlFor="saath-phone-input"
              className="mb-1.5 block text-sm font-medium text-[var(--text)]"
            >
              {t("phoneLabel")}
            </label>
            <div className="flex items-stretch overflow-hidden rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--focus-ring)]">
              <span
                aria-hidden="true"
                className="flex items-center border-r border-[var(--border)] bg-[var(--surface-2)] px-3 text-base font-semibold text-[var(--text)]"
                style={{ fontFamily: "var(--font-mono)" }}
              >
                +91
              </span>
              <input
                id="saath-phone-input"
                type="tel"
                inputMode="numeric"
                autoComplete="tel-national"
                value={phone}
                onChange={(ev) => setPhone(normalizePhoneInput(ev.target.value))}
                placeholder={t("phonePlaceholder")}
                className="min-h-[48px] w-full bg-transparent px-3 text-base text-[var(--text)] outline-none"
                style={{ fontFamily: "var(--font-mono)" }}
              />
            </div>
          </div>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-[var(--text)]">
              {t("channelLabel")}
            </legend>
            <div className="grid grid-cols-2 gap-2">
              <label
                className={`flex min-h-[48px] cursor-pointer items-center gap-2 rounded-[var(--radius-sm)] border px-3 text-sm font-medium ${
                  channel === "whatsapp"
                    ? "border-[var(--secondary)] bg-[var(--surface-2)] text-[var(--text)]"
                    : "border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)]"
                }`}
              >
                <input
                  type="radio"
                  name="otp-channel"
                  value="whatsapp"
                  checked={channel === "whatsapp"}
                  onChange={() => setChannel("whatsapp")}
                  className="h-4 w-4 accent-[var(--secondary)]"
                />
                <span>{t("channelWhatsapp")}</span>
              </label>

              <label
                className={`flex min-h-[48px] cursor-pointer items-center gap-2 rounded-[var(--radius-sm)] border px-3 text-sm font-medium ${
                  channel === "sms"
                    ? "border-[var(--secondary)] bg-[var(--surface-2)] text-[var(--text)]"
                    : "border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)]"
                }`}
              >
                <input
                  type="radio"
                  name="otp-channel"
                  value="sms"
                  checked={channel === "sms"}
                  onChange={() => setChannel("sms")}
                  className="h-4 w-4 accent-[var(--secondary)]"
                />
                <span>{t("channelSms")}</span>
              </label>
            </div>
          </fieldset>

          <TurnstileWidget resetKey={turnstileResetKey} onToken={setTurnstileToken} />

          {errorMsg ? (
            <p role="alert" className="text-sm font-medium text-[var(--danger-text)]">
              {errorMsg}
            </p>
          ) : null}

          <Button type="submit" fullWidth loading={submitting}>
            {t("sendOtpCta")}
          </Button>
        </form>
      ) : (
        <form onSubmit={handleVerifyOtp} className="space-y-4" noValidate>
          <p className="text-sm text-[var(--text-muted)]">
            {t("otpHint", { phone })}
          </p>

          <div>
            <label
              htmlFor="saath-otp-input"
              className="mb-1.5 block text-sm font-medium text-[var(--text)]"
            >
              {t("otpLabel")}
            </label>
            <input
              id="saath-otp-input"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={otpCode}
              onChange={(ev) => setOtpCode(ev.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder={t("otpPlaceholder")}
              className="min-h-[52px] w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-4 text-center text-2xl tracking-[0.4em] text-[var(--text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]"
              style={{ fontFamily: "var(--font-mono)" }}
            />
          </div>

          {errorMsg ? (
            <p role="alert" className="text-sm font-medium text-[var(--danger-text)]">
              {errorMsg}
            </p>
          ) : null}

          {publicEnv.NEXT_PUBLIC_TURNSTILE_MODE === "cloudflare" ? (
            <TurnstileWidget resetKey={turnstileResetKey} onToken={setTurnstileToken} />
          ) : null}

          <Button type="submit" fullWidth loading={submitting}>
            {t("verifyOtpCta")}
          </Button>

          <div className="flex items-center justify-between gap-2 pt-1">
            <Button
              variant="ghost"
              onClick={() => {
                setStep("phone");
                setOtpCode("");
                setErrorMsg(null);
                setTurnstileResetKey((prev) => prev + 1);
              }}
            >
              {t("changeNumber")}
            </Button>

            <Button
              variant="ghost"
              disabled={resendSeconds > 0 || submitting}
              onClick={() => {
                if (publicEnv.NEXT_PUBLIC_TURNSTILE_MODE === "cloudflare" && !turnstileToken) {
                  setTurnstileResetKey((prev) => prev + 1);
                  setErrorMsg(t("turnstileWaiting"));
                  return;
                }
                void handleStartOtp();
              }}
            >
              {resendSeconds > 0
                ? t("resendWait", { seconds: resendSeconds })
                : t("resendReady")}
            </Button>
          </div>
        </form>
      )}
    </BottomSheet>
  );
}
