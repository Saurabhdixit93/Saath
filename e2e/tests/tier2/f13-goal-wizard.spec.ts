import { test, expect } from '@playwright/test';
import { SaathApiClient } from '../../helpers/api.js';
import { TEST_PNRS, uniquePhone } from '../../helpers/env.js';

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

test.describe('@tier2 F13: Goal Wizard & Constraints Guardrails', () => {
  test('women_only=true rejected with 403 or 422 when actor is male or undisclosed', async () => {
    const api = new SaathApiClient();
    const maleUser = await api.loginWithOtp(uniquePhone('f13-t2-male'), 'whatsapp');
    await api.patchMe(maleUser.access, { gender_self: 'male' });

    const verified = await api.verifyTrainPnr(maleUser.access, TEST_PNRS.cycleA);
    const { partyId, holderId } = extractIds(verified.data);

    const res = await api.setGoal(maleUser.access, partyId, {
      goal_type: 'lower',
      movers: [holderId],
      constraints: { women_only: true },
    });
    const problem = api.assertProblemJson(res, [403, 422]);
    expect([403, 422]).toContain(problem.status);
  });

  test('specific_seats exceeding maximum 4 seats rejected with 422 problem+json', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone('f13-t2-seats5'), 'whatsapp');
    const verified = await api.verifyTrainPnr(auth.access, TEST_PNRS.rajdhani3A);
    const { partyId, holderId } = extractIds(verified.data);

    const res = await api.setGoal(auth.access, partyId, {
      goal_type: 'specific_seats',
      movers: [holderId],
      preferred_seats: ['B3-1', 'B3-2', 'B3-3', 'B3-4', 'B3-5'],
      constraints: {},
    });
    const problem = api.assertProblemJson(res, 422);
    expect(problem.status).toBe(422);
  });

  test('Empty movers array or invalid goal_type enum rejected with 422', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone('f13-t2-enum'), 'whatsapp');
    const verified = await api.verifyTrainPnr(auth.access, TEST_PNRS.rajdhani3A);
    const { partyId, holderId } = extractIds(verified.data);

    const emptyMovers = await api.setGoal(auth.access, partyId, {
      goal_type: 'lower',
      movers: [],
      constraints: {},
    });
    api.assertProblemJson(emptyMovers, 422);

    const badEnum = await api.setGoal(auth.access, partyId, {
      goal_type: 'first_class_free_upgrade',
      movers: [holderId],
      constraints: {},
    });
    const problem = api.assertProblemJson(badEnum, 422);
    expect(problem.status).toBe(422);
  });

  test('Non-party member attempting PUT or DELETE /v1/parties/{pid}/goal gets 403 or 404', async () => {
    const api = new SaathApiClient();
    const owner = await api.loginWithOtp(uniquePhone('f13-t2-own'), 'whatsapp');
    const intruder = await api.loginWithOtp(uniquePhone('f13-t2-int'), 'whatsapp');
    const verified = await api.verifyTrainPnr(owner.access, TEST_PNRS.rajdhani3A);
    const { partyId, holderId } = extractIds(verified.data);

    const putRes = await api.setGoal(intruder.access, partyId, {
      goal_type: 'lower',
      movers: [holderId],
      constraints: {},
    });
    api.assertProblemJson(putRes, [403, 404]);

    const delRes = await api.deleteGoal(intruder.access, partyId);
    const problem = api.assertProblemJson(delRes, [403, 404]);
    expect([403, 404]).toContain(problem.status);
  });

  test('Female actor with gender_self=female is allowed to enable women_only=true constraint', async () => {
    const api = new SaathApiClient();
    const woman = await api.loginWithOtp(uniquePhone('f13-t2-woman'), 'whatsapp');
    await api.patchMe(woman.access, { gender_self: 'female' });

    const verified = await api.verifyTrainPnr(woman.access, TEST_PNRS.cycleA);
    const { partyId, holderId } = extractIds(verified.data);

    const res = await api.setGoal<{ goal?: { constraints?: { women_only?: boolean } } }>(
      woman.access,
      partyId,
      {
        goal_type: 'lower',
        movers: [holderId],
        constraints: { women_only: true },
      },
    );
    expect([200, 201]).toContain(res.status);
    expect(res.data.goal?.constraints?.women_only).toBe(true);
  });
});
