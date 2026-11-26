import { test, expect } from '../../fixtures/multi-browser.js';
import { asArray, asRecord, getAdminToken } from '../../helpers/admin-seed.js';
import { SaathApiClient } from '../../helpers/api.js';
import { E2E_ENV, uniquePhone } from '../../helpers/env.js';

test.describe('@tier1 F38 (Feature 8): Immutable Audit Log Viewer API', () => {
  test('GET /v1/admin/audit-log returns items, total, limit, offset with structured AuditLogItemDTO', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);

    const res = await api.getAdminAuditLog(adminToken, { limit: 10, offset: 0 });
    expect(res.status).toBe(200);
    expect(typeof res.data.total).toBe('number');
    expect(res.data.limit).toBe(10);
    expect(res.data.offset).toBe(0);

    const items = asArray(res.data.items, 'audit items');
    expect(items.length).toBeGreaterThanOrEqual(1);
    const first = asRecord(items[0], 'first audit item');
    expect(typeof first.id).toBe('number');
    expect(typeof first.actor).toBe('string');
    expect(typeof first.action).toBe('string');
    expect(typeof first.resource).toBe('string');
    expect(typeof first.at).toBe('string');
  });

  test('Audit log items are sorted newest-first by timestamp and id', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);
    await api.getAdminModerationQueue(adminToken);

    const res = await api.getAdminAuditLog(adminToken, { limit: 10, offset: 0 });
    expect(res.status).toBe(200);
    const items = asArray(res.data.items, 'audit items').map((i) => asRecord(i, 'item'));
    expect(items.length).toBeGreaterThanOrEqual(2);

    const firstId = Number(items[0]?.id);
    const secondId = Number(items[1]?.id);
    expect(firstId).toBeGreaterThan(secondId);
  });

  test('Audit log supports filtering by action, actor, and resource simultaneously', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);
    await api.getAdminFraudGraph(adminToken);

    const filtered = await api.getAdminAuditLog(adminToken, {
      action: 'admin.fraud_graph_viewed',
      actor: `admin:${E2E_ENV.adminTestEmail.toLowerCase()}`,
      resource: 'fraud:graph',
      limit: 5,
      offset: 0,
    });
    expect(filtered.status).toBe(200);
    const rows = asArray(filtered.data.items, 'filtered').map((i) => asRecord(i, 'row'));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const row of rows) {
      expect(row.action).toBe('admin.fraud_graph_viewed');
      expect(row.actor).toBe(`admin:${E2E_ENV.adminTestEmail.toLowerCase()}`);
      expect(row.resource).toBe('fraud:graph');
    }
  });

  test('Pagination with limit and offset returns non-overlapping slices', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);
    await api.getAdminModerationQueue(adminToken);
    await api.getAdminFraudGraph(adminToken);

    const page1 = await api.getAdminAuditLog(adminToken, { limit: 2, offset: 0 });
    const page2 = await api.getAdminAuditLog(adminToken, { limit: 2, offset: 2 });
    expect(page1.status).toBe(200);
    expect(page2.status).toBe(200);

    const ids1 = asArray(page1.data.items, 'p1').map((i) => Number(asRecord(i, 'i').id));
    const ids2 = asArray(page2.data.items, 'p2').map((i) => Number(asRecord(i, 'i').id));
    expect(ids1.length).toBe(2);
    expect(ids2.length).toBeGreaterThanOrEqual(1);
    for (const id of ids2) {
      expect(ids1).not.toContain(id);
    }
  });

  test('Audit log captures both admin operations and user DPDP export events', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);
    const user = await api.loginWithOtp(uniquePhone('f38-dpdp-audit'));

    const before = await api.getAdminAuditLog<{ total: number }>(adminToken);
    const zip = await api.exportMyData(user.access);
    expect(zip.status).toBe(200);

    const after = await api.getAdminAuditLog<{
      total: number;
      items: Array<Record<string, unknown>>;
    }>(adminToken, { limit: 15 });
    expect(after.status).toBe(200);
    expect(after.data.total).toBeGreaterThan(before.data.total);
    expect(JSON.stringify(after.data.items)).toMatch(/export|dpdp/i);
  });
});
