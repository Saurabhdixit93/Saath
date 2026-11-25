"use client";

import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@saath/ui";
import { AIRCRAFT_LAYOUTS } from "@/lib/aircraftLayouts";
import {
  decodeBoardingPassFromFile,
  decodeBoardingPassFromImageData,
  previewBcbp,
} from "@/lib/bcbp";

export interface BoardingPassSubmitPayload {
  mode: "flight";
  bcbp?: string;
  leg_index?: number;
  declared?: {
    flight_no: string;
    date: string;
    seat: string;
    layout_ref?: string;
  };
}

export function BoardingPassScanner({
  onSubmit,
  loading = false,
  error = null,
}: {
  onSubmit: (payload: BoardingPassSubmitPayload) => Promise<void> | void;
  loading?: boolean;
  error?: string | null;
}) {
  const t = useTranslations("flight");
  const [mode, setMode] = useState<"scan" | "declared">("scan");
  const [bcbpText, setBcbpText] = useState("");
  const [legIndex, setLegIndex] = useState(0);
  const [decodeError, setDecodeError] = useState<string | null>(null);
  const [cameraActive, setCameraActive] = useState(false);
  const [torchOn, setTorchOn] = useState(false);

  const [flightNo, setFlightNo] = useState("");
  const [travelDate, setTravelDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [seat, setSeat] = useState("");
  const [layoutRef, setLayoutRef] = useState("6E:A320neo");

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scanIntervalRef = useRef<number | null>(null);

  const stopCamera = () => {
    if (scanIntervalRef.current !== null) {
      window.clearInterval(scanIntervalRef.current);
      scanIntervalRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((tr) => tr.stop());
      streamRef.current = null;
    }
    setCameraActive(false);
    setTorchOn(false);
  };

  useEffect(() => {
    return () => stopCamera();
  }, []);

  const startCamera = async () => {
    setDecodeError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
      });
      streamRef.current = stream;
      setCameraActive(true);
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      scanIntervalRef.current = window.setInterval(async () => {
        const video = videoRef.current;
        if (!video || video.videoWidth === 0) return;
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(video, 0, 0);
        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const decoded = await decodeBoardingPassFromImageData(imgData);
        if (decoded) {
          setBcbpText(decoded);
          setLegIndex(0);
          stopCamera();
        }
      }, 600);
    } catch {
      setDecodeError(t("decodeFailed"));
      stopCamera();
    }
  };

  const toggleTorch = async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const next = !torchOn;
    try {
      await track.applyConstraints({
        advanced: [{ torch: next } as MediaTrackConstraintSet],
      });
      setTorchOn(next);
    } catch {
      // Torch unsupported on some devices
    }
  };

  const handleFileUpload = async (ev: ChangeEvent<HTMLInputElement>) => {
    const file = ev.target.files?.[0];
    if (!file) return;
    setDecodeError(null);
    try {
      const decoded = await decodeBoardingPassFromFile(file);
      if (!decoded) {
        setDecodeError(t("decodeFailed"));
        return;
      }
      setBcbpText(decoded);
      setLegIndex(0);
    } catch {
      setDecodeError(t("decodeFailed"));
    }
  };

  const preview = previewBcbp(bcbpText.trim());

  const handleSubmitBcbp = async (ev: FormEvent) => {
    ev.preventDefault();
    if (!bcbpText.trim()) {
      setDecodeError(t("decodeFailed"));
      return;
    }
    await onSubmit({
      mode: "flight",
      bcbp: bcbpText.trim(),
      leg_index: legIndex,
    });
  };

  const handleSubmitDeclared = async (ev: FormEvent) => {
    ev.preventDefault();
    await onSubmit({
      mode: "flight",
      declared: {
        flight_no: flightNo.trim().toUpperCase(),
        date: travelDate,
        seat: seat.trim().toUpperCase(),
        layout_ref: layoutRef,
      },
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant={mode === "scan" ? "primary" : "ghost"}
          onClick={() => setMode("scan")}
        >
          {t("scannerTitle")}
        </Button>
        <Button
          type="button"
          variant={mode === "declared" ? "primary" : "ghost"}
          onClick={() => setMode("declared")}
        >
          {t("declaredTitle")}
        </Button>
      </div>

      {mode === "scan" ? (
        <form onSubmit={handleSubmitBcbp} className="space-y-3">
          <p className="text-xs font-medium text-[var(--secondary)]">
            {t("scannerPrivacy")}
          </p>

          <div className="flex flex-wrap gap-2">
            {!cameraActive ? (
              <Button type="button" variant="secondary" onClick={() => void startCamera()}>
                {t("startCamera")}
              </Button>
            ) : (
              <>
                <Button type="button" variant="ghost" onClick={stopCamera}>
                  {t("stopCamera")}
                </Button>
                <Button type="button" variant="ghost" onClick={() => void toggleTorch()}>
                  {torchOn ? t("torchOff") : t("torchOn")}
                </Button>
              </>
            )}

            <label className="inline-flex min-h-[48px] cursor-pointer items-center justify-center rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-4 text-sm font-semibold text-[var(--text)] hover:opacity-90">
              <span>{t("uploadLabel")}</span>
              <input
                type="file"
                accept="image/*,application/pdf"
                onChange={(ev) => void handleFileUpload(ev)}
                className="sr-only"
              />
            </label>
          </div>

          {cameraActive ? (
            <video
              ref={videoRef}
              playsInline
              muted
              className="w-full max-h-56 rounded-[var(--radius-sm)] border border-[var(--border)] bg-black object-cover"
            />
          ) : null}

          <div>
            <label
              htmlFor="bcbp-text-input"
              className="mb-1 block text-xs font-semibold text-[var(--text)]"
            >
              {t("pasteBcbpLabel")}
            </label>
            <textarea
              id="bcbp-text-input"
              rows={2}
              value={bcbpText}
              onChange={(ev) => {
                setBcbpText(ev.target.value);
                setDecodeError(null);
              }}
              placeholder={t("pasteBcbpPlaceholder")}
              className="w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] p-3 text-xs text-[var(--text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]"
              style={{ fontFamily: "var(--font-mono)" }}
            />
          </div>

          {preview && preview.legs.length > 1 ? (
            <div>
              <label
                htmlFor="bcbp-leg-select"
                className="mb-1 block text-xs font-semibold text-[var(--text)]"
              >
                {t("selectLegLabel")}
              </label>
              <select
                id="bcbp-leg-select"
                value={legIndex}
                onChange={(ev) => setLegIndex(Number(ev.target.value))}
                className="min-h-[48px] w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] px-3 text-sm text-[var(--text)]"
              >
                {preview.legs.map((leg) => (
                  <option key={leg.legIndex} value={leg.legIndex}>
                    {leg.flightNo} · {leg.fromIata} → {leg.toIata} (Seat {leg.seatNo})
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {decodeError || error ? (
            <p role="alert" className="text-sm font-medium text-[var(--danger-text)]">
              {decodeError || error}
            </p>
          ) : null}

          <Button type="submit" variant="primary" loading={loading} fullWidth>
            {t("verifyPassCta")}
          </Button>
        </form>
      ) : (
        <form onSubmit={handleSubmitDeclared} className="space-y-3">
          <div className="rounded-[var(--radius-sm)] border border-[var(--warning)] bg-[var(--surface-2)] px-3 py-2 text-xs font-medium text-[var(--text)]">
            <span className="font-bold">{t("declaredBadge")}: </span>
            {t("declaredHint")}
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label
                htmlFor="declared-flight-no"
                className="mb-1 block text-xs font-semibold text-[var(--text)]"
              >
                {t("flightNoLabel")}
              </label>
              <input
                id="declared-flight-no"
                type="text"
                required
                value={flightNo}
                onChange={(ev) => setFlightNo(ev.target.value)}
                placeholder={t("flightNoPlaceholder")}
                className="min-h-[48px] w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] px-3 text-sm text-[var(--text)]"
              />
            </div>

            <div>
              <label
                htmlFor="declared-date"
                className="mb-1 block text-xs font-semibold text-[var(--text)]"
              >
                {t("dateLabel")}
              </label>
              <input
                id="declared-date"
                type="date"
                required
                value={travelDate}
                onChange={(ev) => setTravelDate(ev.target.value)}
                className="min-h-[48px] w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] px-3 text-sm text-[var(--text)]"
              />
            </div>

            <div>
              <label
                htmlFor="declared-seat"
                className="mb-1 block text-xs font-semibold text-[var(--text)]"
              >
                {t("seatLabel")}
              </label>
              <input
                id="declared-seat"
                type="text"
                required
                value={seat}
                onChange={(ev) => setSeat(ev.target.value)}
                placeholder={t("seatPlaceholder")}
                className="min-h-[48px] w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] px-3 text-sm text-[var(--text)]"
              />
            </div>

            <div>
              <label
                htmlFor="declared-layout"
                className="mb-1 block text-xs font-semibold text-[var(--text)]"
              >
                {t("layoutLabel")}
              </label>
              <select
                id="declared-layout"
                value={layoutRef}
                onChange={(ev) => setLayoutRef(ev.target.value)}
                className="min-h-[48px] w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] px-3 text-sm text-[var(--text)]"
              >
                {Object.values(AIRCRAFT_LAYOUTS).map((layout) => (
                  <option key={layout.layoutRef} value={layout.layoutRef}>
                    {layout.aircraftName}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {error ? (
            <p role="alert" className="text-sm font-medium text-[var(--danger-text)]">
              {error}
            </p>
          ) : null}

          <Button type="submit" variant="primary" loading={loading} fullWidth>
            {t("verifyDeclaredCta")}
          </Button>
        </form>
      )}
    </div>
  );
}
