import { test, expect } from '@playwright/test';
import { SaathApiClient } from '../../helpers/api.js';
import { TEST_PNRS, uniquePhone } from '../../helpers/env.js';

function requireId(val: unknown, label: string): string {
  if (typeof val !== 'string' || val.length === 0) {
    throw new Error(`Expected non-empty ${label}`);
  }
  return val;
}

async function burstReverifyUntil429(api: SaathApiClient, token: string, journeyId: string) {
  const statuses: number[] = [];
  let last = await api.reverifyJourney(token, journeyId);
  statuses.push(last.status);
  for (let i = 0; i < 12; i += 1) {
    last = await api.reverifyJourney(token, journeyId);
    statuses.push(last.status);
    if (last.status === 429) {
      break;
    }
  }
  return { statuses, last };
}

test.describe('@tier2 F11: Journey Hub & CRUD Edge Cases', () => {
  test('GET /v1/journeys/{nonexistent_uuid} returns 404 problem+json', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone('f11-t2-404'), 'whatsapp');

    const res = await api.getJourney(auth.access, '00000000-0000-4000-8000-000000000999');
    const problem = api.assertProblemJson(res, 404);
    expect(problem.status).toBe(404);
  });

  test('Malformed journey ID returns 404 or 422 problem+json', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone('f11-t2-baduuid'), 'whatsapp');

    const res = await api.getJourney(auth.access, 'not-a-valid-uuid');
    const problem = api.assertProblemJson(res, [404, 422]);
    expect([404, 422]).toContain(problem.status);
  });

  test('Cross-user GET, reverify, and DELETE on another actor journey return 403 or 404', async () => {
    const api = new SaathApiClient();
    const userA = await api.loginWithOtp(uniquePhone('f11-t2-ua'), 'whatsapp');
    const userB = await api.loginWithOtp(uniquePhone('f11-t2-ub'), 'whatsapp');

    const vA = await api.verifyTrainPnr<{ journey?: { id: string } }>(
      userA.access,
      TEST_PNRS.rajdhani3A,
    );
    const journeyId = requireId(vA.data.journey?.id, 'journey.id');

    api.assertProblemJson(await api.getJourney(userB.access, journeyId), [403, 404]);
    api.assertProblemJson(await api.reverifyJourney(userB.access, journeyId), [403, 404]);
    const delB = await api.deleteJourney(userB.access, journeyId);
    const problem = api.assertProblemJson(delB, [403, 404]);
    expect([403, 404]).toContain(problem.status);
  });

  test('Reverify spam triggers 429 rate-limit problem+json', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone('f11-t2-revrl'), 'whatsapp');
    const v = await api.verifyTrainPnr<{ journey?: { id: string } }>(
      auth.access,
      TEST_PNRS.sleeperSL,
    );
    const journeyId = requireId(v.data.journey?.id, 'journey.id');

    const { statuses, last } = await burstReverifyUntil429(api, auth.access, journeyId);

    expect(statuses).toContain(429);
    api.assertProblemJson(last, 429);
  });

  test('Deleting a journey makes subsequent GET /v1/journeys/{id} return 404', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone('f11-t2-del404'), 'whatsapp');
    const v = await api.verifyTrainPnr<{ journey?: { id: string } }>(
      auth.access,
      TEST_PNRS.vandeBharatCC,
    );
    const journeyId = requireId(v.data.journey?.id, 'journey.id');

    const delRes = await api.deleteJourney(auth.access, journeyId);
    expect([200, 204]).toContain(delRes.status);

    const afterGet = await api.getJourney(auth.access, journeyId);
    const problem = api.assertProblemJson(afterGet, 404);
    expect(problem.status).toBe(404);
  });
});
