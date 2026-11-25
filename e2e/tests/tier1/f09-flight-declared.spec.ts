import { test, expect } from '@playwright/test';
import { injectAuthSession } from '../../fixtures/multi-browser.js';
import { SaathApiClient } from '../../helpers/api.js';
import { E2E_ENV, futureDateIso, uniquePhone } from '../../helpers/env.js';
import { assertNoPiiLeak } from '../../helpers/pii.js';

function requireString(val: unknown, label: string): string {
  if (typeof val !== 'string' || val.length === 0) {
    throw new Error(`Expected non-empty string for ${label}`);
  }
  return val;
}

test.describe('@tier1 F09: Flight Declared Fallback', () => {
  test('POST /v1/journeys/verify with declared flight details sets trust_tier=declared', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone('f09-declared-api'), 'whatsapp');

    const res = await api.verifyFlightDeclared(auth.access, {
      flight_no: '6E 2134',
      date: futureDateIso(5),
      seat: '16B',
    });

    expect([200, 201]).toContain(res.status);
    expect(res.data.trust_tier).toBe('declared');
    expect(res.data.journey).toBeTruthy();
  });

  test('Web UI Flight tab manual entry creates declared flight journey', async ({ page }) => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone('f09-ui-manual'), 'whatsapp');
    await injectAuthSession(page, auth);

    await page.goto(E2E_ENV.webUrl, { waitUntil: 'domcontentloaded' });
    await page.getByRole('tab', { name: /flight/i }).click();

    const manualBtn = page.getByRole('button', { name: /enter manually|manual/i }).or(
      page.getByText(/enter manually/i),
    );
    await manualBtn.first().click();

    await page.getByLabel(/flight/i).first().fill('6E 2134');
    await page.getByLabel(/date/i).first().fill(futureDateIso(6));
    await page.getByLabel(/seat/i).first().fill('18C');

    await page.getByRole('button', { name: /verify|continue|save|submit/i }).first().click();
    await expect(page).toHaveURL(/\/journeys\//);
  });

  test('Journey Hub UI clearly renders Declared trust badge for manual flight entry', async ({
    page,
  }) => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone('f09-badge'), 'whatsapp');
    const verified = await api.verifyFlightDeclared<{ journey?: { id: string } }>(auth.access, {
      flight_no: '6E 2134',
      date: futureDateIso(6),
      seat: '19A',
    });
    expect(verified.ok).toBe(true);
    const journeyId = requireString(verified.data.journey?.id, 'journey.id');

    await injectAuthSession(page, auth);
    await page.goto(`${E2E_ENV.webUrl}/journeys/${journeyId}`, {
      waitUntil: 'domcontentloaded',
    });

    await expect(page.getByText(/declared/i).first()).toBeVisible();
  });

  test('Pairwise 2-cycle match succeeds for a declared flight passenger', async () => {
    const api = new SaathApiClient();
    const travelDate = futureDateIso(8);
    const userA = await api.loginWithOtp(uniquePhone('f09-pair-a'), 'whatsapp');
    const userB = await api.loginWithOtp(uniquePhone('f09-pair-b'), 'whatsapp');

    const resA = await api.verifyFlightDeclared<{
      party?: { id: string };
      seat_holders?: Array<{ id: string }>;
    }>(userA.access, { flight_no: '6E 2134', date: travelDate, seat: '14B' });
    const resB = await api.verifyFlightDeclared<{
      party?: { id: string };
      seat_holders?: Array<{ id: string }>;
    }>(userB.access, { flight_no: '6E 2134', date: travelDate, seat: '14A' });

    expect(resA.ok).toBe(true);
    expect(resB.ok).toBe(true);

    const partyA = requireString(resA.data.party?.id, 'partyA.id');
    const partyB = requireString(resB.data.party?.id, 'partyB.id');
    const holderA = requireString(resA.data.seat_holders?.[0]?.id, 'holderA.id');
    const holderB = requireString(resB.data.seat_holders?.[0]?.id, 'holderB.id');

    await api.setGoal(userA.access, partyA, {
      goal_type: 'window',
      movers: [holderA],
      constraints: {},
    });
    await api.setGoal(userB.access, partyB, {
      goal_type: 'aisle',
      movers: [holderB],
      constraints: {},
    });

    await expect(async () => {
      const matchesRes = await api.getMatches(userA.access, partyA, 'pair');
      expect(matchesRes.status).toBe(200);
      expect(matchesRes.data.items.length).toBeGreaterThanOrEqual(1);
    }).toPass({ timeout: 12_000 });
  });

  test('Flight CabinMap highlights declared seat as mine with zero co-passenger PII', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone('f09-cabinmap'), 'whatsapp');
    const verified = await api.verifyFlightDeclared<{ journey?: { id: string } }>(auth.access, {
      flight_no: '6E 2134',
      date: futureDateIso(9),
      seat: '20A',
    });
    expect(verified.ok).toBe(true);
    const journeyId = requireString(verified.data.journey?.id, 'journey.id');

    const mapRes = await api.getCoachMap<{
      seats?: Array<{ seat_no: string; state: string }>;
    }>(auth.access, journeyId, 'MAIN');
    expect(mapRes.status).toBe(200);
    assertNoPiiLeak(mapRes.data, 'f09-cabin-map', [], { allowLayoutSeatNo: true });

    const mineSeat = mapRes.data.seats?.find((s) => s.state === 'mine');
    expect(mineSeat).toBeDefined();
    expect(mineSeat?.seat_no).toContain('20A');
  });
});
