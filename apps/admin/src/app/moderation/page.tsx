"use client";

import { useEffect, useState } from "react";
import { AdminHeader } from "@/components/AdminHeader";
import { adminFetch } from "@/lib/api";

interface ModerationReport {
  report_id: string;
  status: string;
  reason: string;
  created_at?: string;
  reporter?: string;
  target_user?: string;
  message_id?: string;
  message_body?: string;
}

export default function ModerationQueuePage() {
  const [reports, setReports] = useState<ModerationReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>("open");
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const fetchReports = async (status: string) => {
    setLoading(true);
    try {
      const res = await adminFetch<{ items?: ModerationReport[] }>(
        `/v1/admin/moderation?status=${status}`
      );
      if (res.ok && res.data?.items) {
        setReports(res.data.items);
      } else {
        setReports([]);
      }
    } catch {
      setReports([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchReports(statusFilter);
  }, [statusFilter]);

  const handleAction = async (reportId: string, action: "dismiss" | "hide_message" | "restrict_user" | "ban_user") => {
    setActionLoading(reportId);
    try {
      const res = await adminFetch(`/v1/admin/moderation/${reportId}/action`, {
        method: "POST",
        body: JSON.stringify({
          action,
          reason: `Admin action: ${action}`,
        }),
      });
      if (res.ok) {
        // Remove or update report from current list
        setReports((prev) => prev.filter((r) => r.report_id !== reportId));
      }
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <div className="min-h-dvh bg-[var(--bg)]">
      <AdminHeader />
      <main className="mx-auto max-w-7xl space-y-6 px-6 py-8">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1
              className="text-2xl font-bold text-[var(--text)]"
              style={{ fontFamily: "var(--font-display)" }}
            >
              Moderation Queue
            </h1>
            <p className="mt-1 text-sm text-[var(--text-muted)]">
              Review flagged chat messages, PII leak attempts, and scam reports.
            </p>
          </div>

          <div className="flex items-center gap-2">
            {["open", "dismissed", "actioned"].map((s) => (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                className={`rounded-md px-3 py-1.5 text-xs font-semibold capitalize transition-colors ${
                  statusFilter === s
                    ? "bg-[var(--secondary)] text-[var(--secondary-ink)]"
                    : "border border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] hover:text-[var(--text)]"
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-8 text-center text-sm text-[var(--text-muted)]">
            Loading moderation reports...
          </div>
        ) : reports.length === 0 ? (
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-12 text-center">
            <p className="text-sm font-medium text-[var(--text-muted)]">
              No {statusFilter} reports in the queue.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {reports.map((report) => (
              <article
                key={report.report_id}
                data-report-id={report.report_id}
                className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-sm space-y-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] pb-3">
                  <div className="flex items-center gap-2">
                    <span className="rounded-full bg-[var(--danger)]/10 px-2.5 py-0.5 text-xs font-semibold text-[var(--danger)]">
                      {report.reason}
                    </span>
                    <span className="text-xs text-[var(--text-muted)]">
                      Report ID: {report.report_id.slice(0, 8)}
                    </span>
                  </div>
                  {report.created_at && (
                    <span className="text-xs text-[var(--text-muted)]">
                      {new Date(report.created_at).toLocaleString()}
                    </span>
                  )}
                </div>

                <div className="space-y-2">
                  <div className="rounded-md bg-[var(--surface-2)] p-3 text-sm text-[var(--text)] font-mono">
                    {report.message_body || "Message content flagged for moderation"}
                  </div>
                  <div className="flex flex-wrap items-center gap-4 text-xs text-[var(--text-muted)]">
                    <span>Target User: {report.target_user || "Anonymous"}</span>
                    <span>Reporter: {report.reporter || "Auto-Moderator"}</span>
                    <span>Status: {report.status}</span>
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
                  <button
                    onClick={() => handleAction(report.report_id, "dismiss")}
                    disabled={actionLoading === report.report_id}
                    className="inline-flex min-h-[36px] items-center rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-3 text-xs font-semibold text-[var(--text)] hover:bg-[var(--surface-2)] disabled:opacity-50"
                  >
                    Dismiss
                  </button>
                  <button
                    onClick={() => handleAction(report.report_id, "hide_message")}
                    disabled={actionLoading === report.report_id}
                    className="inline-flex min-h-[36px] items-center rounded-[var(--radius-sm)] border border-[var(--warning)]/30 bg-[var(--warning)]/10 px-3 text-xs font-semibold text-[var(--warning)] hover:bg-[var(--warning)]/20 disabled:opacity-50"
                  >
                    Hide Message
                  </button>
                  <button
                    onClick={() => handleAction(report.report_id, "restrict_user")}
                    disabled={actionLoading === report.report_id}
                    className="inline-flex min-h-[36px] items-center rounded-[var(--radius-sm)] border border-[var(--danger)]/30 bg-[var(--danger)]/10 px-3 text-xs font-semibold text-[var(--danger)] hover:bg-[var(--danger)]/20 disabled:opacity-50"
                  >
                    Restrict User
                  </button>
                  <button
                    onClick={() => handleAction(report.report_id, "ban_user")}
                    disabled={actionLoading === report.report_id}
                    className="inline-flex min-h-[36px] items-center rounded-[var(--radius-sm)] bg-[var(--danger)] px-3 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
                  >
                    Ban User
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
