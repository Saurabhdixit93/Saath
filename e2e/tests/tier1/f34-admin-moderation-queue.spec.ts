import { test, expect } from '../../fixtures/multi-browser.js';
import {
  asArray,
  asRecord,
  createReportedMessage,
  getAdminToken,
} from '../../helpers/admin-seed.js';
import { SaathApiClient } from '../../helpers/api.js';
import { futureDateIso } from '../../helpers/env.js';

test.describe('@tier1 F34 (Feature 4): Moderation Queue & Context', () => {
  test('GET /v1/admin/moderation/queue?status=open joins report, message, conversation, and target user context', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);
    const seeded = await createReportedMessage(api, 'f34-ctx', {
      travelDate: futureDateIso(23),
      seatA: '1',
      seatB: '3',
      messageText: 'Suspicious queue context body',
      reason: 'scam',
    });

    const queue = await api.getAdminModerationQueue(adminToken, { status: 'open', limit: 50 });
    expect(queue.status).toBe(200);
    const items = asArray(queue.data.items, 'moderation items').map((i) => asRecord(i, 'item'));
    const match = items.find((i) => i.report_id === seeded.reportId);
    expect(match).toBeDefined();
    expect(match?.status).toBe('open');
    expect(match?.reason).toBe('scam');
    expect(match?.reporter_id).toBe(seeded.authA.user.id);
    expect(match?.target_user_id).toBe(seeded.authB.user.id);
    expect(match?.target_user_status).toBe('active');
    expect(match?.conversation_id).toBe(seeded.convoId);
    expect(typeof match?.journey_instance_id).toBe('string');
    expect(match?.message_id).toBe(seeded.messageId);
    expect(match?.message_body).toBe('Suspicious queue context body');
  });

  test('status=dismissed, actioned, and all filters return matching report states', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);
    const travelDate = futureDateIso(23);

    const repDismiss = await createReportedMessage(api, 'f34-st-dismiss', {
      travelDate,
      seatA: '4',
      seatB: '6',
      reason: 'other',
    });
    const repHide = await createReportedMessage(api, 'f34-st-hide', {
      travelDate,
      seatA: '9',
      seatB: '11',
      reason: 'abuse',
    });

    expect((await api.actOnModeration(adminToken, repDismiss.reportId, 'dismiss')).status).toBe(200);
    expect((await api.actOnModeration(adminToken, repHide.reportId, 'hide')).status).toBe(200);

    const dismissed = await api.getAdminModerationQueue(adminToken, { status: 'dismissed' });
    const dismissedItems = asArray(dismissed.data.items, 'dismissed').map((i) => asRecord(i, 'i'));
    expect(dismissedItems.some((i) => i.report_id === repDismiss.reportId)).toBe(true);

    const actioned = await api.getAdminModerationQueue(adminToken, { status: 'actioned' });
    const actionedItems = asArray(actioned.data.items, 'actioned').map((i) => asRecord(i, 'i'));
    expect(actionedItems.some((i) => i.report_id === repHide.reportId)).toBe(true);

    const all = await api.getAdminModerationQueue(adminToken, { status: 'all', limit: 200 });
    const allItems = asArray(all.data.items, 'all').map((i) => asRecord(i, 'i'));
    expect(allItems.some((i) => i.report_id === repDismiss.reportId)).toBe(true);
    expect(allItems.some((i) => i.report_id === repHide.reportId)).toBe(true);
  });

  test('limit and offset paginate moderation queue consistently against total', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);
    const travelDate = futureDateIso(23);

    await createReportedMessage(api, 'f34-pg-1', { travelDate, seatA: '12', seatB: '14' });
    await createReportedMessage(api, 'f34-pg-2', { travelDate, seatA: '17', seatB: '19' });

    const page1 = await api.getAdminModerationQueue(adminToken, { status: 'open', limit: 1, offset: 0 });
    const page2 = await api.getAdminModerationQueue(adminToken, { status: 'open', limit: 1, offset: 1 });
    expect(page1.status).toBe(200);
    expect(page2.status).toBe(200);

    const items1 = asArray(page1.data.items, 'p1').map((i) => asRecord(i, 'p1i'));
    const items2 = asArray(page2.data.items, 'p2').map((i) => asRecord(i, 'p2i'));
    expect(items1).toHaveLength(1);
    expect(items2).toHaveLength(1);
    expect(items1[0]?.report_id).not.toBe(items2[0]?.report_id);
    expect(Number(page1.data.total)).toBeGreaterThanOrEqual(2);
  });

  test('Moderation queue returns items ordered newest-first', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);
    const travelDate = futureDateIso(23);

    const older = await createReportedMessage(api, 'f34-ord-1', { travelDate, seatA: '20', seatB: '22' });
    const newer = await createReportedMessage(api, 'f34-ord-2', { travelDate, seatA: '25', seatB: '27' });

    const queue = await api.getAdminModerationQueue(adminToken, { status: 'open', limit: 50 });
    expect(queue.status).toBe(200);
    const items = asArray(queue.data.items, 'ordered').map((i) => asRecord(i, 'item'));
    const idxNewer = items.findIndex((i) => i.report_id === newer.reportId);
    const idxOlder = items.findIndex((i) => i.report_id === older.reportId);
    expect(idxNewer).toBeGreaterThanOrEqual(0);
    expect(idxOlder).toBeGreaterThan(idxNewer);
  });

  test('Viewing moderation queue appends admin.moderation_queue_viewed to audit_log', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);

    const before = await api.getAdminAuditLog<{ total: number }>(adminToken, {
      action: 'admin.moderation_queue_viewed',
    });
    expect(before.status).toBe(200);

    const q = await api.getAdminModerationQueue(adminToken, { status: 'open', limit: 7, offset: 0 });
    expect(q.status).toBe(200);

    const after = await api.getAdminAuditLog<{
      total: number;
      items: Array<Record<string, unknown>>;
    }>(adminToken, {
      action: 'admin.moderation_queue_viewed',
      limit: 5,
    });
    expect(after.status).toBe(200);
    expect(after.data.total).toBeGreaterThan(before.data.total);
    const latestMeta = asRecord(after.data.items[0]?.meta, 'meta');
    expect(latestMeta.status).toBe('open');
    expect(latestMeta.limit).toBe(7);
  });
});
