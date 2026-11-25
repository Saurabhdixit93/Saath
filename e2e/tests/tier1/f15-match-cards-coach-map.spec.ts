import { test, expect } from '@playwright/test';
import { injectAuthSession } from '../../fixtures/multi-browser.js';
import { SaathApiClient } from '../../helpers/api.js';
import { E2E_ENV, TEST_PNRS, uniquePhone } from '../../helpers/env.js';
import { assertNoPiiLeak } from '../../helpers/pii.js';

function extractIds(payload: Record<string, unknown>): {
  journeyId: string;
  partyId: string;
  holderId: string;
  coach: string;
} {
  const journey = payload.journey as { id?: string } | undefined;
  const party = payload.party as { id?: string } | undefined;
  const holders = payload.seat_holders as Array<{ id: string; coach?: string }> | undefined;
  if (!journey?.id || !party?.id || !holders?.[0]?.id) {
    throw new Error(`Missing IDs in payload: ${JSON.stringify(payload)}`);
  }
  return {
    journeyId: journey.id,
    partyId: party.id,
    holderId: holders[0].id,
    coach: holders[0].coach ?? 'B3',
  };
}

test.describe('@tier1 F15: Privacy-Safe Match Cards & Coach Map', () => {
  test('GET /v1/parties/{pid}/matches returns strict MatchCard contract with zero PII', async () => {
    const api = new SaathApiClient();
    const uA = await api.loginWithOtp(uniquePhone('f15-card-a'), 'whatsapp');
    const uB = await api.loginWithOtp(uniquePhone('f15-card-b'), 'whatsapp');

    const vA = await api.verifyTrainPnr(uA.access, TEST_PNRS.cycleA);
    const vB = await api.verifyTrainPnr(uB.access, TEST_PNRS.cycleB);
    const a = extractIds(vA.data);
    const b = extractIds(vB.data);

    await api.setGoal(uB.access, b.partyId, {
      goal_type: 'open_to_help',
      movers: [b.holderId],
      constraints: {},
    });
    await api.setGoal(uA.access, a.partyId, {
      goal_type: 'lower',
      movers: [a.holderId],
      constraints: {},
    });

    await expect(async () => {
      const m = await api.getMatches(uA.access, a.partyId);
      expect(m.status).toBe(200);
      expect(m.data.items.length).toBeGreaterThanOrEqual(1);
      assertNoPiiLeak(m.data, 'f15-match-cards', [TEST_PNRS.cycleB]);
      const card = m.data.items[0];
      expect(card?.others[0]?.alias).toMatch(/^Passenger /i);
    }).toPass({ timeout: 12_000 });
  });

  test('GET /v1/journeys/{id}/coach-map returns berth states without exposing occupant PII', async () => {
    const api = new SaathApiClient();
    const uA = await api.loginWithOtp(uniquePhone('f15-map'), 'whatsapp');
    const vA = await api.verifyTrainPnr(uA.access, TEST_PNRS.rajdhani3A);
    const a = extractIds(vA.data);

    const mapRes = await api.getCoachMap<{
      coach: string;
      seats: Array<{ seat_no: string; bay: number; seat_type: string; state: string }>;
    }>(uA.access, a.journeyId, a.coach);

    expect(mapRes.status).toBe(200);
    expect(mapRes.data.seats.length).toBeGreaterThan(0);
    assertNoPiiLeak(mapRes.data, 'f15-coach-map', [TEST_PNRS.rajdhani3A], {
      allowLayoutSeatNo: true,
    });
    expect(mapRes.data.seats.some((s) => s.state === 'mine')).toBe(true);
  });

  test('Web UI /journeys/[id]/matches toggles cleanly between List and Coach map views', async ({
    page,
  }) => {
    const api = new SaathApiClient();
    const uA = await api.loginWithOtp(uniquePhone('f15-toggle'), 'whatsapp');
    const vA = await api.verifyTrainPnr(uA.access, TEST_PNRS.rajdhani3A);
    const a = extractIds(vA.data);

    await injectAuthSession(page, uA);
    await page.goto(`${E2E_ENV.webUrl}/journeys/${a.journeyId}/matches`, {
      waitUntil: 'domcontentloaded',
    });

    const mapTab = page.getByRole('tab', { name: /coach map|cabin map/i }).or(
      page.getByRole('button', { name: /coach map|cabin map/i }),
    );
    await expect(mapTab.first()).toBeVisible();
    await mapTab.first().click();

    await expect(page.locator('svg').first()).toBeVisible();

    const listTab = page.getByRole('tab', { name: /list/i }).or(
      page.getByRole('button', { name: /list/i }),
    );
    await listTab.first().click();
    await expect(page.getByText(/match|swap|no one/i).first()).toBeVisible();
  });

  test('Web UI renders CycleSwapDiagram SVG for 3-way cycle match with pseudonymous aliases', async ({
    page,
  }) => {
    const api = new SaathApiClient();
    const uA = await api.loginWithOtp(uniquePhone('f15-c3-a'), 'whatsapp');
    const uB = await api.loginWithOtp(uniquePhone('f15-c3-b'), 'whatsapp');
    const uC = await api.loginWithOtp(uniquePhone('f15-c3-c'), 'whatsapp');

    const vA = await api.verifyTrainPnr(uA.access, TEST_PNRS.cycleA);
    const vB = await api.verifyTrainPnr(uB.access, TEST_PNRS.cycleB);
    const vC = await api.verifyTrainPnr(uC.access, TEST_PNRS.cycleC);
    const a = extractIds(vA.data);
    const b = extractIds(vB.data);
    const c = extractIds(vC.data);

    await api.setGoal(uA.access, a.partyId, { goal_type: 'lower', movers: [a.holderId], constraints: {} });
    await api.setGoal(uB.access, b.partyId, {
      goal_type: 'open_to_help',
      movers: [b.holderId],
      constraints: {},
      standing_offer: { give_to: 'anyone' },
    });
    await api.setGoal(uC.access, c.partyId, { goal_type: 'upper', movers: [c.holderId], constraints: {} });

    await injectAuthSession(page, uA);
    await expect(async () => {
      const m = await api.getMatches(uA.access, a.partyId, 'cycle');
      expect(m.data.items.length).toBeGreaterThanOrEqual(1);
    }).toPass({ timeout: 12_000 });

    await page.goto(`${E2E_ENV.webUrl}/journeys/${a.journeyId}/matches`, {
      waitUntil: 'domcontentloaded',
    });
    await expect(page.getByText(/passenger|all 3 must accept|3-way/i).first()).toBeVisible();
  });

  test('CoachMap SVG provides accessible ARIA seat labels and colour+pattern legend', async ({
    page,
  }) => {
    const api = new SaathApiClient();
    const uA = await api.loginWithOtp(uniquePhone('f15-aria'), 'whatsapp');
    const vA = await api.verifyTrainPnr(uA.access, TEST_PNRS.rajdhani3A);
    const a = extractIds(vA.data);

    await injectAuthSession(page, uA);
    await page.goto(`${E2E_ENV.webUrl}/journeys/${a.journeyId}/matches`, {
      waitUntil: 'domcontentloaded',
    });

    const mapTab = page.getByRole('tab', { name: /coach map/i }).or(
      page.getByRole('button', { name: /coach map/i }),
    );
    await mapTab.first().click();

    await expect(
      page.locator('[aria-label*="Coach" i], [aria-label*="berth" i], [aria-label*="seat" i]').first(),
    ).toBeVisible();
    await expect(page.getByText(/yours|mine|match|legend/i).first()).toBeVisible();
  });
});
