import { test, expect, injectAuthSession } from '../../fixtures/multi-browser.js';
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

function getNumber(obj: Record<string, unknown>, key: string): number {
  const val = obj[key];
  if (typeof val !== 'number') {
    throw new Error(`Expected number "${key}"`);
  }
  return val;
}

async function createConfirmedSwapPair(seedBase: number): Promise<{
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
    throw new Error('Expected match card');
  }
  const swapRes = await apiA.createSwap(authA.access, card.card_id);
  const swapId = getString(swapRes.data, 'id');
  const a1 = await apiA.acceptSwap(authA.access, swapId, getNumber(swapRes.data, 'version'));
  const a2 = await apiB.acceptSwap(authB.access, swapId, getNumber(a1.data, 'version'));
  expect(a2.data.status).toBe('confirmed');

  return { apiA, apiB, tokenA: authA.access, tokenB: authB.access, swapId };
}

test.describe('F18: Post-Journey Confirmation @tier1', () => {
  test('First participant confirms completion with yes without premature rejection', async () => {
    const { apiA, tokenA, swapId } = await createConfirmedSwapPair(18_000);

    const confirmA = await apiA.confirmCompletion(tokenA, swapId, 'yes');
    expect(confirmA.status).toBe(200);
    expect(['awaiting_confirmation', 'confirmed', 'completed']).toContain(
      String(confirmA.data.status),
    );
  });

  test('Mutual yes confirmation transitions swap status to completed', async () => {
    const { apiA, apiB, tokenA, tokenB, swapId } = await createConfirmedSwapPair(18_100);

    const confirmA = await apiA.confirmCompletion(tokenA, swapId, 'yes');
    expect(confirmA.ok).toBe(true);

    const confirmB = await apiB.confirmCompletion(tokenB, swapId, 'yes');
    expect(confirmB.status).toBe(200);
    expect(confirmB.data.status).toBe('completed');
  });

  test('Mutual completion updates reliability_accepted and reliability_completed on /v1/me', async () => {
    const { apiA, apiB, tokenA, tokenB, swapId } = await createConfirmedSwapPair(18_200);

    const beforeMe = await apiA.getMe(tokenA);
    const beforeCompleted = Number(beforeMe.data.reliability_completed ?? 0);

    await apiA.confirmCompletion(tokenA, swapId, 'yes');
    await apiB.confirmCompletion(tokenB, swapId, 'yes');

    const afterMe = await apiA.getMe(tokenA);
    expect(afterMe.status).toBe(200);
    expect(Number(afterMe.data.reliability_completed ?? 0)).toBeGreaterThanOrEqual(
      beforeCompleted + 1,
    );
    expect(Number(afterMe.data.reliability_accepted ?? 0)).toBeGreaterThanOrEqual(1);
  });

  test('did_not_board answer records non-completion without crediting completion karma', async () => {
    const { apiA, tokenA, swapId } = await createConfirmedSwapPair(18_300);

    const beforeKarma = await apiA.getKarma(tokenA);
    const beforeBalance = Number(beforeKarma.data.balance ?? 0);

    const res = await apiA.confirmCompletion(tokenA, swapId, 'did_not_board');
    expect(res.status).toBe(200);
    expect(['not_completed', 'disputed', 'did_not_board']).toContain(String(res.data.status));

    const afterKarma = await apiA.getKarma(tokenA);
    expect(Number(afterKarma.data.balance ?? 0)).toBeLessThanOrEqual(beforeBalance);
  });

  test('UI inbox renders post-journey confirm prompt and submits confirmation', async ({
    createIsolatedPassenger,
  }) => {
    const { tokenA } = await createConfirmedSwapPair(18_400);
    const passenger = await createIsolatedPassenger('confirm-ui');

    await injectAuthSession(passenger.page, { access: tokenA });
    await passenger.page.goto('/inbox', { waitUntil: 'domcontentloaded' });

    const yesButton = passenger.page
      .getByRole('button', { name: /Yes, swapped|Completed|Confirm|हाँ/i })
      .first();
    await expect(yesButton).toBeVisible();
    await yesButton.click();

    await expect(
      passenger.page.getByText(/Confirmed|Completed|Thanks|धन्यवाद/i).first(),
    ).toBeVisible();
  });
});
