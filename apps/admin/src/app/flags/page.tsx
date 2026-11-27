"use client";

import { useEffect, useState } from "react";
import { AdminHeader } from "@/components/AdminHeader";
import { adminFetch } from "@/lib/api";

interface FeatureFlagItem {
  key: string;
  value: boolean;
  description?: string;
  updated_at?: string;
}

export default function FeatureFlagsPage() {
  const [flags, setFlags] = useState<FeatureFlagItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [updatingKey, setUpdatingKey] = useState<string | null>(null);

  const fetchFlags = async () => {
    setLoading(true);
    try {
      const res = await adminFetch<{ items?: FeatureFlagItem[] }>("/v1/admin/flags");
      if (res.ok && res.data?.items) {
        setFlags(res.data.items);
      } else {
        setFlags([
          {
            key: "rewards_catalogue_enabled",
            value: true,
            description: "Show karma rewards redemption catalogue in web app",
          },
          {
            key: "maintenance_banner_enabled",
            value: false,
            description: "Display scheduled maintenance banner",
          },
          {
            key: "women_only_auto_guard",
            value: true,
            description: "Automatic women-only compartment safety guard",
          },
        ]);
      }
    } catch {
      setFlags([
        {
          key: "rewards_catalogue_enabled",
          value: true,
          description: "Show karma rewards redemption catalogue in web app",
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchFlags();
  }, []);

  const handleToggle = async (key: string, currentValue: boolean) => {
    setUpdatingKey(key);
    const nextVal = !currentValue;
    try {
      const res = await adminFetch(`/v1/admin/flags/${key}`, {
        method: "PATCH",
        body: JSON.stringify({
          value: nextVal,
          change_reason: `Admin toggle to ${nextVal}`,
        }),
      });
      if (res.ok) {
        setFlags((prev) =>
          prev.map((f) => (f.key === key ? { ...f, value: nextVal } : f))
        );
      }
    } finally {
      setUpdatingKey(null);
    }
  };

  return (
    <div className="min-h-dvh bg-[var(--bg)]">
      <AdminHeader />
      <main className="mx-auto max-w-7xl space-y-6 px-6 py-8">
        <div>
          <h1
            className="text-2xl font-bold text-[var(--text)]"
            style={{ fontFamily: "var(--font-display)" }}
          >
            Feature Flags & Rollout Knobs
          </h1>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            Dynamically toggle capabilities and killswitches without code deployment.
          </p>
        </div>

        {loading ? (
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-8 text-center text-sm text-[var(--text-muted)]">
            Loading feature flags...
          </div>
        ) : (
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-sm divide-y divide-[var(--border)]">
            {flags.map((flag) => (
              <div
                key={flag.key}
                className="flex flex-wrap items-center justify-between gap-4 p-5"
              >
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm font-bold text-[var(--text)]">
                      {flag.key}
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                        flag.value
                          ? "bg-[var(--success)]/10 text-[var(--success)]"
                          : "bg-[var(--surface-2)] text-[var(--text-muted)]"
                      }`}
                    >
                      {flag.value ? "Active" : "Disabled"}
                    </span>
                  </div>
                  {flag.description && (
                    <p className="text-xs text-[var(--text-muted)]">
                      {flag.description}
                    </p>
                  )}
                </div>

                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={flag.value}
                    disabled={updatingKey === flag.key}
                    onClick={() => handleToggle(flag.key, flag.value)}
                    className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none disabled:opacity-50 ${
                      flag.value ? "bg-[var(--secondary)]" : "bg-[var(--border)]"
                    }`}
                  >
                    <span
                      className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                        flag.value ? "translate-x-5" : "translate-x-0"
                      }`}
                    />
                  </button>
                  <button
                    type="button"
                    disabled={updatingKey === flag.key}
                    onClick={() => handleToggle(flag.key, flag.value)}
                    className="inline-flex min-h-[32px] items-center rounded border border-[var(--border)] bg-[var(--surface-2)] px-2.5 text-xs font-medium text-[var(--text)] hover:bg-[var(--border)] disabled:opacity-50"
                  >
                    {flag.value ? "Disable" : "Enable"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
