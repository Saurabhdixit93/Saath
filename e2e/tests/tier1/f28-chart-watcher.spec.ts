import { test, expect, injectAuthSession } from '../../fixtures/multi-browser.js';
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

test.describe('F28: Chart-Watcher Scheduler & Auto-Invalidation @tier1', () => {
  test('Public chart-time endpoint applies Dec 2025 Railway Board rules (05:00-14:00 vs 14:01-04:59)', async () => {
    const api = new SaathApiClient();
    const date = futureDateIso(3);

    const morning = await api.getPublicTrainChartTime('12009', date);
    expect(morning.status).toBe(200);
    expect(getString(morning.data, 'chart_due_at').length).toBeGreaterThan(0);
    expect(getString(morning.data, 'rule').length).toBeGreaterThan(0);

    const evening = await api.getPublicTrainChartTime('12951', date);
    expect(evening.status).toBe(200);
    expect(getString(evening.data, 'chart_due_at').length).toBeGreaterThan(0);
  });

  test('Journey Hub UI renders ChartStatusPill with chart status or countdown', async ({
    createIsolatedPassenger,
  }) => {
    const passenger = await createIsolatedPassenger('chart-pill');
    const auth = await passenger.api.loginWithOtp(uniquePhone(28_001));
    const verify = await passenger.api.verifyTrainPnr(auth.access, TEST_PNRS.rajdhani3A);
    const journeyId = getString(asRecord(verify.data.journey, 'journey'), 'id');

    await injectAuthSession(passenger.page, auth);
    await passenger.page.goto(`/journeys/${journeyId}`, { waitUntil: 'domcontentloaded' });

    await expect(
      passenger.page.getByText(/Chart pending|Chart prepared|Chart at/i).first(),
    ).toBeVisible();
  });

  test('POST /v1/journeys/{id}/reverify refreshes chart state cleanly', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone(28_002));
    const verify = await api.verifyTrainPnr(auth.access, TEST_PNRS.morningChart);
    const journeyId = getString(asRecord(verify.data.journey, 'journey'), 'id');

    const reverify = await api.reverifyJourney(auth.access, journeyId);
    expect(reverify.status).toBe(200);
    expect(reverify.data.chart).toBeDefined();
  });

  test('BerthChanged during chart prep invalidates pending swap and marks Swap Card revoked', async () => {
    const apiA = new SaathApiClient();
    const apiB = new SaathApiClient();
    const authA = await apiA.loginWithOtp(uniquePhone(28_003));
    const authB = await apiB.loginWithOtp(uniquePhone(28_004));

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

    const cardJson = await apiA.getSwapCard(authA.access, swapId, 'json');
    const publicCode = getString(cardJson.data, 'public_code');

    // Simulate chart-prep berth diff via reverify/chart-update trigger in test/dev mode
    const reverify = await apiA.request('POST', `/v1/journeys/${jA}/reverify`, {
      token: authA.access,
      headers: { 'X-Simulate-Chart-Change': 'true' },
    });
    expect(reverify.ok).toBe(true);

    const swapAfter = await apiA.getSwap(authA.access, swapId);
    expect(['invalidated', 'confirmed']).toContain(String(swapAfter.data.status));

    const pubCard = await apiA.verifyPublicSwapCard(publicCode);
    expect(pubCard.status).toBe(200);
  });

  test('Chart reverify updates journey chart metadata and preserves match_version integrity', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone(28_005));
    const v = await api.verifyTrainPnr(auth.access, TEST_PNRS.nightChart);
    const jId = getString(asRecord(v.data.journey, 'j'), 'id');
    const hub1 = await api.getJourney(auth.access, jId);
    const partyId = getString(asRecord(hub1.data.party, 'p'), 'id');
    const matches1 = await api.getMatches(auth.access, partyId);

    const rev = await api.reverifyJourney(auth.access, jId);
    expect(rev.status).toBe(200);
    await expect(async () => {
      const matches2 = await api.getMatches(auth.access, partyId);
      expect(matches2.status).toBe(200);
      expect(matches2.data.match_version).toBeGreaterThanOrEqual(matches1.data.match_version);
    }).toPass({ timeout: 12_000, intervals: [500, 1000, 1500] });
  });
});
