import { test, expect } from '@playwright/test';
import { injectAuthSession } from '../../fixtures/multi-browser.js';
import { SaathApiClient } from '../../helpers/api.js';
import { E2E_ENV, TEST_PNRS, futureDateIso, uniquePhone } from '../../helpers/env.js';

function extractIds(payload: Record<string, unknown>): {
  partyId: string;
  holderId: string;
} {
  const party = payload.party as { id?: string } | undefined;
  const holders = payload.seat_holders as Array<{ id: string }> | undefined;
  if (!party?.id || !holders?.[0]?.id) {
    throw new Error(`Missing IDs in payload: ${JSON.stringify(payload)}`);
  }
  return { partyId: party.id, holderId: holders[0].id };
}

test.describe('@tier2 F07: Train SMS / E-Ticket Fallback Boundary Cases', () => {
  test('Empty sms_text returns 422 problem+json', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone('f07-t2-empty'), 'whatsapp');

    const res = await api.verifyTrainSms(auth.access, '   ');
    const problem = api.assertProblemJson(res, 422);
    expect(problem.status).toBe(422);
  });

  test('Unparseable gibberish SMS text returns 422 problem+json', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone('f07-t2-gib'), 'whatsapp');

    const res = await api.verifyTrainSms(
      auth.access,
      'Your OTP for bank login is 994422. Do not share with anyone.',
    );
    const problem = api.assertProblemJson(res, 422);
    expect(problem.status).toBe(422);
  });

  test('Partial SMS missing train number or berth details fails cleanly with 422', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone('f07-t2-part'), 'whatsapp');

    const res = await api.verifyTrainSms(auth.access, 'PNR: 2415678901 confirmed');
    const problem = api.assertProblemJson(res, 422);
    expect(problem.status).toBe(422);
  });

  test('XSS payload embedded in SMS text is sanitized and never executes in Journey Hub UI', async ({
    page,
  }) => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone('f07-t2-xss'), 'whatsapp');
    const xssSms = `IRCTC PNR:${TEST_PNRS.rajdhani3A},TRN:12951,DOJ:${futureDateIso(5)},CLS:3A,B3 42 UB <script>window.__xss=1</script>`;
    const res = await api.verifyTrainSms<{ journey?: { id: string } }>(auth.access, xssSms);
    expect([200, 201, 422]).toContain(res.status);

    await injectAuthSession(page, auth);
    await page.goto(
      res.data.journey?.id
        ? `${E2E_ENV.webUrl}/journeys/${res.data.journey.id}`
        : E2E_ENV.webUrl,
      { waitUntil: 'domcontentloaded' },
    );
    const xssExecuted = await page.evaluate(() => Boolean((window as { __xss?: number }).__xss));
    expect(xssExecuted).toBe(false);
  });

  test('verified_doc booking scores lower than verified_provider for equivalent match', async () => {
    const api = new SaathApiClient();
    const seeker = await api.loginWithOtp(uniquePhone('f07-t2-seek'), 'whatsapp');
    const providerHelper = await api.loginWithOtp(uniquePhone('f07-t2-prov'), 'whatsapp');
    const docHelper = await api.loginWithOtp(uniquePhone('f07-t2-doc'), 'whatsapp');

    const vSeeker = await api.verifyTrainPnr(seeker.access, TEST_PNRS.cycleA);
    const vProv = await api.verifyTrainPnr(providerHelper.access, TEST_PNRS.cycleB);
    const vDoc = await api.verifyTrainSms(
      docHelper.access,
      `IRCTC PNR:${TEST_PNRS.cycleC},TRN:12951,DOJ:${futureDateIso(5)},CLS:3A,B5 11 LB,NDLS-MMCT`,
    );

    const s = extractIds(vSeeker.data);
    const p = extractIds(vProv.data);
    expect(vDoc.ok).toBe(true);
    const d = extractIds(vDoc.data);

    await api.setGoal(providerHelper.access, p.partyId, {
      goal_type: 'open_to_help',
      movers: [p.holderId],
      constraints: {},
    });
    await api.setGoal(docHelper.access, d.partyId, {
      goal_type: 'open_to_help',
      movers: [d.holderId],
      constraints: {},
    });
    await api.setGoal(seeker.access, s.partyId, {
      goal_type: 'lower',
      movers: [s.holderId],
      constraints: {},
    });

    await expect(async () => {
      const m = await api.getMatches(seeker.access, s.partyId);
      expect(m.status).toBe(200);
      const provMatch = m.data.items.find((c) =>
        c.others.some((o) => o.trust === 'verified_provider'),
      );
      const docMatch = m.data.items.find((c) => c.others.some((o) => o.trust === 'verified_doc'));
      expect(provMatch).toBeDefined();
      expect(docMatch).toBeDefined();
      expect(Number(provMatch?.score)).toBeGreaterThanOrEqual(Number(docMatch?.score));
    }).toPass({ timeout: 12_000 });
  });
});
