import { test, expect } from '../../fixtures/multi-browser.js';
import { getAdminToken } from '../../helpers/admin-seed.js';
import { SaathApiClient } from '../../helpers/api.js';
import { uniquePhone } from '../../helpers/env.js';
import { assertNoPiiLeak } from '../../helpers/pii.js';

test.describe('@tier2 F38 Tier 2: Immutable Audit Log Viewer Boundaries', () => {
  test('limit=0, limit=201, and offset=-1 return 422 RFC 9457', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);

    api.assertProblemJson(await api.getAdminAuditLog(adminToken, { limit: 0 }), 422);
    api.assertProblemJson(await api.getAdminAuditLog(adminToken, { limit: 201 }), 422);
    api.assertProblemJson(await api.getAdminAuditLog(adminToken, { offset: -1 }), 422);
  });

  test('Non-matching action/actor/resource filter returns empty items and total=0', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);

    const res = await api.getAdminAuditLog(adminToken, {
      action: 'nonexistent.action.xyz',
      actor: 'nobody@saath.test',
    });
    expect(res.status).toBe(200);
    expect(res.data.items).toEqual([]);
    expect(res.data.total).toBe(0);
  });

  test('Audit log is immutable: POST, PATCH, and DELETE on /v1/admin/audit-log return 405 RFC 9457', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);

    api.assertProblemJson(
      await api.request('POST', '/v1/admin/audit-log', { token: adminToken, body: {} }),
      405,
    );
    api.assertProblemJson(
      await api.request('PATCH', '/v1/admin/audit-log', { token: adminToken, body: {} }),
      405,
    );
    api.assertProblemJson(
      await api.request('DELETE', '/v1/admin/audit-log', { token: adminToken }),
      405,
    );
  });

  test('Unauthenticated (401) and passenger JWT (403) cannot read /v1/admin/audit-log', async () => {
    const api = new SaathApiClient();
    const user = await api.loginWithOtp(uniquePhone('f38-t2-authz'));

    api.assertProblemJson(await api.request('GET', '/v1/admin/audit-log'), 401);
    api.assertProblemJson(await api.getAdminAuditLog(user.access), 403);
  });

  test('Audit log entries never expose raw phone numbers, PNRs, or email PII', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);

    const res = await api.getAdminAuditLog(adminToken, { limit: 50 });
    expect(res.status).toBe(200);
    assertNoPiiLeak(res.data, 'f38-t2-audit-no-pii', [], { scanPatterns: false });
  });
});
