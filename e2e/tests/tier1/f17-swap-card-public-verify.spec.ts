import { test, expect, injectAuthSession } from '../../fixtures/multi-browser.js';
import { SaathApiClient, type MatchCardDto } from '../../helpers/api.js';
import { TEST_PNRS, uniquePhone } from '../../helpers/env.js';
import { assertLocale } from '../../helpers/a11y.js';
import { assertNoPiiLeak } from '../../helpers/pii.js';

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Expected object for ${label}, got ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Expected array for ${label}, got ${JSON.stringify(value)}`);
  }
  return value;
}

function getString(obj: Record<string, unknown>, key: string): string {
  const val = obj[key];
  if (typeof val !== 'string' || val.length === 0) {
    throw new Error(`Expected non-empty string "${key}" in ${JSON.stringify(obj)}`);
  }
  return val;
}

function getNumber(obj: Record<string, unknown>, key: string): number {
  const val = obj[key];
  if (typeof val !== 'number') {
    throw new Error(`Expected number "${key}" in ${JSON.stringify(obj)}`);
  }
  return val;
}

async function setupConfirmedPairSwap(seedBase: number): Promise<{
  apiA: SaathApiClient;
  apiB: SaathApiClient;
  tokenA: string;
  tokenB: string;
  swapId: string;
  publicCode: string;
}> {
  const apiA = new SaathApiClient();
  const apiB = new SaathApiClient();

  const authA = await apiA.loginWithOtp(uniquePhone(seedBase + 1));
  const authB = await apiB.loginWithOtp(uniquePhone(seedBase + 2));

  const verifyA = await apiA.verifyTrainPnr(authA.access, TEST_PNRS.cycleA);
  const verifyB = await apiB.verifyTrainPnr(authB.access, TEST_PNRS.cycleB);
  expect(verifyA.ok).toBe(true);
  expect(verifyB.ok).toBe(true);

  const journeyA = asRecord(verifyA.data.journey, 'journeyA');
  const journeyB = asRecord(verifyB.data.journey, 'journeyB');
  const hubA = await apiA.getJourney(authA.access, getString(journeyA, 'id'));
  const hubB = await apiB.getJourney(authB.access, getString(journeyB, 'id'));

  const partyA = asRecord(hubA.data.party, 'partyA');
  const partyB = asRecord(hubB.data.party, 'partyB');
  const holdersA = asArray(hubA.data.seat_holders, 'seat_holders A');
  const holdersB = asArray(hubB.data.seat_holders, 'seat_holders B');
  const firstHolderA = asRecord(holdersA[0], 'holderA[0]');
  const firstHolderB = asRecord(holdersB[0], 'holderB[0]');

  const goalA = await apiA.setGoal(authA.access, getString(partyA, 'id'), {
    goal_type: 'lower',
    movers: [getString(firstHolderA, 'id')],
    preferred_seats: [],
    constraints: {
      women_only: false,
      no_middle: false,
      same_coach_only: false,
      verified_only: false,
    },
  });
  const goalB = await apiB.setGoal(authB.access, getString(partyB, 'id'), {
    goal_type: 'open_to_help',
    movers: [getString(firstHolderB, 'id')],
    preferred_seats: [],
    constraints: {
      women_only: false,
      no_middle: false,
      same_coach_only: false,
      verified_only: false,
    },
    standing_offer: { give_to: 'anyone' },
  });
  expect(goalA.ok).toBe(true);
  expect(goalB.ok).toBe(true);

  let firstCard: MatchCardDto | undefined;
  await expect(async () => {
    const matchesRes = await apiA.getMatches(authA.access, getString(partyA, 'id'), 'pair');
    expect(matchesRes.status).toBe(200);
    expect(matchesRes.data.items.length).toBeGreaterThanOrEqual(1);
    firstCard = matchesRes.data.items[0];
  }).toPass({ timeout: 12_000, intervals: [500, 1000, 1500] });
  if (!firstCard) {
    throw new Error('Expected at least one pair match card for confirmed swap setup');
  }

  const swapRes = await apiA.createSwap(authA.access, firstCard.card_id);
  expect(swapRes.ok).toBe(true);
  const swapId = getString(swapRes.data, 'id');
  const version0 = getNumber(swapRes.data, 'version');

  const acceptA = await apiA.acceptSwap(authA.access, swapId, version0);
  expect(acceptA.ok).toBe(true);
  const version1 = getNumber(acceptA.data, 'version');

  const acceptB = await apiB.acceptSwap(authB.access, swapId, version1);
  expect(acceptB.ok).toBe(true);
  expect(acceptB.data.status).toBe('confirmed');

  const cardRes = await apiA.getSwapCard(authA.access, swapId, 'json');
  expect(cardRes.ok).toBe(true);
  const publicCode = getString(cardRes.data, 'public_code');

  return {
    apiA,
    apiB,
    tokenA: authA.access,
    tokenB: authB.access,
    swapId,
    publicCode,
  };
}

test.describe('F17: Signed Swap Card & Public Verify @tier1', () => {
  test('GET /v1/swaps/{id}/card returns signed Ed25519 Swap Card JSON', async () => {
    const { apiA, tokenA, swapId } = await setupConfirmedPairSwap(17_000);

    const cardRes = await apiA.getSwapCard(tokenA, swapId, 'json');
    expect(cardRes.status).toBe(200);
    expect(getString(cardRes.data, 'public_code')).toMatch(/^SW-[A-Z0-9]{4,}$/);
    expect(getString(cardRes.data, 'signature').length).toBeGreaterThan(16);
    expect(getString(cardRes.data, 'service').length).toBeGreaterThan(0);
    expect(getString(cardRes.data, 'date').length).toBeGreaterThan(0);
    expect(getString(cardRes.data, 'qr_url')).toContain('/v/');
    expect(asArray(cardRes.data.participants, 'participants').length).toBeGreaterThanOrEqual(2);
  });

  test('GET /v1/swaps/{id}/card supports SVG and PNG exports', async () => {
    const { apiA, tokenA, swapId } = await setupConfirmedPairSwap(17_100);

    const svgRes = await apiA.getSwapCard(tokenA, swapId, 'svg');
    expect(svgRes.status).toBe(200);
    expect(svgRes.rawText).toContain('<svg');

    const pngRes = await apiA.requestBinary('GET', `/v1/swaps/${swapId}/card`, {
      token: tokenA,
      query: { format: 'png' },
    });
    expect(pngRes.status).toBe(200);
    expect(pngRes.headers.get('content-type') ?? '').toContain('image/png');
    expect(pngRes.buffer.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(true);
  });

  test('UI /swaps/[id]/card renders Swap Card, QR code, seats, consent timestamps, and TTE note', async ({
    createIsolatedPassenger,
  }) => {
    const { tokenA, swapId, publicCode } = await setupConfirmedPairSwap(17_200);
    const passenger = await createIsolatedPassenger('swap-card-ui');

    await injectAuthSession(passenger.page, { access: tokenA });
    await passenger.page.goto(`/swaps/${swapId}/card`, { waitUntil: 'domcontentloaded' });

    await expect(passenger.page.getByText(/SAATH SWAP CARD/i)).toBeVisible();
    await expect(passenger.page.getByText(new RegExp(publicCode))).toBeVisible();
    await expect(passenger.page.getByText(/Subject to TTE approval/i)).toBeVisible();
    await expect(
      passenger.page.locator('svg, canvas, img[alt*="QR" i]').first(),
    ).toBeVisible();
  });

  test('UI Swap Card Hindi toggle switches copy to Devanagari while keeping Latin seat numerals', async ({
    createIsolatedPassenger,
  }) => {
    const { tokenA, swapId } = await setupConfirmedPairSwap(17_300);
    const passenger = await createIsolatedPassenger('swap-card-hi');

    await injectAuthSession(passenger.page, { access: tokenA });
    await passenger.page.goto(`/swaps/${swapId}/card`, { waitUntil: 'domcontentloaded' });

    const hindiToggle = passenger.page.getByRole('button', {
      name: /हिंदी|हिं|Hindi/i,
    });
    await expect(hindiToggle).toBeVisible();
    await hindiToggle.click();

    const cardText = await passenger.page.locator('main').innerText();
    await assertLocale(passenger.page, 'hi', {
      latinDigitTexts: [cardText.match(/[A-Z]\d+-\d+/)?.[0] ?? '12951'],
    });
  });

  test('GET /v1/public/swap-cards/{code} and /v/{code} verify valid Swap Card without PII', async ({
    page,
  }) => {
    const { apiA, publicCode } = await setupConfirmedPairSwap(17_400);

    const publicRes = await apiA.verifyPublicSwapCard(publicCode);
    expect(publicRes.status).toBe(200);
    expect(publicRes.data.valid).toBe(true);
    expect(publicRes.data.revoked).toBe(false);
    expect(getString(publicRes.data, 'seats').length).toBeGreaterThan(0);

    assertNoPiiLeak(publicRes.data, 'public-swap-card', [
      TEST_PNRS.cycleA,
      TEST_PNRS.cycleB,
    ]);

    await page.goto(`/v/${publicCode}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(/Valid/i)).toBeVisible();
    await expect(page.getByText(new RegExp(publicCode))).toBeVisible();
  });
});
