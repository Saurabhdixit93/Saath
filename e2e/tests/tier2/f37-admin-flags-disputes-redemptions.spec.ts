import { test, expect } from '../../fixtures/multi-browser.js';
import { getAdminToken, seedSwapDispute } from '../../helpers/admin-seed.js';
import { SaathApiClient } from '../../helpers/api.js';
import { futureDateIso, uniquePhone } from '../../helpers/env.js';

test.describe('@tier2 F37 Tier 2: Feature Flags, Disputes & Redemptions Boundaries', () => {
  test('Unauthenticated (401) and passenger JWT (403) are rejected on flags, disputes, and redemptions', async () => {
    const api = new SaathApiClient();
    const user = await api.loginWithOtp(uniquePhone('f37-t2-authz'));

    for (const path of ['/v1/admin/flags', '/v1/admin/disputes', '/v1/admin/redemptions']) {
      api.assertProblemJson(await api.request('GET', path), 401);
      api.assertProblemJson(await api.request('GET', path, { token: user.access }), 403);
    }
  });

  test('Unknown feature flag returns 404 and invalid PATCH body returns 422 RFC 9457', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);

    api.assertProblemJson(await api.patchAdminFlag(adminToken, 'unknown_flag_xyz', true), 404);
    api.assertProblemJson(
      await api.request('PATCH', '/v1/admin/flags/rewards_catalogue_enabled', {
        token: adminToken,
        body: { value: true, extra_unknown: 1 },
      }),
      422,
    );
    api.assertProblemJson(
      await api.request('PATCH', '/v1/admin/flags/rewards_catalogue_enabled', {
        token: adminToken,
        body: {},
      }),
      422,
    );
  });

  test('Unknown dispute returns 404, malformed UUID returns 422, and legacy resolution body returns 422', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);
    const missingId = '00000000-0000-0000-0000-000000000001';

    api.assertProblemJson(
      await api.overrideAdminDispute(adminToken, missingId, { action: 'complete' }),
      404,
    );
    api.assertProblemJson(
      await api.overrideAdminDispute(adminToken, 'bad-uuid', { action: 'complete' }),
      422,
    );
    api.assertProblemJson(
      await api.request('POST', `/v1/admin/disputes/${missingId}/override`, {
        token: adminToken,
        body: { resolution: 'mark_completed', note: 'legacy invalid key' },
      }),
      422,
    );
  });

  test('Calling action=clear_conflict on a swap_dispute returns 409 invalid_dispute_action', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);
    const seeded = await seedSwapDispute(api, 'f37-t2-conflict', {
      travelDate: futureDateIso(26),
      seatA: '1',
      seatB: '3',
    });

    const res = await api.overrideAdminDispute(adminToken, seeded.swapId, {
      action: 'clear_conflict',
      note: 'Invalid action for swap dispute',
    });
    api.assertProblemJson(res, 409, 'invalid_dispute_action');
  });

  test('Unknown redemption returns 404 and invalid action or legacy decision body returns 422', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);
    const missingId = '00000000-0000-0000-0000-000000000001';

    api.assertProblemJson(
      await api.reviewAdminRedemption(adminToken, missingId, { action: 'approve' }),
      404,
    );
    api.assertProblemJson(
      await api.reviewAdminRedemption(adminToken, 'not-a-uuid', { action: 'approve' }),
      422,
    );
    api.assertProblemJson(
      await api.request('POST', `/v1/admin/redemptions/${missingId}/review`, {
        token: adminToken,
        body: { decision: 'approve', note: 'legacy invalid key' },
      }),
      422,
    );
  });
});
