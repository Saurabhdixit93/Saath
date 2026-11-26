import { test, expect } from '../../fixtures/multi-browser.js';
import {
  asArray,
  asRecord,
  getAdminToken,
  seedMatchedPairWithChat,
} from '../../helpers/admin-seed.js';
import { SaathApiClient } from '../../helpers/api.js';
import { futureDateIso, uniquePhone } from '../../helpers/env.js';
import { assertNoPiiLeak } from '../../helpers/pii.js';

test.describe('@tier2 F34 Tier 2: Moderation Queue & Context Boundaries', () => {
  test('Invalid status filter, limit=0, limit=201, and offset=-1 return 422 RFC 9457', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);

    api.assertProblemJson(
      await api.getAdminModerationQueue(adminToken, { status: 'unknown_status' }),
      422,
    );
    api.assertProblemJson(await api.getAdminModerationQueue(adminToken, { limit: 0 }), 422);
    api.assertProblemJson(await api.getAdminModerationQueue(adminToken, { limit: 201 }), 422);
    api.assertProblemJson(await api.getAdminModerationQueue(adminToken, { offset: -1 }), 422);
  });

  test('Conversation-level report without message_id renders cleanly with null message fields', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);
    const pair = await seedMatchedPairWithChat(api, 'f34-t2-convo-rep', {
      travelDate: futureDateIso(24),
      seatA: '1',
      seatB: '3',
    });

    const report = await api.reportUser<{ report_id: string }>(pair.authA.access, {
      conversation_id: pair.convoId,
      reason: 'inappropriate_profile',
    });
    expect([200, 201]).toContain(report.status);

    const queue = await api.getAdminModerationQueue(adminToken, { status: 'open', limit: 50 });
    expect(queue.status).toBe(200);
    const items = asArray(queue.data.items, 'items').map((i) => asRecord(i, 'item'));
    const found = items.find((i) => i.report_id === report.data.report_id);
    expect(found).toBeDefined();
    expect(found?.message_id).toBeNull();
    expect(found?.message_body).toBeNull();
  });

  test('Unauthenticated (401) and passenger JWT (403) cannot read moderation queue', async () => {
    const api = new SaathApiClient();
    const user = await api.loginWithOtp(uniquePhone('f34-t2-authz'));

    api.assertProblemJson(await api.request('GET', '/v1/admin/moderation/queue'), 401);
    api.assertProblemJson(await api.getAdminModerationQueue(user.access), 403);
  });

  test('Moderation queue response passes assertNoPiiLeak without raw phones, emails, or PNRs', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);

    const queue = await api.getAdminModerationQueue(adminToken, { status: 'all', limit: 50 });
    expect(queue.status).toBe(200);
    assertNoPiiLeak(queue.data, 'f34-t2-queue-no-pii');
  });

  test('Large offset past total returns empty items array with preserved total count', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);

    const queue = await api.getAdminModerationQueue(adminToken, {
      status: 'all',
      limit: 10,
      offset: 999_999,
    });
    expect(queue.status).toBe(200);
    expect(queue.data.items).toEqual([]);
    expect(typeof queue.data.total).toBe('number');
  });
});
