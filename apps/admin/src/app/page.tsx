import Link from "next/link";
import { EmptyState } from "@saath/ui";
import { AdminHeader } from "@/components/AdminHeader";

const ADMIN_MODULES = [
  {
    title: "Route & Conversion Funnel",
    description: "Verify -> Goal -> Match -> Swap Card funnel metrics by train route and date (connects in M5).",
  },
  {
    title: "Provider Health",
    description: "Live latency, timeout rate, and circuit-breaker state for Rail, Flight, WhatsApp, and SMS adapters.",
  },
  {
    title: "Moderation Queue",
    description: "Flagged masked-chat messages with dismiss, hide, restrict, and ban audit actions.",
  },
  {
    title: "Karma Fraud Graph",
    description: "Detects circular karma pairs, device collusion, and daily cap anomalies.",
  },
  {
    title: "Feature Flags",
    description: "Manage rollout toggles, rewards catalogue visibility, and maintenance banners.",
  },
  {
    title: "DPDP Audit Log",
    description: "Immutable record of every operator PII view, export, and 24-hour erasure job.",
  },
] as const;

export default function AdminOverviewPage() {
  return (
    <div className="min-h-dvh bg-[var(--bg)]">
      <AdminHeader />
      <main className="mx-auto max-w-6xl space-y-6 px-6 py-8">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1
              className="text-2xl font-bold text-[var(--text)]"
              style={{ fontFamily: "var(--font-display)" }}
            >
              Saath Operations Overview
            </h1>
            <p className="mt-1 text-sm text-[var(--text-muted)]">
              Separate admin portal (`:3001`) with `noindex, nofollow` and strict audit logging.
            </p>
          </div>
          <Link
            href="/login"
            className="inline-flex min-h-[48px] items-center rounded-[var(--radius-sm)] bg-[var(--secondary)] px-4 text-sm font-semibold text-[var(--secondary-ink)]"
          >
            Operator SSO
          </Link>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {ADMIN_MODULES.map((mod) => (
            <EmptyState
              key={mod.title}
              title={mod.title}
              description={mod.description}
              className="text-left"
            />
          ))}
        </div>
      </main>
    </div>
  );
}
