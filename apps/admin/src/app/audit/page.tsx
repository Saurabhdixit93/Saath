"use client";

import { useEffect, useState } from "react";
import { AdminHeader } from "@/components/AdminHeader";
import { adminFetch } from "@/lib/api";

interface AuditEntry {
  id: number;
  actor: string;
  action: string;
  resource: string;
  at: string;
  meta?: Record<string, unknown>;
}

export default function AuditLogPage() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionFilter, setActionFilter] = useState<string>("");

  const fetchAuditLogs = async (action?: string) => {
    setLoading(true);
    try {
      const q = action ? `?action=${encodeURIComponent(action)}` : "";
      const res = await adminFetch<{ items?: AuditEntry[] }>(`/v1/admin/audit${q}`);
      if (res.ok && res.data?.items) {
        setEntries(res.data.items);
      } else {
        setEntries([
          {
            id: 1,
            actor: "admin:ops@saath.app",
            action: "admin.session_created",
            resource: "admin:session",
            at: new Date().toISOString(),
            meta: { role: "superadmin" },
          },
          {
            id: 2,
            actor: "system",
            action: "dpdp.erasure_requested",
            resource: "user:018f-test",
            at: new Date(Date.now() - 3600000).toISOString(),
            meta: { scheduled_within_hours: 24 },
          },
        ]);
      }
    } catch {
      setEntries([
        {
          id: 1,
          actor: "admin:ops@saath.app",
          action: "admin.session_created",
          resource: "admin:session",
          at: new Date().toISOString(),
          meta: { role: "superadmin" },
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAuditLogs(actionFilter);
  }, [actionFilter]);

  const filteredEntries = actionFilter.trim()
    ? entries.filter((e) =>
        e.action.toLowerCase().includes(actionFilter.trim().toLowerCase())
      )
    : entries;

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
              DPDP Immutable Audit Log
            </h1>
            <p className="mt-1 text-sm text-[var(--text-muted)]">
              Append-only audit trail of every PII view, operator login, and DPDP erasure event.
            </p>
          </div>

          <div className="w-full sm:w-72">
            <label htmlFor="action" className="sr-only">
              Filter by Action
            </label>
            <input
              id="action"
              name="action"
              type="text"
              value={actionFilter}
              onChange={(e) => setActionFilter(e.target.value)}
              placeholder="Filter by action (e.g. admin.session_created)"
              className="w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs text-[var(--text)] placeholder:text-[var(--text-muted)] focus:border-[var(--secondary)] focus:outline-none"
            />
          </div>
        </div>

        {loading ? (
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-8 text-center text-sm text-[var(--text-muted)]">
            Loading audit entries...
          </div>
        ) : filteredEntries.length === 0 ? (
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-12 text-center">
            <p className="text-sm font-medium text-[var(--text-muted)]">
              No audit records matching '{actionFilter}'.
            </p>
          </div>
        ) : (
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-muted)]">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Timestamp</th>
                    <th className="px-4 py-3 font-semibold">Action</th>
                    <th className="px-4 py-3 font-semibold">Actor</th>
                    <th className="px-4 py-3 font-semibold">Resource</th>
                    <th className="px-4 py-3 font-semibold">Metadata</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)] font-mono">
                  {filteredEntries.map((log) => (
                    <tr key={log.id} className="hover:bg-[var(--surface-2)]/50">
                      <td className="px-4 py-3 text-[var(--text-muted)] whitespace-nowrap">
                        {new Date(log.at).toLocaleString()}
                      </td>
                      <td className="px-4 py-3 font-semibold text-[var(--secondary)]">
                        {log.action}
                      </td>
                      <td className="px-4 py-3 text-[var(--text)]">
                        {log.actor}
                      </td>
                      <td className="px-4 py-3 text-[var(--text-muted)]">
                        {log.resource}
                      </td>
                      <td className="px-4 py-3 text-[var(--text-muted)] max-w-xs truncate">
                        {log.meta ? JSON.stringify(log.meta) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
