import { test, expect } from '@playwright/test';
import { SaathApiClient } from '../../helpers/api.js';
import { TEST_PNRS, uniquePhone } from '../../helpers/env.js';

function extractJourneyId(payload: Record<string, unknown>): string {
  const journey = payload.journey as { id?: string } | undefined;
  const id = journey?.id ?? (typeof payload.id === 'string' ? payload.id : undefined);
  if (!id) {
    throw new Error(`Missing journey id in payload: ${JSON.stringify(payload)}`);
  }
  return id;
}

function extractPartyId(payload: Record<string, unknown>): string {
  const party = payload.party as { id?: string } | undefined;
  const id = party?.id;
  if (!id) {
    throw new Error(`Missing party id in payload: ${JSON.stringify(payload)}`);
  }
  return id;
}

function extractSeatHolderIds(payload: Record<string, unknown>): string[] {
  const holders = payload.seat_holders as Array<{ id: string }> | undefined;
  if (!holders || holders.length === 0) {
    throw new Error(`Missing seat_holders in payload: ${JSON.stringify(payload)}`);
  }
  return holders.map((h) => h.id);
}

test.describe('@tier1 F05: Token-Derived Actor & Policy Layer', () => {
  test('GET /v1/me derives actor identity solely from Bearer EdDSA JWT', async () => {
    const api = new SaathApiClient();
    const userA = await api.loginWithOtp(uniquePhone('f05-actor-a'), 'whatsapp');

    const meRes = await api.getMe(userA.access);
    expect(meRes.status).toBe(200);
    expect(meRes.data.id).toBe(userA.user.id);
  });

  test('Verified journey owner is authorized to read Hub, CoachMap, and Party Matches', async () => {
    const api = new SaathApiClient();
    const userA = await api.loginWithOtp(uniquePhone('f05-owner'), 'whatsapp');
    const verified = await api.verifyTrainPnr(userA.access, TEST_PNRS.rajdhani3A);
    expect(verified.ok).toBe(true);

    const journeyId = extractJourneyId(verified.data);
    const partyId = extractPartyId(verified.data);

    const hub = await api.getJourney(userA.access, journeyId);
    expect(hub.status).toBe(200);

    const matches = await api.getMatches(userA.access, partyId);
    expect(matches.status).toBe(200);

    const coachMap = await api.getCoachMap(userA.access, journeyId, 'B3');
    expect([200, 404]).toContain(coachMap.status);
  });

  test('Party leader is authorized to generate invite and set goal for own party', async () => {
    const api = new SaathApiClient();
    const leader = await api.loginWithOtp(uniquePhone('f05-leader'), 'whatsapp');
    const verified = await api.verifyTrainPnr(leader.access, TEST_PNRS.rajdhani3A);
    expect(verified.ok).toBe(true);

    const journeyId = extractJourneyId(verified.data);
    const partyId = extractPartyId(verified.data);
    const movers = extractSeatHolderIds(verified.data);

    const invite = await api.createPartyInvite(leader.access, journeyId);
    expect([200, 201]).toContain(invite.status);
    expect(typeof invite.data.invite_url).toBe('string');

    const goal = await api.setGoal(leader.access, partyId, {
      goal_type: 'lower',
      movers,
      constraints: { women_only: false, no_middle: true },
    });
    expect([200, 201]).toContain(goal.status);
  });

  test('Public endpoints require no token while protected endpoints enforce Bearer auth', async () => {
    const api = new SaathApiClient();

    const stats = await api.getPublicStats();
    expect(stats.status).toBe(200);

    const plans = await api.getPricingPlans();
    expect(plans.status).toBe(200);

    const unauthMe = await api.request('GET', '/v1/me');
    api.assertProblemJson(unauthMe, 401);
    expect(unauthMe.status).toBe(401);

    const unauthJourneys = await api.request('GET', '/v1/journeys');
    api.assertProblemJson(unauthJourneys, 401);
    expect(unauthJourneys.status).toBe(401);
  });

  test('PATCH /v1/me updates only the token-derived user profile', async () => {
    const api = new SaathApiClient();
    const userA = await api.loginWithOtp(uniquePhone('f05-patch-a'), 'whatsapp');
    const userB = await api.loginWithOtp(uniquePhone('f05-patch-b'), 'whatsapp');

    const patchA = await api.patchMe(userA.access, {
      display_alias: 'TravelerAlpha',
      locale: 'hi',
    });
    expect(patchA.status).toBe(200);

    const meA = await api.getMe(userA.access);
    const meB = await api.getMe(userB.access);
    expect(meA.data.display_alias).toBe('TravelerAlpha');
    expect(meB.data.display_alias).not.toBe('TravelerAlpha');
  });
});
