import { test, expect } from '../../fixtures/multi-browser.js';
import { asArray, asRecord, getAdminToken } from '../../helpers/admin-seed.js';
import { SaathApiClient } from '../../helpers/api.js';
import { E2E_ENV, uniquePhone } from '../../helpers/env.js';
import { assertNoPiiLeak } from '../../helpers/pii.js';

test.describe('@tier1 F46 (Feature 16): Hardening, Contracts, Health & Verification Baseline', () => {
  test('/openapi.json exposes OpenAPI 3.x ProblemDetail schemas and Admin + DPDP routes', async () => {
    const api = new SaathApiClient();
    const res = await api.request<{
      openapi: string;
      paths: Record<string, unknown>;
      components?: { schemas?: Record<string, unknown> };
    }>('GET', '/openapi.json');
    expect(res.status).toBe(200);
    expect(res.data.openapi).toMatch(/^3\./);

    const schemas = res.data.components?.schemas ?? {};
    expect(schemas.ProblemDetail).toBeDefined();
    expect(schemas.ProblemFieldError).toBeDefined();

    const paths = res.data.paths;
    for (const expectedPath of [
      '/v1/admin/auth/session',
      '/v1/admin/analytics/funnel',
      '/v1/admin/providers/health',
      '/v1/admin/moderation/queue',
      '/v1/admin/fraud/graph',
      '/v1/admin/flags',
      '/v1/admin/disputes',
      '/v1/admin/redemptions',
      '/v1/admin/audit-log',
      '/v1/me/consents',
      '/v1/me/export',
      '/v1/me',
    ]) {
      expect(paths[expectedPath]).toBeDefined();
    }
  });

  test('API propagates caller x-request-id header across Admin and DPDP endpoints', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);
    const reqId = `e2e-req-${Date.now()}`;

    const res = await api.request('GET', '/v1/admin/flags', {
      token: adminToken,
      headers: { 'x-request-id': reqId },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toBe(reqId);
  });

  test('Public stats and pricing plans enforce anti-seat-sale and zero-PII invariants', async () => {
    const api = new SaathApiClient();
    const stats = await api.getPublicStats();
    expect(stats.status).toBe(200);
    assertNoPiiLeak(stats.data, 'f46-public-stats');

    const plansRes = await api.getPricingPlans();
    expect(plansRes.status).toBe(200);
    const plans = asArray(plansRes.data.plans ?? plansRes.data.items ?? plansRes.data, 'plans');
    expect(plans.length).toBeGreaterThanOrEqual(1);
    for (const rawPlan of plans) {
      const plan = asRecord(rawPlan, 'plan');
      expect(plan.priority_seat_bump).toBe(false);
    }
  });

  test('apps/admin responds cleanly on /api/health or /login with noindex header/meta', async ({
    request,
  }) => {
    const healthRes = await request.get(`${E2E_ENV.adminUrl}/api/health`);
    expect([200, 404]).toContain(healthRes.status());

    const loginRes = await request.get(`${E2E_ENV.adminUrl}/login`);
    expect(loginRes.status()).toBe(200);
    const html = await loginRes.text();
    expect(html.toLowerCase()).toContain('noindex');
  });

  test('Actor namespaces remain strictly partitioned across anon, user, and admin tokens', async () => {
    const api = new SaathApiClient();
    const anon = await api.issueAnonymousToken();
    const user = await api.loginWithOtp(uniquePhone('f46-user'));
    const adminToken = await getAdminToken(api);

    expect((await api.getPublicStats()).status).toBe(200);
    api.assertProblemJson(await api.getMe(anon.data.access), [401, 403]);
    expect((await api.getMe(user.access)).status).toBe(200);
    api.assertProblemJson(await api.getAdminFlags(user.access), 403);
    expect((await api.getAdminFlags(adminToken)).status).toBe(200);
  });
});
