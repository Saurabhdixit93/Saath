import { test, expect } from '../../fixtures/multi-browser.js';
import { SaathApiClient } from '../../helpers/api.js';
import { E2E_ENV, uniquePhone } from '../../helpers/env.js';

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Expected array for ${label}`);
  }
  return value;
}

test.describe('F31 Tier 2: Admin Portal AuthZ, Prod Guards & Audit Log @tier2', () => {
  test('Unauthenticated access to /v1/admin/* endpoints returns 401 RFC 9457', async () => {
    const api = new SaathApiClient();
    const queue = await api.request('GET', '/v1/admin/moderation/queue');
    api.assertProblemJson(queue, 401);

    const audit = await api.request('GET', '/v1/admin/audit-log');
    api.assertProblemJson(audit, 401);
  });

  test('Regular passenger JWT cannot access /v1/admin/* endpoints (403)', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone(312_001));

    const queue = await api.getAdminModerationQueue(auth.access);
    api.assertProblemJson(queue, 403);

    const flags = await api.getAdminFlags(auth.access);
    api.assertProblemJson(flags, 403);
  });

  test('Production route guard: /test-login and /admin/reset-demo are absent when ENV=production', async () => {
    const api = new SaathApiClient();
    const testLoginRes = await api.request('POST', '/test-login', {
      body: { phone: uniquePhone(312_002) },
    });
    const resetRes = await api.request('POST', '/admin/reset-demo');

    const expectedStatuses = E2E_ENV.envMode === 'production' ? [404, 405] : [200, 404, 405];
    expect(expectedStatuses).toContain(testLoginRes.status);
    expect(expectedStatuses).toContain(resetRes.status);
  });

  test('Invalid moderation action rejected with 422 RFC 9457', async () => {
    const api = new SaathApiClient();
    const session = await api.request<{ access?: string; token?: string }>(
      'POST',
      '/v1/admin/auth/session',
      { body: { email: E2E_ENV.adminTestEmail } },
    );
    expect([200, 201]).toContain(session.status);
    const adminToken = session.data.access ?? session.data.token ?? '';
    expect(adminToken.length).toBeGreaterThan(0);
    const res = await api.actOnModeration(
      adminToken,
      '00000000-0000-0000-0000-000000000001',
      'invalid_action_xyz',
    );
    api.assertProblemJson(res, [404, 422]);
  });

  test('Viewing fraud graph appends an entry to audit_log', async () => {
    const api = new SaathApiClient();
    const session = await api.request<{ access?: string; token?: string }>(
      'POST',
      '/v1/admin/auth/session',
      { body: { email: E2E_ENV.adminTestEmail } },
    );
    expect([200, 201]).toContain(session.status);
    const adminToken = session.data.access ?? session.data.token ?? '';
    expect(adminToken.length).toBeGreaterThan(0);

    const before = await api.getAdminAuditLog(adminToken);
    expect(before.status).toBe(200);
    const beforeCount =
      typeof before.data.total === 'number'
        ? before.data.total
        : asArray(before.data.items ?? before.data.entries ?? before.data, 'before').length;

    const fraudRes = await api.getAdminFraudGraph(adminToken);
    expect(fraudRes.status).toBe(200);

    const after = await api.getAdminAuditLog(adminToken);
    expect(after.status).toBe(200);
    const afterCount =
      typeof after.data.total === 'number'
        ? after.data.total
        : asArray(after.data.items ?? after.data.entries ?? after.data, 'after').length;
    expect(afterCount).toBeGreaterThan(beforeCount);
  });
});
