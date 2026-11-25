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

async function setupPendingPairSwap(seedBase: number): Promise<{
  apiA: SaathApiClient;
  apiB: SaathApiClient;
  tokenA: string;
  tokenB: string;
  journeyAId: string;
  swapId: string;
}> {
  const apiA = new SaathApiClient();
  const apiB = new SaathApiClient();
  const authA = await apiA.loginWithOtp(uniquePhone(seedBase + 1));
  const authB = await apiB.loginWithOtp(uniquePhone(seedBase + 2));

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
  return {
    apiA,
    apiB,
    tokenA: authA.access,
    tokenB: authB.access,
    journeyAId: jA,
    swapId: getString(swapRes.data, 'id'),
  };
}

test.describe('F17 Tier 2: Swap Card & Public Verify Boundary Cases @tier2', () => {
  test('Unknown Swap Card code returns 404 RFC 9457 and /v/[code] renders not-found state', async ({
    page,
  }) => {
    const api = new SaathApiClient();
    const res = await api.verifyPublicSwapCard('SW-ZZZZ99');
    api.assertProblemJson(res, 404);

    await page.goto('/v/SW-ZZZZ99', { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(/Not found|Invalid|Unknown|404/i).first()).toBeVisible();
  });

  test('Requesting Swap Card for unconfirmed pending swap returns 409 or 404', async () => {
    const { apiA, tokenA, swapId } = await setupPendingPairSwap(172_000);
    const res = await apiA.getSwapCard(tokenA, swapId, 'json');
    apiA.assertProblemJson(res, [404, 409]);
  });

  test('Non-participant User C cannot access another swap card (403/404)', async () => {
    const { apiA, apiB, tokenA, tokenB, swapId } = await setupPendingPairSwap(172_100);
    const a1 = await apiA.acceptSwap(tokenA, swapId, 0);
    await apiB.acceptSwap(tokenB, swapId, Number(a1.data.version ?? 1));

    const apiC = new SaathApiClient();
    const authC = await apiC.loginWithOtp(uniquePhone(172_199));
    const cardC = await apiC.getSwapCard(authC.access, swapId, 'json');
    apiC.assertProblemJson(cardC, [403, 404]);
  });

  test('Revoked/chart-invalidated Swap Card reports valid=false and revoked=true', async ({
    page,
  }) => {
    const { apiA, apiB, tokenA, tokenB, journeyAId, swapId } = await setupPendingPairSwap(172_200);
    const a1 = await apiA.acceptSwap(tokenA, swapId, 0);
    await apiB.acceptSwap(tokenB, swapId, Number(a1.data.version ?? 1));

    const card = await apiA.getSwapCard(tokenA, swapId, 'json');
    const code = getString(card.data, 'public_code');

    await apiA.request('POST', `/v1/journeys/${journeyAId}/reverify`, {
      token: tokenA,
      headers: { 'X-Simulate-Chart-Change': 'true' },
    });

    const pub = await apiA.verifyPublicSwapCard(code);
    expect(pub.status).toBe(200);
    expect(pub.data.revoked).toBe(true);
    expect(pub.data.valid).toBe(false);

    await page.goto(`/v/${code}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(/Revoked|Invalidated|रद्द/i).first()).toBeVisible();
  });

  test('Public Swap Card endpoint rejects script/tampered codes and passes zero-PII audit', async ({
    createIsolatedPassenger,
  }) => {
    const { apiA, apiB, tokenA, tokenB, swapId } = await setupPendingPairSwap(172_300);
    const a1 = await apiA.acceptSwap(tokenA, swapId, 0);
    await apiB.acceptSwap(tokenB, swapId, Number(a1.data.version ?? 1));

    const card = await apiA.getSwapCard(tokenA, swapId, 'json');
    const code = getString(card.data, 'public_code');

    const tampered = await apiA.verifyPublicSwapCard('<script>alert(1)</script>');
    apiA.assertProblemJson(tampered, [400, 404, 422]);

    const pub = await apiA.verifyPublicSwapCard(code);
    assertNoPiiLeak(pub.data, 'tier2-public-swap-card', [TEST_PNRS.cycleA, TEST_PNRS.cycleB]);

    const passenger = await createIsolatedPassenger('card-offline');
    await injectAuthSession(passenger.page, { access: tokenA });
    await passenger.page.goto(`/swaps/${swapId}/card`, { waitUntil: 'domcontentloaded' });
    await passenger.context.setOffline(true);
    await expect(passenger.page.getByText(new RegExp(code))).toBeVisible();
    await passenger.context.setOffline(false);
  });
});
