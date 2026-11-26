import { test, expect } from '../../fixtures/multi-browser.js';
import { asRecord, getAdminToken } from '../../helpers/admin-seed.js';
import { SaathApiClient } from '../../helpers/api.js';
import { E2E_ENV } from '../../helpers/env.js';

function decodeJwtPayload(jwtToken: string): { header: Record<string, unknown>; payload: Record<string, unknown> } {
  const parts = jwtToken.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1]) {
    throw new Error(`Expected 3-part JWT, got ${parts.length} parts`);
  }
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as Record<string, unknown>;
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
  return { header, payload };
}

test.describe('@tier1 F31 (Feature 1): Admin SSO Session & require_admin_actor', () => {
  test('POST /v1/admin/auth/session returns bearer token, expiry, email, and admin scopes', async () => {
    const api = new SaathApiClient();
    const res = await api.createAdminSession(E2E_ENV.adminTestEmail);
    expect([200, 201]).toContain(res.status);

    const token = res.data.access ?? res.data.token ?? '';
    expect(token.length).toBeGreaterThan(20);
    expect(res.data.token).toBe(token);
    expect(String(res.data.token_type ?? '').toLowerCase()).toBe('bearer');
    expect(typeof res.data.expires_in).toBe('number');
    expect(Number(res.data.expires_in)).toBeGreaterThan(0);
    expect(String(res.data.email ?? '').toLowerCase()).toBe(E2E_ENV.adminTestEmail.toLowerCase());
    expect(res.data.scopes).toEqual(['admin']);
  });

  test('Issued admin JWT uses EdDSA and carries kind=admin, sub, email, and matching TTL', async () => {
    const api = new SaathApiClient();
    const res = await api.createAdminSession(E2E_ENV.adminTestEmail);
    expect([200, 201]).toContain(res.status);
    const token = res.data.access ?? res.data.token ?? '';

    const { header, payload } = decodeJwtPayload(token);
    expect(header.alg).toBe('EdDSA');
    expect(payload.kind).toBe('admin');
    expect(payload.email).toBe(E2E_ENV.adminTestEmail.toLowerCase());
    expect(payload.sub).toBe(`admin:${E2E_ENV.adminTestEmail.toLowerCase()}`);
    expect(payload.scopes).toEqual(['admin']);

    const iat = Number(payload.iat);
    const exp = Number(payload.exp);
    expect(exp - iat).toBe(Number(res.data.expires_in));
  });

  test('Allowlist matching normalizes casing/whitespace and accepts redirect_uri', async () => {
    const api = new SaathApiClient();
    const mixedCase = `  ${E2E_ENV.adminTestEmail.toUpperCase()}  `;
    const res = await api.createAdminSession(mixedCase, {
      redirect_uri: `${E2E_ENV.adminUrl}/login`,
    });
    expect([200, 201]).toContain(res.status);
    expect(res.data.email).toBe(E2E_ENV.adminTestEmail.toLowerCase());
    expect((res.data.access ?? '').length).toBeGreaterThan(20);
  });

  test('Creating an admin session writes admin.session_created to audit_log', async () => {
    const api = new SaathApiClient();
    const res = await api.createAdminSession(E2E_ENV.adminTestEmail);
    expect([200, 201]).toContain(res.status);
    const adminToken = res.data.access ?? res.data.token ?? '';

    const audit = await api.getAdminAuditLog<{
      items: Array<Record<string, unknown>>;
      total: number;
    }>(adminToken, {
      action: 'admin.session_created',
      actor: `admin:${E2E_ENV.adminTestEmail.toLowerCase()}`,
      limit: 5,
    });
    expect(audit.status).toBe(200);
    expect(audit.data.total).toBeGreaterThanOrEqual(1);
    const latest = asRecord(audit.data.items[0], 'latest admin.session_created');
    expect(latest.action).toBe('admin.session_created');
    expect(latest.resource).toBe('admin:session');
    const meta = asRecord(latest.meta, 'session meta');
    expect(typeof meta.method).toBe('string');
  });

  test('require_admin_actor authorizes valid admin Bearer JWT across admin read endpoints', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);

    const [funnel, health, flags, disputes, redemptions] = await Promise.all([
      api.getAdminFunnel(adminToken),
      api.getAdminProvidersHealth(adminToken),
      api.getAdminFlags(adminToken),
      api.getAdminDisputes(adminToken),
      api.getAdminRedemptions(adminToken),
    ]);

    expect(funnel.status).toBe(200);
    expect(health.status).toBe(200);
    expect(flags.status).toBe(200);
    expect(disputes.status).toBe(200);
    expect(redemptions.status).toBe(200);
  });
});
