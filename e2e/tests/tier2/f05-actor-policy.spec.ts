import { test, expect } from '@playwright/test';
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

test.describe('@tier2 F05: Token-Derived Actor & AuthZ Isolation Matrix', () => {
  test('Actor impersonation fields (user_id/sender_id/passenger_id) in request body cannot override JWT actor', async () => {
    const api = new SaathApiClient();
    const userA = await api.loginWithOtp(uniquePhone('f05-t2-imp-a'), 'whatsapp');
    const userB = await api.loginWithOtp(uniquePhone('f05-t2-imp-b'), 'whatsapp');

    const spoofVerify = await api.verifyJourney(userB.access, {
      mode: 'train',
      pnr: TEST_PNRS.rajdhani3A,
      user_id: userA.user.id,
      passenger_id: userA.user.id,
    });
    expect([200, 201, 400, 422]).toContain(spoofVerify.status);

    const listA = await api.getJourneys(userA.access);
    expect(listA.status).toBe(200);
    expect(listA.data.items).toHaveLength(0);
  });

  test('Cross-user access to another actor journey (GET/reverify/DELETE) returns 403 or 404', async () => {
    const api = new SaathApiClient();
    const owner = await api.loginWithOtp(uniquePhone('f05-t2-own'), 'whatsapp');
    const intruder = await api.loginWithOtp(uniquePhone('f05-t2-int'), 'whatsapp');

    const verified = await api.verifyTrainPnr(owner.access, TEST_PNRS.rajdhani3A);
    const { journeyId } = extractIds(verified.data);

    const getRes = await api.getJourney(intruder.access, journeyId);
    api.assertProblemJson(getRes, [403, 404]);

    const revRes = await api.reverifyJourney(intruder.access, journeyId);
    api.assertProblemJson(revRes, [403, 404]);

    const delRes = await api.deleteJourney(intruder.access, journeyId);
    api.assertProblemJson(delRes, [403, 404]);
    expect([403, 404]).toContain(delRes.status);
  });

  test('Cross-party access to matches, goal mutation, or invite creation returns 403 or 404', async () => {
    const api = new SaathApiClient();
    const owner = await api.loginWithOtp(uniquePhone('f05-t2-pown'), 'whatsapp');
    const intruder = await api.loginWithOtp(uniquePhone('f05-t2-pint'), 'whatsapp');

    const verified = await api.verifyTrainPnr(owner.access, TEST_PNRS.rajdhani3A);
    const { journeyId, partyId, holderId } = extractIds(verified.data);

    const matchesRes = await api.getMatches(intruder.access, partyId);
    api.assertProblemJson(matchesRes, [403, 404]);

    const goalRes = await api.setGoal(intruder.access, partyId, {
      goal_type: 'lower',
      movers: [holderId],
      constraints: {},
    });
    api.assertProblemJson(goalRes, [403, 404]);

    const inviteRes = await api.createPartyInvite(intruder.access, journeyId);
    api.assertProblemJson(inviteRes, [403, 404]);
    expect([403, 404]).toContain(inviteRes.status);
  });

  test('Passenger JWT is rejected with 403 on all /v1/admin/* endpoints', async () => {
    const api = new SaathApiClient();
    const passenger = await api.loginWithOtp(uniquePhone('f05-t2-adm'), 'whatsapp');

    const funnel = await api.getAdminFunnel(passenger.access);
    api.assertProblemJson(funnel, 403);

    const audit = await api.getAdminAuditLog(passenger.access);
    api.assertProblemJson(audit, 403);
    expect(audit.status).toBe(403);
  });

  test('No /test-login or /admin/reset-demo backdoor routes exist in API or web', async () => {
    const api = new SaathApiClient();
    const testLogin = await api.request('POST', '/test-login', { body: {} });
    expect([404, 405, 410]).toContain(testLogin.status);

    const resetDemo = await api.request('POST', '/admin/reset-demo', { body: {} });
    expect([404, 405, 410]).toContain(resetDemo.status);

    const webTestLogin = await fetch(`${E2E_ENV.webUrl}/test-login`);
    expect([404, 410]).toContain(webTestLogin.status);
  });
});
