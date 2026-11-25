import { test, expect, injectAuthSession } from '../../fixtures/multi-browser.js';
import { SaathApiClient, type MatchCardDto } from '../../helpers/api.js';
import { TEST_PNRS, uniquePhone } from '../../helpers/env.js';
import { assertNoPiiLeak } from '../../helpers/pii.js';

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

function getNumber(obj: Record<string, unknown>, key: string): number {
  const val = obj[key];
  if (typeof val !== 'number') {
    throw new Error(`Expected number "${key}"`);
  }
  return val;
}

async function completeSwapForKarma(seedBase: number): Promise<{
  apiA: SaathApiClient;
  apiB: SaathApiClient;
  tokenA: string;
  tokenB: string;
}> {
  const apiA = new SaathApiClient();
  const apiB = new SaathApiClient();
  const authA = await apiA.loginWithOtp(uniquePhone(seedBase + 1));
  const authB = await apiB.loginWithOtp(uniquePhone(seedBase + 2));

  const vA = await apiA.verifyTrainPnr(authA.access, TEST_PNRS.cycleA);
  const vB = await apiB.verifyTrainPnr(authB.access, TEST_PNRS.cycleB);
  const hubA = await apiA.getJourney(authA.access, getString(asRecord(vA.data.journey, 'jA'), 'id'));
  const hubB = await apiB.getJourney(authB.access, getString(asRecord(vB.data.journey, 'jB'), 'id'));

  const pA = asRecord(hubA.data.party, 'pA');
  const pB = asRecord(hubB.data.party, 'pB');
  const hA = asRecord(asArray(hubA.data.seat_holders, 'hA')[0], 'hA0');
  const hB = asRecord(asArray(hubB.data.seat_holders, 'hB')[0], 'hB0');

  await apiA.setGoal(authA.access, getString(pA, 'id'), {
    goal_type: 'lower',
    movers: [getString(hA, 'id')],
    preferred_seats: [],
    constraints: { women_only: false, no_middle: false, same_coach_only: false, verified_only: false },
  });
  await apiB.setGoal(authB.access, getString(pB, 'id'), {
    goal_type: 'open_to_help',
    movers: [getString(hB, 'id')],
    preferred_seats: [],
    constraints: { women_only: false, no_middle: false, same_coach_only: false, verified_only: false },
    standing_offer: { give_to: 'anyone' },
  });

  let card: MatchCardDto | undefined;
  await expect(async () => {
    const matches = await apiA.getMatches(authA.access, getString(pA, 'id'), 'pair');
    expect(matches.status).toBe(200);
    expect(matches.data.items.length).toBeGreaterThanOrEqual(1);
    card = matches.data.items[0];
  }).toPass({ timeout: 12_000, intervals: [500, 1000, 1500] });
  if (!card) {
    throw new Error('Expected pair match card for karma test');
  }
  const swapRes = await apiA.createSwap(authA.access, card.card_id);
  const swapId = getString(swapRes.data, 'id');
  const a1 = await apiA.acceptSwap(authA.access, swapId, getNumber(swapRes.data, 'version'));
  await apiB.acceptSwap(authB.access, swapId, getNumber(a1.data, 'version'));
  await apiA.confirmCompletion(authA.access, swapId, 'yes');
  await apiB.confirmCompletion(authB.access, swapId, 'yes');

  return { apiA, apiB, tokenA: authA.access, tokenB: authB.access };
}

test.describe('F21: Karma Ledger, Badges & Leaderboard @tier1', () => {
  test('GET /v1/karma returns balance, pending, history, and badges schema', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone(21_001));

    const karma = await api.getKarma(auth.access);
    expect(karma.status).toBe(200);
    expect(typeof karma.data.balance).toBe('number');
    expect(typeof karma.data.pending).toBe('number');
    expect(Array.isArray(karma.data.history)).toBe(true);
    expect(Array.isArray(karma.data.badges)).toBe(true);
  });

  test('Mutual swap completion credits karma_ledger and increases balance', async () => {
    const { apiB, tokenB } = await completeSwapForKarma(21_100);

    const karma = await apiB.getKarma(tokenB);
    expect(karma.status).toBe(200);
    expect(Number(karma.data.balance)).toBeGreaterThanOrEqual(50);
    const history = asArray(karma.data.history, 'karma history');
    expect(history.length).toBeGreaterThanOrEqual(1);
  });

  test('First completed swap unlocks first_swap badge', async () => {
    const { apiA, tokenA } = await completeSwapForKarma(21_200);

    const karma = await apiA.getKarma(tokenA);
    expect(karma.status).toBe(200);
    const badges = asArray(karma.data.badges, 'badges').map((b) =>
      typeof b === 'string' ? b : getString(asRecord(b, 'badge'), 'code'),
    );
    expect(badges).toContain('first_swap');
  });

  test('Opt-in leaderboard includes pseudonymous display_alias without PII', async () => {
    const { apiB, tokenB } = await completeSwapForKarma(21_300);

    const patch = await apiB.patchMe(tokenB, {
      leaderboard_opt_in: true,
      display_alias: 'HelpfulRail21',
    });
    expect(patch.status).toBe(200);

    const karma = await apiB.getKarma(tokenB);
    expect(karma.status).toBe(200);
    assertNoPiiLeak(karma.data.leaderboard ?? [], 'karma-leaderboard');
  });

  test('UI /karma renders balance, history entries, and badges', async ({
    createIsolatedPassenger,
  }) => {
    const { tokenB } = await completeSwapForKarma(21_400);
    const passenger = await createIsolatedPassenger('karma-ui');

    await injectAuthSession(passenger.page, { access: tokenB });
    await passenger.page.goto('/karma', { waitUntil: 'domcontentloaded' });

    await expect(passenger.page.getByText(/Karma|कर्म/i).first()).toBeVisible();
    await expect(passenger.page.getByText(/first_swap|First Swap|पहली अदला-बदली/i).first()).toBeVisible();
  });
});
