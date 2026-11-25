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

test.describe('@tier2 F15: Match Cards & Coach Map Strict PII & Edge Contracts', () => {
  test('assertNoPiiLeak passes across pair, cycle, and plan matches with seeded PII watchwords', async () => {
    const api = new SaathApiClient();
    const secretAlias = 'SecretRamesh99';
    const phoneA = uniquePhone('f15-t2-pii-a');
    const phoneB = uniquePhone('f15-t2-pii-b');
    const uA = await api.loginWithOtp(phoneA, 'whatsapp');
    const uB = await api.loginWithOtp(phoneB, 'whatsapp');
    await api.patchMe(uB.access, { display_alias: secretAlias, gender_self: 'female' });

    const vA = await api.verifyTrainPnr(uA.access, TEST_PNRS.cycleA);
    const vB = await api.verifyTrainPnr(uB.access, TEST_PNRS.cycleB);
    const a = extractIds(vA.data);
    const b = extractIds(vB.data);

    await api.setGoal(uB.access, b.partyId, { goal_type: 'open_to_help', movers: [b.holderId], constraints: {} });
    await api.setGoal(uA.access, a.partyId, { goal_type: 'lower', movers: [a.holderId], constraints: {} });

    await expect(async () => {
      const m = await api.getMatches(uA.access, a.partyId);
      expect(m.status).toBe(200);
      expect(m.data.items.length).toBeGreaterThanOrEqual(1);
      assertNoPiiLeak(m.data, 'f15-t2-matches-pii', [secretAlias, phoneB, TEST_PNRS.cycleB]);
    }).toPass({ timeout: 12_000 });
  });

  test('assertNoPiiLeak passes on GET /v1/journeys/{id}/coach-map with allowLayoutSeatNo=true', async () => {
    const api = new SaathApiClient();
    const phoneB = uniquePhone('f15-t2-cm-b');
    const uA = await api.loginWithOtp(uniquePhone('f15-t2-cm-a'), 'whatsapp');
    const uB = await api.loginWithOtp(phoneB, 'whatsapp');

    const vA = await api.verifyTrainPnr(uA.access, TEST_PNRS.cycleA);
    await api.verifyTrainPnr(uB.access, TEST_PNRS.cycleB);
    const a = extractIds(vA.data);

    const mapRes = await api.getCoachMap(uA.access, a.journeyId, a.coach);
    expect(mapRes.status).toBe(200);
    assertNoPiiLeak(mapRes.data, 'f15-t2-coach-map', [phoneB, TEST_PNRS.cycleB], {
      allowLayoutSeatNo: true,
    });
  });

  test('Invalid coach query param (?coach=Z99) returns 404 or 422 problem+json', async () => {
    const api = new SaathApiClient();
    const uA = await api.loginWithOtp(uniquePhone('f15-t2-badcoach'), 'whatsapp');
    const vA = await api.verifyTrainPnr(uA.access, TEST_PNRS.rajdhani3A);
    const a = extractIds(vA.data);

    const res = await api.getCoachMap(uA.access, a.journeyId, 'Z99');
    const problem = api.assertProblemJson(res, [404, 422]);
    expect([404, 422]).toContain(problem.status);
  });

  test('Empty matches state renders cold-start invite CTA cleanly without errors', async ({
    page,
  }) => {
    const api = new SaathApiClient();
    const uA = await api.loginWithOtp(uniquePhone('f15-t2-empty'), 'whatsapp');
    const vA = await api.verifyTrainPnr(uA.access, TEST_PNRS.secondSitting2S);
    const a = extractIds(vA.data);

    await injectAuthSession(page, uA);
    await page.goto(`${E2E_ENV.webUrl}/journeys/${a.journeyId}/matches`, {
      waitUntil: 'domcontentloaded',
    });

    await expect(
      page.getByText(/no one.*joined yet|invite|notify me|open to help/i).first(),
    ).toBeVisible();
  });

  test('Cross-user access to GET /parties/{pid}/matches and /coach-map returns 403 or 404', async () => {
    const api = new SaathApiClient();
    const owner = await api.loginWithOtp(uniquePhone('f15-t2-own'), 'whatsapp');
    const stranger = await api.loginWithOtp(uniquePhone('f15-t2-str'), 'whatsapp');

    const v = await api.verifyTrainPnr(owner.access, TEST_PNRS.rajdhani3A);
    const a = extractIds(v.data);

    api.assertProblemJson(await api.getMatches(stranger.access, a.partyId), [403, 404]);
    const cm = await api.getCoachMap(stranger.access, a.journeyId, a.coach);
    const problem = api.assertProblemJson(cm, [403, 404]);
    expect([403, 404]).toContain(problem.status);
  });
});
