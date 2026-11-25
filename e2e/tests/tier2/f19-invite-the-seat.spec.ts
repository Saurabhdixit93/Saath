import { test, expect } from '../../fixtures/multi-browser.js';
import { SaathApiClient } from '../../helpers/api.js';
import { TEST_PNRS, uniquePhone } from '../../helpers/env.js';

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Expected object for ${label}`);
  }
  return value as Record<string, unknown>;
}

function getString(obj: Record<string, unknown>, key: string): string {
  const val = obj[key];
  if (typeof val !== 'string' || val.length === 0) {
    throw new Error(`Expected string "${key}"`);
  }
  return val;
}

test.describe('F19 Tier 2: Invite-the-Seat Boundary & AuthZ Cases @tier2', () => {
  test('Expired or unknown invite token returns 404 or 410 RFC 9457', async () => {
    const api = new SaathApiClient();
    const res = await api.getPublicInvite('expired-invite-token-99999');
    api.assertProblemJson(res, [404, 410]);
  });

  test('/j/[token] renders graceful expired/invalid UI fallback with Home CTA', async ({
    page,
  }) => {
    await page.goto('/j/invalid-seat-token-99999', { waitUntil: 'domcontentloaded' });
    await expect(
      page.getByText(/expired|invalid|not found|verify your PNR/i).first(),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: /Home|Verify|Start/i }).first()).toBeVisible();
  });

  test('Unauthenticated seat invite creation returns 401 RFC 9457', async () => {
    const api = new SaathApiClient();
    const res = await api.request('POST', '/v1/journeys/00000000-0000-0000-0000-000000000001/invite-seat', {
      body: { coach: 'B5' },
    });
    api.assertProblemJson(res, 401);
  });

  test('Non-owner User B cannot create seat invite on User A journey (403/404)', async () => {
    const apiA = new SaathApiClient();
    const apiB = new SaathApiClient();
    const authA = await apiA.loginWithOtp(uniquePhone(192_001));
    const authB = await apiB.loginWithOtp(uniquePhone(192_002));

    const vA = await apiA.verifyTrainPnr(authA.access, TEST_PNRS.rajdhani3A);
    const jId = getString(asRecord(vA.data.journey, 'jA'), 'id');

    const res = await apiB.createSeatInvite(authB.access, jId, { coach: 'B5' });
    apiB.assertProblemJson(res, [403, 404]);
  });

  test('Out-of-range seat target rejected 422 and visitor without open_to_help does not auto-enable it', async () => {
    const apiInv = new SaathApiClient();
    const apiVis = new SaathApiClient();
    const authInv = await apiInv.loginWithOtp(uniquePhone(192_003));
    const authVis = await apiVis.loginWithOtp(uniquePhone(192_004));

    const vInv = await apiInv.verifyTrainPnr(authInv.access, TEST_PNRS.cycleA);
    const jInv = getString(asRecord(vInv.data.journey, 'jInv'), 'id');

    const badSeat = await apiInv.createSeatInvite(authInv.access, jInv, {
      coach: 'Z99',
      seat_no: '999',
    });
    apiInv.assertProblemJson(badSeat, 422);

    const goodInvite = await apiInv.createSeatInvite(authInv.access, jInv, { coach: 'B5' });
    const inviteToken = String(goodInvite.data.token ?? '');

    const vVis = await apiVis.verifyJourney(authVis.access, {
      mode: 'train',
      pnr: TEST_PNRS.cycleB,
      invite_token: inviteToken,
      open_to_help: false,
    });
    expect(vVis.ok).toBe(true);
    const hubVis = await apiVis.getJourney(
      authVis.access,
      getString(asRecord(vVis.data.journey, 'jVis'), 'id'),
    );
    expect(hubVis.data.goal ?? null).toBeNull();
  });
});
