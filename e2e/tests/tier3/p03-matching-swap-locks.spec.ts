import { test, expect } from '../../fixtures/multi-browser.js';
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

test.describe('@tier3 P03: Matching -> Swap Proposal -> Seat Locks & Re-Match', () => {
  test('MatchCard creates proposal, concurrent accept triggers 409 lock collision, and decline unlocks re-match', async () => {
    const api = new SaathApiClient();
    const uA = await api.loginWithOtp(uniquePhone('p03-a'), 'whatsapp');
    const uB = await api.loginWithOtp(uniquePhone('p03-b'), 'whatsapp');
    const uC = await api.loginWithOtp(uniquePhone('p03-c'), 'whatsapp');

    const vA = await api.verifyTrainPnr(uA.access, TEST_PNRS.cycleA);
    const vB = await api.verifyTrainPnr(uB.access, TEST_PNRS.cycleB);
    const vC = await api.verifyTrainPnr(uC.access, TEST_PNRS.cycleC);
    const a = extractIds(vA.data);
    const b = extractIds(vB.data);
    const c = extractIds(vC.data);

    await api.setGoal(uA.access, a.partyId, { goal_type: 'lower', movers: [a.holderId], constraints: {} });
    await api.setGoal(uB.access, b.partyId, { goal_type: 'open_to_help', movers: [b.holderId], constraints: {} });
    await api.setGoal(uC.access, c.partyId, { goal_type: 'open_to_help', movers: [c.holderId], constraints: {} });

    let firstCard = '';
    let secondCard = '';
    await expect(async () => {
      const m = await api.getMatches(uA.access, a.partyId, 'pair');
      expect(m.data.items.length).toBeGreaterThanOrEqual(2);
      firstCard = m.data.items[0]?.card_id ?? '';
      secondCard = m.data.items[1]?.card_id ?? '';
    }).toPass({ timeout: 12_000 });

    const s1 = await api.createSwap<{ id: string; version: number }>(uA.access, firstCard);
    expect([200, 201]).toContain(s1.status);
    await api.acceptSwap(uA.access, s1.data.id, s1.data.version);

    const s2 = await api.createSwap(uA.access, secondCard);
    api.assertProblemJson(s2, 409);

    const dec = await api.declineSwap<{ status: string }>(uB.access, s1.data.id, 'Busy');
    expect(dec.data.status).toBe('declined');

    const s2AfterDecline = await api.createSwap<{ id: string; status: string }>(uA.access, secondCard);
    expect([200, 201]).toContain(s2AfterDecline.status);
    expect(s2AfterDecline.data.status).toBe('pending');
  });

  test('Cancelled proposal frees seat lock for alternative cycle match', async () => {
    const api = new SaathApiClient();
    const uA = await api.loginWithOtp(uniquePhone('p03-can-a'), 'whatsapp');
    const uB = await api.loginWithOtp(uniquePhone('p03-can-b'), 'whatsapp');

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

    const p1 = await api.createSwap<{ id: string }>(uA.access, cardId);
    expect(p1.ok).toBe(true);
    await api.cancelSwap(uA.access, p1.data.id);

    const p2 = await api.createSwap<{ id: string; status: string }>(uA.access, cardId);
    expect([200, 201]).toContain(p2.status);
    expect(p2.data.status).toBe('pending');
  });

  test('Confirmed swap locks seats permanently against competing proposals from third party', async () => {
    const api = new SaathApiClient();
    const uA = await api.loginWithOtp(uniquePhone('p03-lck-a'), 'whatsapp');
    const uB = await api.loginWithOtp(uniquePhone('p03-lck-b'), 'whatsapp');
    const uC = await api.loginWithOtp(uniquePhone('p03-lck-c'), 'whatsapp');

    const vA = await api.verifyTrainPnr(uA.access, TEST_PNRS.cycleA);
    const vB = await api.verifyTrainPnr(uB.access, TEST_PNRS.cycleB);
    const vC = await api.verifyTrainPnr(uC.access, TEST_PNRS.cycleC);
    const a = extractIds(vA.data);
    const b = extractIds(vB.data);
    const c = extractIds(vC.data);

    await api.setGoal(uB.access, b.partyId, { goal_type: 'open_to_help', movers: [b.holderId], constraints: {} });
    await api.setGoal(uA.access, a.partyId, { goal_type: 'lower', movers: [a.holderId], constraints: {} });
    await api.setGoal(uC.access, c.partyId, { goal_type: 'lower', movers: [c.holderId], constraints: {} });

    let cardAB = '';
    let cardCB = '';
    await expect(async () => {
      const mA = await api.getMatches(uA.access, a.partyId, 'pair');
      const mC = await api.getMatches(uC.access, c.partyId, 'pair');
      expect(mA.data.items.length).toBeGreaterThanOrEqual(1);
      expect(mC.data.items.length).toBeGreaterThanOrEqual(1);
      cardAB = mA.data.items[0]?.card_id ?? '';
      cardCB = mC.data.items[0]?.card_id ?? '';
    }).toPass({ timeout: 12_000 });

    const swapAB = await api.createSwap<{ id: string; version: number }>(uA.access, cardAB);
    expect(swapAB.ok).toBe(true);
    const accA = await api.acceptSwap<{ version: number }>(uA.access, swapAB.data.id, swapAB.data.version);
    await api.acceptSwap(uB.access, swapAB.data.id, accA.data.version);

    const swapCB = await api.createSwap(uC.access, cardCB);
    api.assertProblemJson(swapCB, 409);
    expect(swapCB.status).toBe(409);
  });
});
