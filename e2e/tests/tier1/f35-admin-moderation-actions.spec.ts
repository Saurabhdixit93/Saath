import { test, expect } from '../../fixtures/multi-browser.js';
import {
  asArray,
  asRecord,
  createReportedMessage,
  getAdminToken,
} from '../../helpers/admin-seed.js';
import { SaathApiClient } from '../../helpers/api.js';
import { futureDateIso } from '../../helpers/env.js';

test.describe('@tier1 F35 (Feature 5): Moderation Actions (dismiss|hide|restrict|ban)', () => {
  test('dismiss closes report without restricting target user or blocking chat', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);
    const rep = await createReportedMessage(api, 'f35-dismiss', {
      travelDate: futureDateIso(24),
      seatA: '1',
      seatB: '3',
      reason: 'other',
    });

    const res = await api.actOnModeration(adminToken, rep.reportId, 'dismiss', 'Benign report');
    expect(res.status).toBe(200);
    expect(res.data.report_status).toBe('dismissed');
    expect(res.data.target_user_status).toBe('active');

    const followUp = await api.sendMessage(rep.authB.access, rep.convoId, 'Allowed after dismiss');
    expect([200, 201]).toContain(followUp.status);
  });

  test('hide marks message hidden and excludes it from non-sender conversation history', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);
    const rep = await createReportedMessage(api, 'f35-hide', {
      travelDate: futureDateIso(24),
      seatA: '4',
      seatB: '6',
      messageText: 'Abusive hidden content',
      reason: 'abuse',
    });

    const res = await api.actOnModeration(adminToken, rep.reportId, 'hide', 'Abusive language');
    expect(res.status).toBe(200);
    expect(res.data.report_status).toBe('actioned');
    expect(res.data.message_moderation).toBe('hidden');

    const msgsA = await api.getMessages(rep.authA.access, rep.convoId);
    expect(msgsA.status).toBe(200);
    const hiddenForRecipient = msgsA.data.items.find((m) => m.id === rep.messageId);
    expect(hiddenForRecipient).toBeUndefined();

    const actionedQueue = await api.getAdminModerationQueue(adminToken, {
      status: 'actioned',
      limit: 50,
    });
    expect(actionedQueue.status).toBe(200);
    const qItems = asArray(actionedQueue.data.items, 'actioned items').map((i) => asRecord(i, 'i'));
    const qRow = qItems.find((i) => i.report_id === rep.reportId);
    expect(qRow?.message_moderation).toBe('hidden');
  });

  test('restrict updates target_user_status=restricted and blocks subsequent chat messages with 403', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);
    const rep = await createReportedMessage(api, 'f35-restrict', {
      travelDate: futureDateIso(24),
      seatA: '9',
      seatB: '11',
      reason: 'spam',
    });

    const res = await api.actOnModeration(adminToken, rep.reportId, 'restrict', 'Chat spam');
    expect(res.status).toBe(200);
    expect(res.data.report_status).toBe('actioned');
    expect(res.data.target_user_status).toBe('restricted');

    const blockedSend = await api.sendMessage(rep.authB.access, rep.convoId, 'Should be blocked');
    api.assertProblemJson(blockedSend, 403);
  });

  test('ban sets target_user_status=banned, revokes refresh tokens, and invalidates pending swaps', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);
    const rep = await createReportedMessage(api, 'f35-ban', {
      travelDate: futureDateIso(24),
      seatA: '12',
      seatB: '14',
      reason: 'harassment',
      createPendingSwap: true,
    });

    const res = await api.actOnModeration(adminToken, rep.reportId, 'ban', 'Severe harassment');
    expect(res.status).toBe(200);
    expect(res.data.report_status).toBe('actioned');
    expect(res.data.target_user_status).toBe('banned');
    expect(Number(res.data.revoked_tokens)).toBeGreaterThanOrEqual(1);
    expect(Number(res.data.invalidated_swaps)).toBeGreaterThanOrEqual(1);

    const meAfterBan = await api.getMe(rep.authB.access);
    api.assertProblemJson(meAfterBan, [401, 403]);
    const refreshAfterBan = await api.refreshTokens(rep.authB.refresh);
    api.assertProblemJson(refreshAfterBan, [401, 403]);

    const partnerSwap = await api.getSwap(rep.authA.access, String(rep.swapId));
    expect(partnerSwap.status).toBe(200);
    expect(partnerSwap.data.status).toBe('invalidated');
  });

  test('Moderation actions append admin.moderation.<action> entries to audit_log', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);
    const rep = await createReportedMessage(api, 'f35-audit', {
      travelDate: futureDateIso(24),
      seatA: '17',
      seatB: '19',
      reason: 'abuse',
    });

    await api.actOnModeration(adminToken, rep.reportId, 'hide', 'Audit check note');

    const audit = await api.getAdminAuditLog<{
      items: Array<Record<string, unknown>>;
      total: number;
    }>(adminToken, {
      action: 'admin.moderation.hide',
      resource: `report:${rep.reportId}`,
      limit: 5,
    });
    expect(audit.status).toBe(200);
    expect(audit.data.total).toBe(1);
    const meta = asRecord(audit.data.items[0]?.meta, 'audit meta');
    expect(meta.note).toBe('Audit check note');
    expect(meta.target_user_id).toBe(rep.authB.user.id);
  });
});
