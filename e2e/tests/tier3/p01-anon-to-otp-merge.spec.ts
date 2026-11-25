import { test, expect, injectAuthSession } from '../../fixtures/multi-browser.js';
import { SaathApiClient } from '../../helpers/api.js';
import { E2E_ENV, TEST_PNRS, uniquePhone } from '../../helpers/env.js';

function extractIds(payload: Record<string, unknown>): {
  journeyId: string;
  partyId: string;
  holderId: string;
} {
  const journey = payload.journey as { id?: string } | undefined;
  const party = payload.party as { id?: string } | undefined;
  const holders = payload.seat_holders as Array<{ id: string }> | undefined;
  if (!journey?.id || !party?.id || !holders?.[0]?.id) {
    throw new Error(`Missing IDs in verify response: ${JSON.stringify(payload)}`);
  }
  return { journeyId: journey.id, partyId: party.id, holderId: holders[0].id };
}

test.describe('@tier3 P01: Anonymous Session -> Goal -> Phone OTP Merge', () => {
  test('Anonymous PNR verify and goal persist seamlessly after Phone OTP login', async () => {
    const api = new SaathApiClient();
    const anon = await api.issueAnonymousToken();
    expect(anon.ok).toBe(true);

    const verified = await api.verifyTrainPnr(anon.data.access, TEST_PNRS.cycleA);
    expect(verified.ok).toBe(true);
    const { journeyId, partyId, holderId } = extractIds(verified.data);

    const goalRes = await api.setGoal(anon.data.access, partyId, {
      goal_type: 'lower',
      movers: [holderId],
      constraints: { no_middle: true },
    });
    expect([200, 201]).toContain(goalRes.status);

    const auth = await api.loginWithOtp(uniquePhone('p01-merge'), 'whatsapp', anon.data.access);

    const hub = await api.getJourney<{ goal?: { goal_type: string } }>(auth.access, journeyId);
    expect(hub.status).toBe(200);
    expect(hub.data.goal?.goal_type).toBe('lower');
  });

  test('Merged user gains swap & chat capability immediately and can rotate refresh token', async () => {
    const api = new SaathApiClient();
    const anon = await api.issueAnonymousToken();
    expect(anon.ok).toBe(true);

    await api.verifyTrainPnr(anon.data.access, TEST_PNRS.cycleA);
    const auth = await api.loginWithOtp(uniquePhone('p01-caps'), 'sms', anon.data.access);

    const karma = await api.getKarma(auth.access);
    expect(karma.status).toBe(200);

    const rotated = await api.refreshTokens(auth.refresh);
    expect(rotated.status).toBe(200);
    const journeysAfterRotate = await api.getJourneys(rotated.data.access);
    expect(journeysAfterRotate.status).toBe(200);
    expect(journeysAfterRotate.data.items.length).toBeGreaterThanOrEqual(1);
  });

  test('Merged anonymous journey renders in Web UI Journey Hub under authenticated session', async ({
    page,
  }) => {
    const api = new SaathApiClient();
    const anon = await api.issueAnonymousToken();
    const verified = await api.verifyTrainPnr(anon.data.access, TEST_PNRS.rajdhani3A);
    const { journeyId, partyId, holderId } = extractIds(verified.data);

    await api.setGoal(anon.data.access, partyId, {
      goal_type: 'lower',
      movers: [holderId],
      constraints: {},
    });

    const auth = await api.loginWithOtp(uniquePhone('p01-ui'), 'whatsapp', anon.data.access);
    await injectAuthSession(page, auth);
    await page.goto(`${E2E_ENV.webUrl}/journeys/${journeyId}`, {
      waitUntil: 'domcontentloaded',
    });

    await expect(page.getByText(/lower|12951|3A/i).first()).toBeVisible();
  });
});
