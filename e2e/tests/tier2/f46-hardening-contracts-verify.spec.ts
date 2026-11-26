import { test, expect } from '../../fixtures/multi-browser.js';
import { getAdminToken } from '../../helpers/admin-seed.js';
import { SaathApiClient } from '../../helpers/api.js';
import { E2E_ENV, uniquePhone } from '../../helpers/env.js';

function assertProdOtpGuard(startData: Record<string, unknown>, startHeaders: Headers): void {
  if (E2E_ENV.envMode === 'production') {
    expect(startData.dev_otp).toBeUndefined();
    expect(startData.otp).toBeUndefined();
    expect(startHeaders.get('x-dev-otp')).toBeNull();
  } else {
    expect(typeof startData.request_id).toBe('string');
  }
}

test.describe('@tier2 F46 Tier 2: Hardening, Route-Matrix AuthZ & Error Hygiene', () => {
  test('Exhaustive Admin route matrix rejects unauthenticated (401) and passenger JWT (403)', async () => {
    const api = new SaathApiClient();
    const user = await api.loginWithOtp(uniquePhone('f46-t2-matrix'));

    const routes: Array<{ method: 'GET' | 'POST' | 'PATCH'; path: string; body?: unknown }> = [
      { method: 'GET', path: '/v1/admin/analytics/funnel' },
      { method: 'GET', path: '/v1/admin/providers/health' },
      { method: 'GET', path: '/v1/admin/moderation/queue' },
      { method: 'POST', path: '/v1/admin/moderation/00000000-0000-0000-0000-000000000001/action', body: { action: 'dismiss' } },
      { method: 'GET', path: '/v1/admin/fraud/graph' },
      { method: 'GET', path: '/v1/admin/flags' },
      { method: 'PATCH', path: '/v1/admin/flags/rewards_catalogue_enabled', body: { value: false } },
      { method: 'GET', path: '/v1/admin/disputes' },
      { method: 'POST', path: '/v1/admin/disputes/00000000-0000-0000-0000-000000000001/override', body: { action: 'dismiss' } },
      { method: 'GET', path: '/v1/admin/redemptions' },
      { method: 'POST', path: '/v1/admin/redemptions/00000000-0000-0000-0000-000000000001/review', body: { action: 'approve' } },
      { method: 'GET', path: '/v1/admin/audit-log' },
    ];

    for (const r of routes) {
      api.assertProblemJson(await api.request(r.method, r.path, { body: r.body }), 401);
      api.assertProblemJson(
        await api.request(r.method, r.path, { token: user.access, body: r.body }),
        403,
      );
    }
  });

  test('Production safety guard: dev_otp omitted and dev login/reset routes disabled in production', async () => {
    const api = new SaathApiClient();
    const start = await api.startOtp(uniquePhone('f46-t2-otp'));
    expect(start.status).toBe(200);
    assertProdOtpGuard(start.data, start.headers);

    const testLogin = await api.request('POST', '/test-login', {
      body: { phone: uniquePhone('f46-t2-tl') },
    });
    const resetDemo = await api.request('POST', '/admin/reset-demo');
    const allowed = E2E_ENV.envMode === 'production' ? [404, 405] : [200, 404, 405];
    expect(allowed).toContain(testLogin.status);
    expect(allowed).toContain(resetDemo.status);
  });

  test('RFC 9457 error responses on Admin & DPDP routes never leak tracebacks, SQL, or private keys', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);
    const user = await api.loginWithOtp(uniquePhone('f46-t2-err'));

    const samples = [
      await api.actOnModeration(adminToken, '00000000-0000-0000-0000-000000000001', 'dismiss'),
      await api.patchAdminFlag(adminToken, 'missing_flag_xyz', true),
      await api.overrideAdminDispute(adminToken, '00000000-0000-0000-0000-000000000001', { action: 'complete' }),
      await api.saveConsents(user.access, [{ purpose: 'invalid', notice_version: '1.0', granted: true }]),
    ];

    for (const res of samples) {
      api.assertProblemJson(res, [404, 422]);
      expect(res.rawText).not.toMatch(/Traceback|sqlalchemy|SELECT\s+|BEGIN PRIVATE KEY/i);
    }
  });

  test('Malformed UUID path params and invalid JSON payloads return 400/422 RFC 9457 (never 500)', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);

    api.assertProblemJson(
      await api.actOnModeration(adminToken, 'not-a-valid-uuid', 'dismiss'),
      [400, 422],
    );
    api.assertProblemJson(
      await api.overrideAdminDispute(adminToken, 'not-a-valid-uuid', { action: 'complete' }),
      [400, 422],
    );
    api.assertProblemJson(
      await api.request('POST', '/v1/me/consents', {
        token: adminToken,
        body: '{not-json',
      }),
      [400, 401, 403, 422],
    );
  });

  test('apps/admin serves noindex, nofollow and omits x-powered-by header on /login', async ({
    request,
  }) => {
    const res = await request.get(`${E2E_ENV.adminUrl}/login`);
    expect(res.status()).toBe(200);
    const headers = res.headers();
    expect(headers['x-powered-by']).toBeUndefined();
    const html = await res.text();
    expect(html).toMatch(/noindex.*nofollow|nofollow.*noindex/i);
  });
});
