"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { cn } from "../cn";

export type ToastVariant = "info" | "success" | "warning" | "error";

export interface ToastItem {
  id: string;
  variant: ToastVariant;
  message: string;
  duration?: number;
  dismissLabel?: string;
}

interface ToastStyleSpec {
  container: string;
  label: string;
  icon: ReactNode;
}

const TOAST_STYLES: Record<ToastVariant, ToastStyleSpec> = {
  info: {
    container: "bg-[var(--surface)] text-[var(--text)] border-[var(--secondary)]",
    label: "Info",
    icon: (
      <svg className="h-5 w-5 shrink-0 text-[var(--secondary)]" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
        <path
          fillRule="evenodd"
          d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a.75.75 0 000 1.5h.253a.25.25 0 01.244.304l-.459 2.066A1.75 1.75 0 0010.747 15H11a.75.75 0 000-1.5h-.253a.25.25 0 01-.244-.304l.459-2.066A1.75 1.75 0 009.253 9H9z"
          clipRule="evenodd"
        />
      </svg>
    ),
  },
  success: {
    container: "bg-[var(--success-btn-bg)] text-[var(--success-ink)] border-transparent",
    label: "Success",
    icon: (
      <svg className="h-5 w-5 shrink-0" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
        <path
          fillRule="evenodd"
          d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z"
          clipRule="evenodd"
        />
      </svg>
    ),
  },
  warning: {
    container: "bg-[var(--warning)] text-[var(--warning-ink)] border-transparent",
    label: "Warning",
    icon: (
      <svg className="h-5 w-5 shrink-0" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
        <path
          fillRule="evenodd"
          d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z"
          clipRule="evenodd"
        />
      </svg>
    ),
  },
  error: {
    container: "bg-[var(--danger)] text-[var(--danger-ink)] border-transparent",
    label: "Error",
    icon: (
      <svg className="h-5 w-5 shrink-0" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
        <path
          fillRule="evenodd"
          d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z"
          clipRule="evenodd"
        />
      </svg>
    ),
  },
};

export interface ToastProps {
  toastId?: string;
  variant?: ToastVariant;
  message: string;
  onDismiss?: () => void;
  onDismissById?: (id: string) => void;
  dismissLabel?: string;
  duration?: number;
}

export function Toast({
  toastId,
  variant = "info",
  message,
  onDismiss,
  onDismissById,
  dismissLabel = "Dismiss notification",
  duration = 5000,
}: ToastProps) {
  const [paused, setPaused] = useState(false);
  const spec = TOAST_STYLES[variant];
  const isError = variant === "error";
  const hasDismissHandler = Boolean(onDismiss || (toastId && onDismissById));

  const dismissRef = useRef<() => void>(() => {});
  dismissRef.current = () => {
    if (toastId && onDismissById) {
      onDismissById(toastId);
    } else {
      onDismiss?.();
    }
  };

  useEffect(() => {
    if (!hasDismissHandler || duration === 0 || paused) {
      return;
    }
    const timer = window.setTimeout(() => dismissRef.current(), duration);
    return () => window.clearTimeout(timer);
  }, [duration, hasDismissHandler, paused]);

  return (
    <div
      role={isError ? "alert" : "status"}
      aria-live={isError ? "assertive" : "polite"}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      className={cn(
        "flex items-center justify-between gap-3 rounded-[var(--radius-sm)] border px-4 py-2 shadow-[var(--shadow)]",
        spec.container
      )}
    >
      <div className="flex items-center gap-2.5 text-sm font-medium">
        {spec.icon}
        <span className="sr-only">{spec.label}: </span>
        <span>{message}</span>
      </div>
      {hasDismissHandler ? (
        <button
          type="button"
          onClick={() => dismissRef.current()}
          aria-label={dismissLabel}
          className="inline-flex min-h-[48px] min-w-[48px] shrink-0 items-center justify-center rounded-[var(--radius-sm)] hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)] cursor-pointer"
        >
          <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
          </svg>
        </button>
      ) : null}
    </div>
  );
}

interface ToastContextValue {
  showToast: (toast: Omit<ToastItem, "id">) => string;
  dismissToast: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const seqRef = useRef(0);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const showToast = useCallback((toast: Omit<ToastItem, "id">) => {
    seqRef.current += 1;
    const id = `toast-${seqRef.current}`;
    setToasts((prev) => [...prev.slice(-3), { ...toast, id }]);
    return id;
  }, []);

  return (
    <ToastContext.Provider value={{ showToast, dismissToast }}>
      {children}
      <div
        role="region"
        aria-label="Notifications"
        className="pointer-events-none fixed inset-x-0 bottom-20 z-50 mx-auto flex w-full max-w-md flex-col gap-2 px-4 md:bottom-6"
      >
        {toasts.map((item) => (
          <div key={item.id} className="pointer-events-auto">
            <Toast
              toastId={item.id}
              variant={item.variant}
              message={item.message}
              duration={item.duration}
              dismissLabel={item.dismissLabel}
              onDismissById={dismissToast}
            />
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used inside ToastProvider");
  }
  return ctx;
}
