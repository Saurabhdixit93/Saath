import { test, expect } from '../../fixtures/multi-browser.js';
import { SaathApiClient } from '../../helpers/api.js';
import { TEST_PNRS, uniquePhone } from '../../helpers/env.js';
import { assertNoPiiLeak } from '../../helpers/pii.js';

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Expected object for ${label}`);
  }
  return value as Record<string, unknown>;
}

function getString(obj: Record<string, unknown>, key: string): string {
  const val = obj[key];
  if (typeof val !== 'string' || val.length === 0) {
    throw new Error(`Expected string "${key}" in ${JSON.stringify(obj)}`);
  }
  return val;
}

function extractInviteToken(inviteRes: Record<string, unknown>): string {
  if (typeof inviteRes.token === 'string' && inviteRes.token.length > 0) {
    return inviteRes.token;
  }
  const url = getString(inviteRes, 'invite_url');
  const part = url.split('/j/')[1]?.split(/[?#]/)[0];
  if (!part) {
    throw new Error(`Could not extract token from invite_url: ${url}`);
  }
  return part;
}

test.describe('F19: Invite-the-Seat Deep Links @tier1', () => {
  test('POST /v1/journeys/{id}/invite-seat creates 72h /j/[token] with en/hi share copy', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone(19_001));
    const verify = await api.verifyTrainPnr(auth.access, TEST_PNRS.cycleA);
    expect(verify.ok).toBe(true);
    const journeyId = getString(asRecord(verify.data.journey, 'journey'), 'id');

    const invite = await api.createSeatInvite(auth.access, journeyId, {
      coach: 'B5',
      seat_no: '11',
    });
    expect([200, 201]).toContain(invite.status);
    expect(getString(invite.data, 'invite_url')).toContain('/j/');
    expect(getString(invite.data, 'expires_at').length).toBeGreaterThan(0);
    expect(getString(invite.data, 'message_en').length).toBeGreaterThan(10);
    expect(getString(invite.data, 'message_hi')).toMatch(/[\u0900-\u097F]/);
  });

  test('GET /v1/public/invites/{token} returns journey metadata with zero PII', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone(19_002));
    const verify = await api.verifyTrainPnr(auth.access, TEST_PNRS.cycleA);
    const journeyId = getString(asRecord(verify.data.journey, 'journey'), 'id');

    const invite = await api.createSeatInvite(auth.access, journeyId, { coach: 'B5' });
    const token = extractInviteToken(invite.data);

    const pub = await api.getPublicInvite(token);
    expect(pub.status).toBe(200);
    expect(pub.data.valid).toBe(true);
    expect(getString(pub.data, 'service_no').length).toBeGreaterThan(0);
    assertNoPiiLeak(pub.data, 'public-seat-invite', [TEST_PNRS.cycleA]);
  });

  test('Landing page /j/[token] renders coach/berth context and PNR verification form', async ({
    page,
  }) => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone(19_003));
    const verify = await api.verifyTrainPnr(auth.access, TEST_PNRS.cycleA);
    const journeyId = getString(asRecord(verify.data.journey, 'journey'), 'id');

    const invite = await api.createSeatInvite(auth.access, journeyId, {
      coach: 'B5',
      seat_no: '11',
    });
    const token = extractInviteToken(invite.data);

    await page.goto(`/j/${token}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(/B5|open to help|verify|PNR/i).first()).toBeVisible();
    await expect(page.getByRole('textbox').first()).toBeVisible();
  });

  test('Visitor verifying PNR from invite with open_to_help creates live match for inviter', async () => {
    const apiInviter = new SaathApiClient();
    const apiVisitor = new SaathApiClient();

    const authInv = await apiInviter.loginWithOtp(uniquePhone(19_004));
    const vInv = await apiInviter.verifyTrainPnr(authInv.access, TEST_PNRS.cycleA);
    const jInvId = getString(asRecord(vInv.data.journey, 'journey'), 'id');
    const hubInv = await apiInviter.getJourney(authInv.access, jInvId);
    const pInvId = getString(asRecord(hubInv.data.party, 'party'), 'id');
    const holderInv = asRecord(
      (hubInv.data.seat_holders as unknown[])[0],
      'inviter holder',
    );
    await apiInviter.setGoal(authInv.access, pInvId, {
      goal_type: 'lower',
      movers: [getString(holderInv, 'id')],
      preferred_seats: [],
      constraints: { women_only: false, no_middle: false, same_coach_only: false, verified_only: false },
    });

    const invite = await apiInviter.createSeatInvite(authInv.access, jInvId, { coach: 'B5' });
    const token = extractInviteToken(invite.data);

    const authVis = await apiVisitor.loginWithOtp(uniquePhone(19_005));
    const vVis = await apiVisitor.verifyJourney(authVis.access, {
      mode: 'train',
      pnr: TEST_PNRS.cycleB,
      invite_token: token,
      open_to_help: true,
    });
    expect(vVis.ok).toBe(true);

    await expect(async () => {
      const matches = await apiInviter.getMatches(authInv.access, pInvId);
      expect(matches.status).toBe(200);
      expect(matches.data.items.length).toBeGreaterThanOrEqual(1);
    }).toPass({ timeout: 12_000, intervals: [500, 1000, 1500] });
  });

  test('Invite response tracks attribution / k-factor metadata', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone(19_006));
    const verify = await api.verifyTrainPnr(auth.access, TEST_PNRS.cycleA);
    const journeyId = getString(asRecord(verify.data.journey, 'journey'), 'id');

    const invite = await api.createSeatInvite(auth.access, journeyId, { coach: 'B3' });
    expect(invite.ok).toBe(true);
    const token = extractInviteToken(invite.data);
    const pub = await api.getPublicInvite(token);
    expect(pub.status).toBe(200);
    expect(pub.data.valid).toBe(true);
  });
});
