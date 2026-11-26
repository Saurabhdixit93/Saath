import { test, expect } from '../../fixtures/multi-browser.js';
import {
  createReportedMessage,
  getAdminToken,
  seedSwapDispute,
} from '../../helpers/admin-seed.js';
import { SaathApiClient } from '../../helpers/api.js';
import { E2E_ENV, futureDateIso, uniquePhone } from '../../helpers/env.js';
import { assertNoPiiLeak } from '../../helpers/pii.js';
import { SaathWsClient } from '../../helpers/ws-sse.js';

test.describe('@tier2 F42 Tier 2: Right to Erasure Boundaries', () => {
  test('Unauthenticated DELETE /v1/me returns 401 and anonymous JWT returns 401/403 RFC 9457', async () => {
    const api = new SaathApiClient();
    const anon = await api.issueAnonymousToken();

    api.assertProblemJson(await api.request('DELETE', '/v1/me'), 401);
    api.assertProblemJson(await api.deleteMyAccount(anon.data.access), [401, 403]);
  });

  test('Double DELETE /v1/me with already-erased JWT is rejected (401/403/404) RFC 9457', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone('f42-t2-double'));

    expect([200, 202]).toContain((await api.deleteMyAccount(auth.access)).status);
    api.assertProblemJson(await api.deleteMyAccount(auth.access), [401, 403, 404]);
  });

  test('Banned user cannot invoke DELETE /v1/me with revoked/banned session (401/403)', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);
    const rep = await createReportedMessage(api, 'f42-t2-banned', {
      travelDate: futureDateIso(28),
      seatA: '1',
      seatB: '3',
    });

    expect((await api.actOnModeration(adminToken, rep.reportId, 'ban')).status).toBe(200);
    api.assertProblemJson(await api.deleteMyAccount(rep.authB.access), [401, 403]);
  });

  test('Erased user JWT is rejected on /v1/ws WebSocket auth and /v1/events/stream SSE', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone('f42-t2-realtime'));
    expect([200, 202]).toContain((await api.deleteMyAccount(auth.access)).status);

    const ws = new SaathWsClient();
    await expect(ws.connectAndAuth(auth.access, 5000)).rejects.toThrow();
    await ws.close();

    const sseRes = await fetch(`${E2E_ENV.apiUrl}/v1/events/stream`, {
      headers: { Authorization: `Bearer ${auth.access}` },
    });
    expect([401, 403, 404]).toContain(sseRes.status);
  });

  test('Partner swap and data export never leak erased co-participant phone or display alias', async () => {
    const api = new SaathApiClient();
    const phoneB = uniquePhone('f42-t2-leak-b');
    const seeded = await seedSwapDispute(api, 'f42-t2-leak', {
      travelDate: futureDateIso(28),
      seatA: '4',
      seatB: '6',
      completeFirst: true,
    });
    const aliasB = 'ErasedAliasT2';
    await api.patchMe(seeded.authB.access, { display_alias: aliasB, leaderboard_opt_in: true });
    expect([200, 202]).toContain((await api.deleteMyAccount(seeded.authB.access)).status);

    const partnerSwap = await api.getSwap(seeded.authA.access, seeded.swapId);
    expect(partnerSwap.status).toBe(200);
    assertNoPiiLeak(partnerSwap.data, 'f42-t2-partner-swap', [phoneB, aliasB]);

    const partnerZip = await api.exportMyData(seeded.authA.access);
    expect(partnerZip.status).toBe(200);
    expect(partnerZip.buffer.toString('utf8')).not.toContain(aliasB);
  });
});
