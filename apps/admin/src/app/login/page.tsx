"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AdminHeader } from "@/components/AdminHeader";
import { adminFetch, setAdminToken } from "@/lib/api";

export default function AdminLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const isProd = process.env.NEXT_PUBLIC_ENV === "production";

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await adminFetch<{ access?: string; token?: string; detail?: string }>("/v1/admin/auth/session", {
        method: "POST",
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      });
      if (res.ok && (res.data?.access || res.data?.token)) {
        const token = (res.data.access || res.data.token) as string;
        setAdminToken(token);
        router.push("/");
      } else {
        setError(res.data?.detail || "Sign in failed. Check your email allowlist.");
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "An unexpected error occurred.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-dvh bg-[var(--bg)]">
      <meta name="robots" content="noindex, nofollow" />
      <AdminHeader />
      <main className="mx-auto flex max-w-md flex-col justify-center px-6 py-16">
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-8 shadow-sm">
          <h1
            className="text-xl font-bold text-[var(--text)]"
            style={{ fontFamily: "var(--font-display)" }}
          >
            Saath Operations Sign In
          </h1>
          <p className="mt-2 text-sm text-[var(--text-muted)]">
            Internal operations portal with strict DPDP compliance and audit logging.
          </p>

          {error && (
            <div className="mt-4 rounded-md border border-[var(--danger)]/30 bg-[var(--danger)]/10 p-3 text-xs text-[var(--danger)]">
              {error}
            </div>
          )}

          {!isProd ? (
            <form onSubmit={handleSignIn} className="mt-6 space-y-4">
              <div>
                <label htmlFor="email" className="block text-xs font-semibold text-[var(--text)]">
                  Email
                </label>
                <input
                  id="email"
                  name="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="ops@saath.app"
                  required
                  className="mt-1 block w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)] placeholder:text-[var(--text-muted)] focus:border-[var(--secondary)] focus:outline-none"
                />
              </div>

              <button
                type="submit"
                disabled={loading}
                className="inline-flex min-h-[44px] w-full items-center justify-center rounded-[var(--radius-sm)] bg-[var(--secondary)] px-4 text-sm font-semibold text-[var(--secondary-ink)] hover:opacity-95 disabled:opacity-50"
              >
                {loading ? "Authenticating..." : "Sign In"}
              </button>
            </form>
          ) : (
            <div className="mt-6">
              <button
                type="button"
                className="inline-flex min-h-[44px] w-full items-center justify-center rounded-[var(--radius-sm)] bg-[var(--secondary)] px-4 text-sm font-semibold text-[var(--secondary-ink)]"
              >
                Sign in with Google Workspace
              </button>
            </div>
          )}

          <p className="mt-6 text-center text-xs text-[var(--text-muted)]">
            Protected by SSO + allowlist. Every PII inspection is recorded in audit_log.
          </p>
        </div>
      </main>
    </div>
  );
}
