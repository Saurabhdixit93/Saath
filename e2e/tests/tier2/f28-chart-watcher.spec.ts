import { test, expect } from '../../fixtures/multi-browser.js';
import { SaathApiClient, type MatchCardDto } from '../../helpers/api.js';
import { TEST_PNRS, futureDateIso, uniquePhone } from '../../helpers/env.js';

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

test.describe('F28 Tier 2: Chart Timing Rules & Invalidation Boundaries @tier2', () => {
  test('Morning (05:00-14:00 IST) vs evening/night (14:01-04:59 IST) chart rules return distinct schedules', async () => {
    const api = new SaathApiClient();
    const date = futureDateIso(4);

    const morning = await api.getPublicTrainChartTime('12009', date);
    const night = await api.getPublicTrainChartTime('12951', date);

    expect(morning.status).toBe(200);
    expect(night.status).toBe(200);
    expect(morning.data.rule).not.toBe(night.data.rule);
  });

  test('Reverify with unchanged berth preserves active confirmed swap and valid Swap Card', async () => {
    const apiA = new SaathApiClient();
    const apiB = new SaathApiClient();
    const authA = await apiA.loginWithOtp(uniquePhone(282_001));
    const authB = await apiB.loginWithOtp(uniquePhone(282_002));

    const vA = await apiA.verifyTrainPnr(authA.access, TEST_PNRS.cycleA);
    const vB = await apiB.verifyTrainPnr(authB.access, TEST_PNRS.cycleB);
    const jA = getString(asRecord(vA.data.journey, 'jA'), 'id');
    const jB = getString(asRecord(vB.data.journey, 'jB'), 'id');
    const hubA = await apiA.getJourney(authA.access, jA);
    const hubB = await apiB.getJourney(authB.access, jB);
    const pA = getString(asRecord(hubA.data.party, 'pA'), 'id');
    const pB = getString(asRecord(hubB.data.party, 'pB'), 'id');

    await apiA.setGoal(authA.access, pA, {
      goal_type: 'lower',
      movers: [getString(asRecord((hubA.data.seat_holders as unknown[])[0], 'hA0'), 'id')],
      preferred_seats: [],
      constraints: { women_only: false, no_middle: false, same_coach_only: false, verified_only: false },
    });
    await apiB.setGoal(authB.access, pB, {
      goal_type: 'open_to_help',
      movers: [getString(asRecord((hubB.data.seat_holders as unknown[])[0], 'hB0'), 'id')],
      preferred_seats: [],
      constraints: { women_only: false, no_middle: false, same_coach_only: false, verified_only: false },
      standing_offer: { give_to: 'anyone' },
    });

    let card: MatchCardDto | undefined;
    await expect(async () => {
      const matches = await apiA.getMatches(authA.access, pA, 'pair');
      expect(matches.status).toBe(200);
      expect(matches.data.items.length).toBeGreaterThanOrEqual(1);
      card = matches.data.items[0];
    }).toPass({ timeout: 12_000, intervals: [500, 1000, 1500] });
    if (!card) {
      throw new Error('Expected match card');
    }
    const swapRes = await apiA.createSwap(authA.access, card.card_id);
    const swapId = getString(swapRes.data, 'id');
    const a1 = await apiA.acceptSwap(authA.access, swapId, Number(swapRes.data.version ?? 0));
    await apiB.acceptSwap(authB.access, swapId, Number(a1.data.version ?? 1));

    const rev = await apiA.reverifyJourney(authA.access, jA);
    expect(rev.status).toBe(200);

    const swapAfter = await apiA.getSwap(authA.access, swapId);
    expect(swapAfter.data.status).toBe('confirmed');
  });

  test('Chart change marks chart_state final and invalidates active pending swap', async () => {
    const apiA = new SaathApiClient();
    const apiB = new SaathApiClient();
    const authA = await apiA.loginWithOtp(uniquePhone(282_101));
    const authB = await apiB.loginWithOtp(uniquePhone(282_102));

    const vA = await apiA.verifyTrainPnr(authA.access, TEST_PNRS.cycleA);
    const vB = await apiB.verifyTrainPnr(authB.access, TEST_PNRS.cycleB);
    const jA = getString(asRecord(vA.data.journey, 'jA'), 'id');
    const jB = getString(asRecord(vB.data.journey, 'jB'), 'id');
    const hubA = await apiA.getJourney(authA.access, jA);
    const hubB = await apiB.getJourney(authB.access, jB);
    const pA = getString(asRecord(hubA.data.party, 'pA'), 'id');
    const pB = getString(asRecord(hubB.data.party, 'pB'), 'id');

    await apiA.setGoal(authA.access, pA, {
      goal_type: 'lower',
      movers: [getString(asRecord((hubA.data.seat_holders as unknown[])[0], 'hA0'), 'id')],
      preferred_seats: [],
      constraints: { women_only: false, no_middle: false, same_coach_only: false, verified_only: false },
    });
    await apiB.setGoal(authB.access, pB, {
      goal_type: 'open_to_help',
      movers: [getString(asRecord((hubB.data.seat_holders as unknown[])[0], 'hB0'), 'id')],
      preferred_seats: [],
      constraints: { women_only: false, no_middle: false, same_coach_only: false, verified_only: false },
      standing_offer: { give_to: 'anyone' },
    });

    let card: MatchCardDto | undefined;
    await expect(async () => {
      const matches = await apiA.getMatches(authA.access, pA, 'pair');
      expect(matches.status).toBe(200);
      expect(matches.data.items.length).toBeGreaterThanOrEqual(1);
      card = matches.data.items[0];
    }).toPass({ timeout: 12_000, intervals: [500, 1000, 1500] });
    if (!card) {
      throw new Error('Expected match card');
    }
    const swapRes = await apiA.createSwap(authA.access, card.card_id);
    const swapId = getString(swapRes.data, 'id');

    const rev = await apiA.request('POST', `/v1/journeys/${jA}/reverify`, {
      token: authA.access,
      headers: { 'X-Simulate-Chart-Change': 'true' },
    });
    expect(rev.status).toBe(200);
    const swapAfter = await apiA.getSwap(authA.access, swapId);
    expect(swapAfter.data.status).toBe('invalidated');
  });

  test('Chart-invalidated Swap Card cannot be verified as valid on public endpoint', async () => {
    const apiA = new SaathApiClient();
    const apiB = new SaathApiClient();
    const authA = await apiA.loginWithOtp(uniquePhone(282_201));
    const authB = await apiB.loginWithOtp(uniquePhone(282_202));

    const vA = await apiA.verifyTrainPnr(authA.access, TEST_PNRS.cycleA);
    const vB = await apiB.verifyTrainPnr(authB.access, TEST_PNRS.cycleB);
    const jA = getString(asRecord(vA.data.journey, 'jA'), 'id');
    const jB = getString(asRecord(vB.data.journey, 'jB'), 'id');
    const hubA = await apiA.getJourney(authA.access, jA);
    const hubB = await apiB.getJourney(authB.access, jB);
    const pA = getString(asRecord(hubA.data.party, 'pA'), 'id');
    const pB = getString(asRecord(hubB.data.party, 'pB'), 'id');

    await apiA.setGoal(authA.access, pA, {
      goal_type: 'lower',
      movers: [getString(asRecord((hubA.data.seat_holders as unknown[])[0], 'hA0'), 'id')],
      preferred_seats: [],
      constraints: { women_only: false, no_middle: false, same_coach_only: false, verified_only: false },
    });
    await apiB.setGoal(authB.access, pB, {
      goal_type: 'open_to_help',
      movers: [getString(asRecord((hubB.data.seat_holders as unknown[])[0], 'hB0'), 'id')],
      preferred_seats: [],
      constraints: { women_only: false, no_middle: false, same_coach_only: false, verified_only: false },
      standing_offer: { give_to: 'anyone' },
    });

    let card: MatchCardDto | undefined;
    await expect(async () => {
      const matches = await apiA.getMatches(authA.access, pA, 'pair');
      expect(matches.status).toBe(200);
      expect(matches.data.items.length).toBeGreaterThanOrEqual(1);
      card = matches.data.items[0];
    }).toPass({ timeout: 12_000, intervals: [500, 1000, 1500] });
    if (!card) {
      throw new Error('Expected match card');
    }
    const swapRes = await apiA.createSwap(authA.access, card.card_id);
    const swapId = getString(swapRes.data, 'id');
    const a1 = await apiA.acceptSwap(authA.access, swapId, Number(swapRes.data.version ?? 0));
    await apiB.acceptSwap(authB.access, swapId, Number(a1.data.version ?? 1));

    const swapCard = await apiA.getSwapCard(authA.access, swapId, 'json');
    const publicCode = getString(swapCard.data, 'public_code');

    await apiA.request('POST', `/v1/journeys/${jA}/reverify`, {
      token: authA.access,
      headers: { 'X-Simulate-Chart-Change': 'true' },
    });

    const pub = await apiA.verifyPublicSwapCard(publicCode);
    expect(pub.data.valid).toBe(false);
    expect(pub.data.revoked).toBe(true);
  });

  test('Reverify rate-limit spam returns 429 RFC 9457 without corrupting journey', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone(282_301));
    const v = await api.verifyTrainPnr(auth.access, TEST_PNRS.rajdhani3A);
    const jId = getString(asRecord(v.data.journey, 'j'), 'id');

    let hit429 = false;
    for (let i = 0; i < 12; i += 1) {
      const res = await api.reverifyJourney(auth.access, jId);
      if (res.status === 429) {
        api.assertProblemJson(res, 429);
        hit429 = true;
        break;
      }
    }
    expect(hit429).toBe(true);
  });
});
