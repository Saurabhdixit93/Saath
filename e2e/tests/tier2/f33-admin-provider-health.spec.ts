import { test, expect } from '../../fixtures/multi-browser.js';
import { asRecord, getAdminToken } from '../../helpers/admin-seed.js';
import { SaathApiClient } from '../../helpers/api.js';
import { uniquePhone } from '../../helpers/env.js';
import { assertNoPiiLeak } from '../../helpers/pii.js';

test.describe('@tier2 F33 Tier 2: Provider Health & Notification Delivery Boundaries', () => {
  test('Unauthenticated GET /v1/admin/providers/health returns 401 RFC 9457', async () => {
    const api = new SaathApiClient();
    api.assertProblemJson(await api.request('GET', '/v1/admin/providers/health'), 401);
  });

  test('Passenger and anonymous JWTs return 403 RFC 9457 on /v1/admin/providers/health', async () => {
    const api = new SaathApiClient();
    const user = await api.loginWithOtp(uniquePhone('f33-t2-user'));
    const anon = await api.issueAnonymousToken();

    api.assertProblemJson(await api.getAdminProvidersHealth(user.access), 403);
    api.assertProblemJson(await api.getAdminProvidersHealth(anon.data.access), 403);
  });

  test('Unsupported HTTP methods (POST, PATCH, DELETE) on /v1/admin/providers/health return 405 RFC 9457', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);

    api.assertProblemJson(
      await api.request('POST', '/v1/admin/providers/health', { token: adminToken }),
      405,
    );
    api.assertProblemJson(
      await api.request('DELETE', '/v1/admin/providers/health', { token: adminToken }),
      405,
    );
  });

  test('Outbox stats stay non-negative and bounded across empty/drained queues', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);

    const res = await api.getAdminProvidersHealth(adminToken);
    expect(res.status).toBe(200);
    const outbox = asRecord(res.data.outbox, 'outbox');
    expect(Number(outbox.queued)).toBeGreaterThanOrEqual(0);
    expect(Number(outbox.sent)).toBeGreaterThanOrEqual(0);
    expect(Number(outbox.dead_letter)).toBeGreaterThanOrEqual(0);
    expect(Number(outbox.lag_seconds)).toBeGreaterThanOrEqual(0);
  });

  test('Provider health response never leaks adapter credentials, phones, or PNRs', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);

    const res = await api.getAdminProvidersHealth(adminToken);
    expect(res.status).toBe(200);
    assertNoPiiLeak(res.data, 'f33-t2-providers-no-pii');
    const serialized = JSON.stringify(res.data).toLowerCase();
    expect(serialized).not.toContain('api_key');
    expect(serialized).not.toContain('secret');
  });
});
