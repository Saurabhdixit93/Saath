"use client";

import { Button, EmptyState } from "@saath/ui";
import { AdminHeader } from "@/components/AdminHeader";

export default function AdminLoginPage() {
  const ssoEnabled = process.env.NEXT_PUBLIC_ADMIN_SSO_ENABLED === "true";

  return (
    <div className="min-h-dvh bg-[var(--bg)]">
      <AdminHeader />
      <main className="mx-auto flex max-w-md flex-col justify-center px-6 py-16">
        <EmptyState
          title="Saath Operations Sign In"
          description={
            ssoEnabled
              ? "Authenticate with your allowlisted Google Workspace account. Every PII inspection is recorded in audit_log."
              : "Google Workspace SSO is configured via ADMIN_SSO_CLIENT_ID and ADMIN_SSO_ALLOWED_EMAILS. Local demo bypass routes are disabled by policy."
          }
          primaryAction={
            <Button
              variant="secondary"
              fullWidth
              disabled={!ssoEnabled}
            >
              Sign in with Google Workspace
            </Button>
          }
          footerNote="Protected by SSO + allowlist. Zero test-login or demo-reset routes."
        />
      </main>
    </div>
  );
}
