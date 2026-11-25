import { test, expect } from '../../fixtures/multi-browser.js';
import { SaathApiClient, type MatchCardDto } from '../../helpers/api.js';
import { TEST_PNRS, uniquePhone } from '../../helpers/env.js';

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Expected object for ${label}`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Expected array for ${label}`);
  }
  return value;
}

function getString(obj: Record<string, unknown>, key: string): string {
  const val = obj[key];
  if (typeof val !== 'string' || val.length === 0) {
    throw new Error(`Expected string "${key}"`);
  }
  return val;
}

async function completePairSwap(
  apiA: SaathApiClient,
  tokenA: string,
  apiB: SaathApiClient,
  tokenB: string,
  pnrA: string,
  pnrB: string,
): Promise<string> {
  const vA = await apiA.verifyTrainPnr(tokenA, pnrA);
  const vB = await apiB.verifyTrainPnr(tokenB, pnrB);
  const hubA = await apiA.getJourney(tokenA, getString(asRecord(vA.data.journey, 'jA'), 'id'));
  const hubB = await apiB.getJourney(tokenB, getString(asRecord(vB.data.journey, 'jB'), 'id'));
  const pA = getString(asRecord(hubA.data.party, 'pA'), 'id');
  const pB = getString(asRecord(hubB.data.party, 'pB'), 'id');

  await apiA.setGoal(tokenA, pA, {
    goal_type: 'lower',
    movers: [getString(asRecord(asArray(hubA.data.seat_holders, 'hA')[0], 'hA0'), 'id')],
    preferred_seats: [],
    constraints: { women_only: false, no_middle: false, same_coach_only: false, verified_only: false },
  });
  await apiB.setGoal(tokenB, pB, {
    goal_type: 'open_to_help',
    movers: [getString(asRecord(asArray(hubB.data.seat_holders, 'hB')[0], 'hB0'), 'id')],
    preferred_seats: [],
    constraints: { women_only: false, no_middle: false, same_coach_only: false, verified_only: false },
    standing_offer: { give_to: 'anyone' },
  });

  let card: MatchCardDto | undefined;
  await expect(async () => {
    const matches = await apiA.getMatches(tokenA, pA, 'pair');
    expect(matches.status).toBe(200);
    expect(matches.data.items.length).toBeGreaterThanOrEqual(1);
    card = matches.data.items[0];
  }).toPass({ timeout: 12_000, intervals: [500, 1000, 1500] });
  if (!card) {
    throw new Error('Expected match card');
  }
  const swapRes = await apiA.createSwap(tokenA, card.card_id);
  const swapId = getString(swapRes.data, 'id');
  const a1 = await apiA.acceptSwap(tokenA, swapId, Number(swapRes.data.version ?? 0));
  await apiB.acceptSwap(tokenB, swapId, Number(a1.data.version ?? 1));
  return swapId;
}

test.describe('F21 Tier 2: Karma Anti-Fraud Caps & Ledger Invariants @tier2', () => {
  test('Unauthenticated GET /v1/karma returns 401 RFC 9457', async () => {
    const api = new SaathApiClient();
    const res = await api.request('GET', '/v1/karma');
    api.assertProblemJson(res, 401);
  });

  test('Same-pair 90-day anti-fraud cap blocks duplicate karma on second swap between same users', async () => {
    const apiA = new SaathApiClient();
    const apiB = new SaathApiClient();
    const authA = await apiA.loginWithOtp(uniquePhone(212_001));
    const authB = await apiB.loginWithOtp(uniquePhone(212_002));

    const swap1 = await completePairSwap(
      apiA,
      authA.access,
      apiB,
      authB.access,
      TEST_PNRS.cycleA,
      TEST_PNRS.cycleB,
    );
    await apiA.confirmCompletion(authA.access, swap1, 'yes');
    await apiB.confirmCompletion(authB.access, swap1, 'yes');

    const karmaAfter1 = await apiB.getKarma(authB.access);
    const bal1 = Number(karmaAfter1.data.balance ?? 0);

    const swap2 = await completePairSwap(
      apiA,
      authA.access,
      apiB,
      authB.access,
      TEST_PNRS.sleeperSL,
      TEST_PNRS.rajdhani3A,
    );
    await apiA.confirmCompletion(authA.access, swap2, 'yes');
    await apiB.confirmCompletion(authB.access, swap2, 'yes');

    const karmaAfter2 = await apiB.getKarma(authB.access);
    const bal2 = Number(karmaAfter2.data.balance ?? 0);
    expect(bal2).toBe(bal1);
  });

  test('Ledger balance invariant holds: balance === sum(credited) - sum(reversed)', async () => {
    const apiA = new SaathApiClient();
    const apiB = new SaathApiClient();
    const authA = await apiA.loginWithOtp(uniquePhone(212_003));
    const authB = await apiB.loginWithOtp(uniquePhone(212_004));

    const swapId = await completePairSwap(
      apiA,
      authA.access,
      apiB,
      authB.access,
      TEST_PNRS.cycleA,
      TEST_PNRS.cycleB,
    );
    await apiA.confirmCompletion(authA.access, swapId, 'yes');
    await apiB.confirmCompletion(authB.access, swapId, 'yes');

    const karma = await apiB.getKarma(authB.access);
    const history = asArray(karma.data.history, 'history').map((h) => asRecord(h, 'entry'));
    const computed = history.reduce((acc, row) => {
      const state = String(row.state ?? row.status ?? '');
      const pts = Number(row.points ?? row.delta ?? 0);
      if (state === 'credited') return acc + pts;
      if (state === 'reversed') return acc - Math.abs(pts);
      return acc;
    }, 0);
    expect(Number(karma.data.balance)).toBe(computed);
  });

  test('User with leaderboard_opt_in=false is omitted from leaderboard results', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone(212_005));
    await api.patchMe(auth.access, {
      leaderboard_opt_in: false,
      display_alias: 'PrivateRider212',
    });

    const karma = await api.getKarma(auth.access);
    const board = JSON.stringify(karma.data.leaderboard ?? []);
    expect(board).not.toContain('PrivateRider212');
  });

  test('Feature-flagged rewards catalogue rejects redemption when disabled', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone(212_006));
    const res = await api.request('POST', '/v1/karma/rewards/redeem', {
      token: auth.access,
      body: { reward_code: 'chai_voucher' },
    });
    api.assertProblemJson(res, [403, 404, 422]);
  });
});
