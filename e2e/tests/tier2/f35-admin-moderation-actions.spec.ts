import { test, expect } from '../../fixtures/multi-browser.js';
import { createReportedMessage, getAdminToken } from '../../helpers/admin-seed.js';
import { SaathApiClient } from '../../helpers/api.js';
import { futureDateIso, uniquePhone } from '../../helpers/env.js';
import { SaathWsClient } from '../../helpers/ws-sse.js';

test.describe('@tier2 F35 Tier 2: Moderation Actions Boundaries', () => {
  test('Malformed UUID returns 422 and nonexistent report UUID returns 404 RFC 9457', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);

    api.assertProblemJson(
      await api.actOnModeration(adminToken, 'not-a-uuid', 'dismiss'),
      422,
    );
    api.assertProblemJson(
      await api.actOnModeration(adminToken, '00000000-0000-0000-0000-000000000001', 'dismiss'),
      404,
    );
  });

  test('Invalid moderation action, oversized note (>500), and extra body fields return 422 on real report', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);
    const rep = await createReportedMessage(api, 'f35-t2-val', {
      travelDate: futureDateIso(25),
      seatA: '1',
      seatB: '3',
    });

    api.assertProblemJson(
      await api.actOnModeration(adminToken, rep.reportId, 'invalid_action_xyz'),
      422,
    );
    api.assertProblemJson(
      await api.actOnModeration(adminToken, rep.reportId, 'dismiss', 'x'.repeat(501)),
      422,
    );
    api.assertProblemJson(
      await api.request('POST', `/v1/admin/moderation/${rep.reportId}/action`, {
        token: adminToken,
        body: { action: 'dismiss', extra_field: true },
      }),
      422,
    );
  });

  test('Unauthenticated (401) and passenger JWT (403) cannot execute moderation actions', async () => {
    const api = new SaathApiClient();
    const user = await api.loginWithOtp(uniquePhone('f35-t2-authz'));
    const reportId = '00000000-0000-0000-0000-000000000001';

    api.assertProblemJson(
      await api.request('POST', `/v1/admin/moderation/${reportId}/action`, {
        body: { action: 'dismiss' },
      }),
      401,
    );
    api.assertProblemJson(await api.actOnModeration(user.access, reportId, 'dismiss'), 403);
  });

  test('Restricted user is blocked (403) on sendMessage and createConversation', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);
    const rep = await createReportedMessage(api, 'f35-t2-restrict', {
      travelDate: futureDateIso(25),
      seatA: '4',
      seatB: '6',
    });

    expect((await api.actOnModeration(adminToken, rep.reportId, 'restrict')).status).toBe(200);

    api.assertProblemJson(
      await api.sendMessage(rep.authB.access, rep.convoId, 'Blocked chat message'),
      403,
    );
    api.assertProblemJson(await api.createConversation(rep.authB.access, rep.cardId), 403);
  });

  test('Banned user is rejected on /v1/ws WebSocket auth and createSwap', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);
    const rep = await createReportedMessage(api, 'f35-t2-ban-ws', {
      travelDate: futureDateIso(25),
      seatA: '9',
      seatB: '11',
    });

    expect((await api.actOnModeration(adminToken, rep.reportId, 'ban')).status).toBe(200);

    api.assertProblemJson(await api.createSwap(rep.authB.access, rep.cardId), [401, 403]);

    const ws = new SaathWsClient();
    await expect(ws.connectAndAuth(rep.authB.access, 5000)).rejects.toThrow();
    await ws.close();
  });
});
