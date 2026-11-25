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

async function setupSwap(seedBase: number, confirmBoth: boolean): Promise<{
  apiA: SaathApiClient;
  apiB: SaathApiClient;
  tokenA: string;
  tokenB: string;
  swapId: string;
}> {
  const apiA = new SaathApiClient();
  const apiB = new SaathApiClient();
  const authA = await apiA.loginWithOtp(uniquePhone(seedBase + 1));
  const authB = await apiB.loginWithOtp(uniquePhone(seedBase + 2));

  const vA = await apiA.verifyTrainPnr(authA.access, TEST_PNRS.cycleA);
  const vB = await apiB.verifyTrainPnr(authB.access, TEST_PNRS.cycleB);
  const hubA = await apiA.getJourney(authA.access, getString(asRecord(vA.data.journey, 'jA'), 'id'));
  const hubB = await apiB.getJourney(authB.access, getString(asRecord(vB.data.journey, 'jB'), 'id'));
  const pA = getString(asRecord(hubA.data.party, 'pA'), 'id');
  const pB = getString(asRecord(hubB.data.party, 'pB'), 'id');

  await apiA.setGoal(authA.access, pA, {
    goal_type: 'lower',
    movers: [getString(asRecord(asArray(hubA.data.seat_holders, 'hA')[0], 'hA0'), 'id')],
    preferred_seats: [],
    constraints: { women_only: false, no_middle: false, same_coach_only: false, verified_only: false },
  });
  await apiB.setGoal(authB.access, pB, {
    goal_type: 'open_to_help',
    movers: [getString(asRecord(asArray(hubB.data.seat_holders, 'hB')[0], 'hB0'), 'id')],
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

  if (confirmBoth) {
    const a1 = await apiA.acceptSwap(authA.access, swapId, Number(swapRes.data.version ?? 0));
    await apiB.acceptSwap(authB.access, swapId, Number(a1.data.version ?? 1));
  }

  return { apiA, apiB, tokenA: authA.access, tokenB: authB.access, swapId };
}

test.describe('F18 Tier 2: Post-Journey Confirmation Edge Cases @tier2', () => {
  test('Non-participant User C cannot confirm completion (403/404)', async () => {
    const { swapId } = await setupSwap(182_000, true);
    const apiC = new SaathApiClient();
    const authC = await apiC.loginWithOtp(uniquePhone(182_099));

    const res = await apiC.confirmCompletion(authC.access, swapId, 'yes');
    apiC.assertProblemJson(res, [403, 404]);
  });

  test('Invalid completion answer enum returns 422 RFC 9457', async () => {
    const { apiA, tokenA, swapId } = await setupSwap(182_100, true);
    const res = await apiA.request('POST', `/v1/swaps/${swapId}/confirm-completion`, {
      token: tokenA,
      body: { answer: 'maybe_later' },
    });
    apiA.assertProblemJson(res, 422);
  });

  test('Conflicting duplicate confirmation (yes then no) is rejected cleanly', async () => {
    const { apiA, tokenA, swapId } = await setupSwap(182_200, true);
    const first = await apiA.confirmCompletion(tokenA, swapId, 'yes');
    expect(first.status).toBe(200);

    const second = await apiA.confirmCompletion(tokenA, swapId, 'no');
    apiA.assertProblemJson(second, [409, 422]);
  });

  test('Answer "no" disputes completion and withholds or reverses karma credit', async () => {
    const { apiA, apiB, tokenA, tokenB, swapId } = await setupSwap(182_300, true);
    await apiA.confirmCompletion(tokenA, swapId, 'yes');
    const resB = await apiB.confirmCompletion(tokenB, swapId, 'no');
    expect(resB.status).toBe(200);
    expect(['not_completed', 'disputed']).toContain(String(resB.data.status));

    const karmaB = await apiB.getKarma(tokenB);
    expect(Number(karmaB.data.balance ?? 0)).toBe(0);
  });

  test('Confirming completion on unconfirmed pending swap is rejected (409/422)', async () => {
    const { apiA, tokenA, swapId } = await setupSwap(182_400, false);
    const res = await apiA.confirmCompletion(tokenA, swapId, 'yes');
    apiA.assertProblemJson(res, [409, 422]);
  });
});
