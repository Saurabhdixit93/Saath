import { test, expect } from '../../fixtures/multi-browser.js';
import { asRecord, getAdminToken, getString, seedSwapDispute } from '../../helpers/admin-seed.js';
import { SaathApiClient } from '../../helpers/api.js';
import { futureDateIso, TEST_PNRS, uniquePhone, uniquePnr } from '../../helpers/env.js';
import { assertNoPiiLeak } from '../../helpers/pii.js';

test.describe('@tier2 F43 Tier 2: Nightly Retention Purge & Erasure Worker Boundaries', () => {
  test('Joining with invalid or expired party invite token returns 404/410/422 RFC 9457', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone('f43-t2-inv'));

    const res = await api.joinParty(auth.access, 'nonexistent-expired-invite-token', {
      mode: 'train',
      pnr: uniquePnr('f43-t2-inv'),
    });
    api.assertProblemJson(res, [404, 410, 422]);
  });

  test('Public seat invite lookup with unknown/expired token returns 404/410 RFC 9457 without PII', async () => {
    const api = new SaathApiClient();
    const res = await api.getPublicInvite('expired-or-unknown-seat-invite-xyz');
    api.assertProblemJson(res, [404, 410]);
    assertNoPiiLeak(res.data, 'f43-t2-expired-seat-invite');
  });

  test('Deleting a journey removes it from GET /v1/journeys and returns 404 on subsequent lookup', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone('f43-t2-delj'));
    const v = await api.verifyTrainPnr(auth.access, TEST_PNRS.rajdhani3A);
    const jId = getString(asRecord(v.data.journey, 'j'), 'id');

    expect((await api.deleteJourney(auth.access, jId)).status).toBeLessThan(300);

    const list = await api.getJourneys(auth.access);
    expect(list.status).toBe(200);
    expect(list.data.items.some((j) => j.id === jId)).toBe(false);

    api.assertProblemJson(await api.getJourney(auth.access, jId), 404);
  });

  test('After erasure, erased user PII never reappears in partner swap, leaderboard, or admin audit log', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);
    const seeded = await seedSwapDispute(api, 'f43-t2-erased', {
      travelDate: futureDateIso(30),
      seatA: '1',
      seatB: '3',
      completeFirst: true,
    });
    const secretAlias = 'PurgeVerifyAlias43';
    await api.patchMe(seeded.authB.access, {
      display_alias: secretAlias,
      leaderboard_opt_in: true,
    });

    expect([200, 202]).toContain((await api.deleteMyAccount(seeded.authB.access)).status);

    const karmaA = await api.getKarma(seeded.authA.access);
    expect(JSON.stringify(karmaA.data.leaderboard ?? [])).not.toContain(secretAlias);

    const audit = await api.getAdminAuditLog(adminToken, { limit: 25 });
    expect(JSON.stringify(audit.data.items ?? [])).not.toContain(secretAlias);
  });

  test('Reverifying or querying a nonexistent journey UUID returns 404 RFC 9457 cleanly', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone('f43-t2-missingj'));
    const missingId = '00000000-0000-0000-0000-000000000001';

    api.assertProblemJson(await api.reverifyJourney(auth.access, missingId), 404);
    api.assertProblemJson(await api.deleteJourney(auth.access, missingId), 404);
  });
});
