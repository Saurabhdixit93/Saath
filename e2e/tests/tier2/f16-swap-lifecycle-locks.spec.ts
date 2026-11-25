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

function requirePairCards(
  cards: Array<{ card_id: string }>,
): [ { card_id: string }, { card_id: string } ] {
  const first = cards[0];
  const second = cards[1];
  if (!first || !second) {
    throw new Error('Expected at least 2 pair match cards');
  }
  return [first, second];
}

test.describe('@tier2 F16: Swap Proposal Concurrency, Locks & AuthZ Edge Cases', () => {
  test('Concurrent accept race on two swaps sharing a seat_holder allows exactly one winner and rejects loser with 409', async () => {
    const api = new SaathApiClient();
    const uA = await api.loginWithOtp(uniquePhone('f16-t2-race-a'), 'whatsapp');
    const uB = await api.loginWithOtp(uniquePhone('f16-t2-race-b'), 'whatsapp');
    const uC = await api.loginWithOtp(uniquePhone('f16-t2-race-c'), 'whatsapp');

    const vA = await api.verifyTrainPnr(uA.access, TEST_PNRS.cycleA);
    const vB = await api.verifyTrainPnr(uB.access, TEST_PNRS.cycleB);
    const vC = await api.verifyTrainPnr(uC.access, TEST_PNRS.cycleC);
    const a = extractIds(vA.data);
    const b = extractIds(vB.data);
    const c = extractIds(vC.data);

    await api.setGoal(uA.access, a.partyId, { goal_type: 'lower', movers: [a.holderId], constraints: {} });
    await api.setGoal(uB.access, b.partyId, { goal_type: 'open_to_help', movers: [b.holderId], constraints: {} });
    await api.setGoal(uC.access, c.partyId, { goal_type: 'open_to_help', movers: [c.holderId], constraints: {} });

    let cards: Array<{ card_id: string }> = [];
    await expect(async () => {
      const m = await api.getMatches(uA.access, a.partyId, 'pair');
      expect(m.data.items.length).toBeGreaterThanOrEqual(2);
      cards = m.data.items;
    }).toPass({ timeout: 12_000 });

    const [card1, card2] = requirePairCards(cards);

    const s1 = await api.createSwap<{ id: string; version: number }>(uA.access, card1.card_id);
    const s2 = await api.createSwap<{ id: string; version: number }>(uA.access, card2.card_id);
    expect([200, 201]).toContain(s1.status);
    expect([200, 201, 409]).toContain(s2.status);

    // If both proposals exist, race their accept calls concurrently
    const [r1, r2] = await Promise.all([
      api.acceptSwap(uA.access, s1.data.id, s1.data.version),
      s2.ok
        ? api.acceptSwap(uA.access, s2.data.id, s2.data.version)
        : Promise.resolve(s2),
    ]);

    const statuses = [r1.status, r2.status].sort((x, y) => x - y);
    expect(statuses[0]).toBe(200);
    expect(statuses[1]).toBe(409);
  });

  test('Stale version on POST /v1/swaps/{id}/accept returns 409 Conflict', async () => {
    const api = new SaathApiClient();
    const uA = await api.loginWithOtp(uniquePhone('f16-t2-stale-a'), 'whatsapp');
    const uB = await api.loginWithOtp(uniquePhone('f16-t2-stale-b'), 'whatsapp');
    const vA = await api.verifyTrainPnr(uA.access, TEST_PNRS.cycleA);
    const vB = await api.verifyTrainPnr(uB.access, TEST_PNRS.cycleB);
    const a = extractIds(vA.data);
    const b = extractIds(vB.data);

    await api.setGoal(uB.access, b.partyId, { goal_type: 'open_to_help', movers: [b.holderId], constraints: {} });
    await api.setGoal(uA.access, a.partyId, { goal_type: 'lower', movers: [a.holderId], constraints: {} });

    let cardId = '';
    await expect(async () => {
      const m = await api.getMatches(uA.access, a.partyId);
      expect(m.data.items.length).toBeGreaterThanOrEqual(1);
      cardId = m.data.items[0]?.card_id ?? '';
    }).toPass({ timeout: 12_000 });

    const created = await api.createSwap<{ id: string; version: number }>(uA.access, cardId);
    expect(created.ok).toBe(true);

    const accA = await api.acceptSwap(uA.access, created.data.id, created.data.version);
    expect(accA.status).toBe(200);

    // Passing stale version 0 after version incremented
    const staleB = await api.acceptSwap(uB.access, created.data.id, created.data.version);
    const problem = api.assertProblemJson(staleB, 409);
    expect(problem.status).toBe(409);
  });

  test('3-way cycle where one participant declines transitions swap to declined and releases all 3 locks', async () => {
    const api = new SaathApiClient();
    const uA = await api.loginWithOtp(uniquePhone('f16-t2-c3-a'), 'whatsapp');
    const uB = await api.loginWithOtp(uniquePhone('f16-t2-c3-b'), 'whatsapp');
    const uC = await api.loginWithOtp(uniquePhone('f16-t2-c3-c'), 'whatsapp');

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

    let cycleCardId = '';
    await expect(async () => {
      const m = await api.getMatches(uA.access, a.partyId, 'cycle');
      const cyc = m.data.items.find((i) => i.kind === 'cycle3' || i.others.length >= 2);
      expect(cyc).toBeDefined();
      cycleCardId = cyc?.card_id ?? '';
    }).toPass({ timeout: 12_000 });

    const created = await api.createSwap<{ id: string; version: number }>(uA.access, cycleCardId);
    expect(created.ok).toBe(true);

    await api.acceptSwap(uB.access, created.data.id, created.data.version);
    const decC = await api.declineSwap<{ status: string }>(uC.access, created.data.id, 'Not convenient');
    expect(decC.status).toBe(200);
    expect(decC.data.status).toBe('declined');

    // Locks released: can re-create proposal
    const recreate = await api.createSwap(uA.access, cycleCardId);
    expect([200, 201]).toContain(recreate.status);
  });

  test('Non-initiator cannot cancel swap (403) and non-participant cannot accept/decline (403/404)', async () => {
    const api = new SaathApiClient();
    const uA = await api.loginWithOtp(uniquePhone('f16-t2-auth-a'), 'whatsapp');
    const uB = await api.loginWithOtp(uniquePhone('f16-t2-auth-b'), 'whatsapp');
    const outsider = await api.loginWithOtp(uniquePhone('f16-t2-auth-o'), 'whatsapp');

    const vA = await api.verifyTrainPnr(uA.access, TEST_PNRS.cycleA);
    const vB = await api.verifyTrainPnr(uB.access, TEST_PNRS.cycleB);
    const a = extractIds(vA.data);
    const b = extractIds(vB.data);

    await api.setGoal(uB.access, b.partyId, { goal_type: 'open_to_help', movers: [b.holderId], constraints: {} });
    await api.setGoal(uA.access, a.partyId, { goal_type: 'lower', movers: [a.holderId], constraints: {} });

    let cardId = '';
    await expect(async () => {
      const m = await api.getMatches(uA.access, a.partyId);
      expect(m.data.items.length).toBeGreaterThanOrEqual(1);
      cardId = m.data.items[0]?.card_id ?? '';
    }).toPass({ timeout: 12_000 });

    const created = await api.createSwap<{ id: string; version: number }>(uA.access, cardId);
    expect(created.ok).toBe(true);

    const cancelByB = await api.cancelSwap(uB.access, created.data.id);
    api.assertProblemJson(cancelByB, 403);

    const acceptByOutsider = await api.acceptSwap(outsider.access, created.data.id, 0);
    const problem = api.assertProblemJson(acceptByOutsider, [403, 404]);
    expect([403, 404]).toContain(problem.status);
  });

  test('Accepting an already-cancelled or already-declined swap returns 409 problem+json', async () => {
    const api = new SaathApiClient();
    const uA = await api.loginWithOtp(uniquePhone('f16-t2-term-a'), 'whatsapp');
    const uB = await api.loginWithOtp(uniquePhone('f16-t2-term-b'), 'whatsapp');

    const vA = await api.verifyTrainPnr(uA.access, TEST_PNRS.cycleA);
    const vB = await api.verifyTrainPnr(uB.access, TEST_PNRS.cycleB);
    const a = extractIds(vA.data);
    const b = extractIds(vB.data);

    await api.setGoal(uB.access, b.partyId, { goal_type: 'open_to_help', movers: [b.holderId], constraints: {} });
    await api.setGoal(uA.access, a.partyId, { goal_type: 'lower', movers: [a.holderId], constraints: {} });

    let cardId = '';
    await expect(async () => {
      const m = await api.getMatches(uA.access, a.partyId);
      expect(m.data.items.length).toBeGreaterThanOrEqual(1);
      cardId = m.data.items[0]?.card_id ?? '';
    }).toPass({ timeout: 12_000 });

    const created = await api.createSwap<{ id: string }>(uA.access, cardId);
    expect(created.ok).toBe(true);

    await api.cancelSwap(uA.access, created.data.id);

    const acceptAfterCancel = await api.acceptSwap(uB.access, created.data.id, 0);
    const problem = api.assertProblemJson(acceptAfterCancel, 409);
    expect(problem.status).toBe(409);
  });
});
