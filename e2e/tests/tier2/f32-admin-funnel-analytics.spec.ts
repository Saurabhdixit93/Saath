import { test, expect } from '../../fixtures/multi-browser.js';
import { getAdminToken } from '../../helpers/admin-seed.js';
import { SaathApiClient } from '../../helpers/api.js';
import { uniquePhone } from '../../helpers/env.js';
import { assertNoPiiLeak } from '../../helpers/pii.js';

test.describe('@tier2 F32 Tier 2: Route & Conversion Funnel Analytics Boundaries', () => {
  test('Invalid from_date or to_date query parameter returns 422 RFC 9457', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);

    api.assertProblemJson(await api.getAdminFunnel(adminToken, { from_date: 'not-a-date' }), 422);
    api.assertProblemJson(await api.getAdminFunnel(adminToken, { to_date: '2026-99-99' }), 422);
  });

  test('route query longer than 64 characters returns 422 RFC 9457', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);

    api.assertProblemJson(
      await api.getAdminFunnel(adminToken, { route: 'R'.repeat(65) }),
      422,
    );
  });

  test('Inverted date range and unmatched route return zero funnel counts cleanly', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);

    const inverted = await api.getAdminFunnel(adminToken, {
      from_date: '2030-01-01',
      to_date: '2020-01-01',
    });
    expect(inverted.status).toBe(200);
    expect(inverted.data.verified).toBe(0);
    expect(inverted.data.match_rate).toBe(0);
    expect(inverted.data.routes).toEqual([]);

    const missingRoute = await api.getAdminFunnel(adminToken, { route: 'ZZZZZ-YYYYY' });
    expect(missingRoute.status).toBe(200);
    expect(missingRoute.data.verified).toBe(0);
    expect(missingRoute.data.routes).toEqual([]);
  });

  test('Unauthenticated (401) and passenger JWT (403) cannot access /v1/admin/analytics/funnel', async () => {
    const api = new SaathApiClient();
    const user = await api.loginWithOtp(uniquePhone('f32-t2-authz'));

    api.assertProblemJson(await api.request('GET', '/v1/admin/analytics/funnel'), 401);
    api.assertProblemJson(await api.getAdminFunnel(user.access), 403);
  });

  test('Funnel analytics response never exposes co-passenger PII or raw PNRs', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);

    const funnel = await api.getAdminFunnel(adminToken);
    expect(funnel.status).toBe(200);
    assertNoPiiLeak(funnel.data, 'f32-t2-funnel-no-pii');
  });
});
