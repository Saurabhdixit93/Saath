"use client";

import { useEffect, useState } from "react";
import { AdminHeader } from "@/components/AdminHeader";
import { adminFetch } from "@/lib/api";

interface FraudGraphData {
  circular_pairs?: Array<{ user_a: string; user_b: string; swap_count: number }>;
  shared_devices?: Array<{ device_id: string; user_count: number }>;
  velocity_spikes?: Array<{ user_id: string; daily_karma: number }>;
}

interface DisputeItem {
  swap_id: string;
  reason?: string;
  status: string;
  created_at?: string;
  seat_a?: string;
  seat_b?: string;
  notes?: string;
}

export default function FraudAndDisputesPage() {
  const [fraudData, setFraudData] = useState<FraudGraphData | null>(null);
  const [disputes, setDisputes] = useState<DisputeItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [overridingSwapId, setOverridingSwapId] = useState<string | null>(null);

  const loadData = async () => {
    setLoading(true);
    try {
      const [fraudRes, disputesRes] = await Promise.all([
        adminFetch<FraudGraphData>("/v1/admin/fraud/graph"),
        adminFetch<{ items?: DisputeItem[] }>("/v1/admin/disputes"),
      ]);
      if (fraudRes.ok && fraudRes.data) {
        setFraudData(fraudRes.data);
      } else {
        setFraudData({
          circular_pairs: [],
          shared_devices: [],
          velocity_spikes: [],
        });
      }
      if (disputesRes.ok && disputesRes.data?.items) {
        setDisputes(disputesRes.data.items);
      } else {
        setDisputes([]);
      }
    } catch {
      setFraudData({ circular_pairs: [], shared_devices: [] });
      setDisputes([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleOverrideComplete = async (swapId: string) => {
    setOverridingSwapId(swapId);
    try {
      const res = await adminFetch(`/v1/admin/disputes/${swapId}/override`, {
        method: "POST",
        body: JSON.stringify({
          action: "force_complete",
          reason: "Admin dispute override resolution",
        }),
      });
      if (res.ok) {
        setDisputes((prev) =>
          prev.map((d) => (d.swap_id === swapId ? { ...d, status: "completed" } : d))
        );
      }
    } finally {
      setOverridingSwapId(null);
    }
  };

  return (
    <div className="min-h-dvh bg-[var(--bg)]">
      <AdminHeader />
      <main className="mx-auto max-w-7xl space-y-8 px-6 py-8">
        <div>
          <h1
            className="text-2xl font-bold text-[var(--text)]"
            style={{ fontFamily: "var(--font-display)" }}
          >
            Fraud Collusion Graph & Dispute Resolution
          </h1>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            Karma velocity anomalies, multi-device collusion detection, and manual swap overrides.
          </p>
        </div>

        {/* Fraud Collusion Graph */}
        <section className="space-y-4">
          <h2 className="text-lg font-bold text-[var(--text)]">
            Karma Fraud & Collusion Graph
          </h2>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-sm">
              <span className="text-xs font-semibold text-[var(--text-muted)]">
                Circular Swap Pairs
              </span>
              <p className="mt-2 text-2xl font-bold text-[var(--text)]">
                {fraudData?.circular_pairs?.length ?? 0}
              </p>
              <span className="mt-1 block text-xs text-[var(--text-muted)]">
                Users repeatedly swapping seats
              </span>
            </div>

            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-sm">
              <span className="text-xs font-semibold text-[var(--text-muted)]">
                Device Collusion Rings
              </span>
              <p className="mt-2 text-2xl font-bold text-[var(--text)]">
                {fraudData?.shared_devices?.length ?? 0}
              </p>
              <span className="mt-1 block text-xs text-[var(--text-muted)]">
                Multiple accounts on one fingerprint
              </span>
            </div>

            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-sm">
              <span className="text-xs font-semibold text-[var(--text-muted)]">
                Velocity Cap Flags
              </span>
              <p className="mt-2 text-2xl font-bold text-[var(--text)]">
                {fraudData?.velocity_spikes?.length ?? 0}
              </p>
              <span className="mt-1 block text-xs text-[var(--text-muted)]">
                Exceeded 300 points in 24 hours
              </span>
            </div>
          </div>
        </section>

        {/* Swap Disputes & Redemption Override */}
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold text-[var(--text)]">
              Dispute Resolution & Redemption Override
            </h2>
            <button
              onClick={loadData}
              className="text-xs font-medium text-[var(--secondary)] hover:underline"
            >
              Refresh
            </button>
          </div>

          {loading ? (
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-8 text-center text-sm text-[var(--text-muted)]">
              Loading disputes...
            </div>
          ) : disputes.length === 0 ? (
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-12 text-center">
              <p className="text-sm font-medium text-[var(--text-muted)]">
                No active swap disputes or unfulfilled redemptions.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {disputes.map((dispute) => (
                <article
                  key={dispute.swap_id}
                  data-dispute-id={dispute.swap_id}
                  className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-sm flex flex-wrap items-center justify-between gap-4"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs font-bold text-[var(--text)]">
                        Swap: {dispute.swap_id.slice(0, 8)}
                      </span>
                      <span className="rounded-full bg-[var(--warning)]/10 px-2 py-0.5 text-xs font-semibold text-[var(--warning)]">
                        {dispute.reason || "swap_dispute"}
                      </span>
                      <span className="text-xs text-[var(--text-muted)]">
                        Status: {dispute.status}
                      </span>
                    </div>
                    {dispute.notes && (
                      <p className="text-xs text-[var(--text-muted)] font-mono">
                        {dispute.notes}
                      </p>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleOverrideComplete(dispute.swap_id)}
                      disabled={overridingSwapId === dispute.swap_id || dispute.status === "completed"}
                      className="inline-flex min-h-[36px] items-center rounded-[var(--radius-sm)] bg-[var(--secondary)] px-4 text-xs font-semibold text-[var(--secondary-ink)] hover:opacity-95 disabled:opacity-50"
                    >
                      {overridingSwapId === dispute.swap_id ? "Completing..." : "Complete"}
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
