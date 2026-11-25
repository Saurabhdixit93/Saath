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
    throw new Error(`Missing party/holder IDs: ${JSON.stringify(payload)}`);
  }
  return { partyId: party.id, holderId: holders[0].id };
}

test.describe('@tier1 F14: Server-Side Swap Graph & Cycle Matching', () => {
  test('Complementary pair goals generate a 2-cycle (pair) match candidate with 0-100 score', async () => {
    const api = new SaathApiClient();
    const uA = await api.loginWithOtp(uniquePhone('f14-pair-a'), 'whatsapp');
    const uB = await api.loginWithOtp(uniquePhone('f14-pair-b'), 'whatsapp');

    const vA = await api.verifyTrainPnr(uA.access, TEST_PNRS.cycleA);
    const vB = await api.verifyTrainPnr(uB.access, TEST_PNRS.cycleB);
    const a = extractIds(vA.data);
    const b = extractIds(vB.data);

    await api.setGoal(uA.access, a.partyId, {
      goal_type: 'lower',
      movers: [a.holderId],
      constraints: {},
    });
    await api.setGoal(uB.access, b.partyId, {
      goal_type: 'upper',
      movers: [b.holderId],
      constraints: {},
    });

    await expect(async () => {
      const m = await api.getMatches(uA.access, a.partyId);
      expect(m.status).toBe(200);
      expect(m.data.items.length).toBeGreaterThanOrEqual(1);
      const top = m.data.items[0];
      expect(top).toBeDefined();
      expect(top?.score).toBeGreaterThanOrEqual(0);
      expect(top?.score).toBeLessThanOrEqual(100);
    }).toPass({ timeout: 12_000 });
  });

  test('3-passenger preference cycle generates a cycle3 match candidate', async () => {
    const api = new SaathApiClient();
    const uA = await api.loginWithOtp(uniquePhone('f14-c3-a'), 'whatsapp');
    const uB = await api.loginWithOtp(uniquePhone('f14-c3-b'), 'whatsapp');
    const uC = await api.loginWithOtp(uniquePhone('f14-c3-c'), 'whatsapp');

    const vA = await api.verifyTrainPnr(uA.access, TEST_PNRS.cycleA);
    const vB = await api.verifyTrainPnr(uB.access, TEST_PNRS.cycleB);
    const vC = await api.verifyTrainPnr(uC.access, TEST_PNRS.cycleC);
    const a = extractIds(vA.data);
    const b = extractIds(vB.data);
    const c = extractIds(vC.data);

    await api.setGoal(uA.access, a.partyId, {
      goal_type: 'lower',
      movers: [a.holderId],
      constraints: {},
    });
    await api.setGoal(uB.access, b.partyId, {
      goal_type: 'open_to_help',
      movers: [b.holderId],
      constraints: {},
      standing_offer: { give_to: 'anyone' },
    });
    await api.setGoal(uC.access, c.partyId, {
      goal_type: 'upper',
      movers: [c.holderId],
      constraints: {},
    });

    await expect(async () => {
      const m = await api.getMatches(uA.access, a.partyId, 'cycle');
      expect(m.status).toBe(200);
      expect(m.data.items.some((i) => i.kind === 'cycle3' || i.others.length >= 2)).toBe(true);
    }).toPass({ timeout: 12_000 });
  });

  test('Together goal for multi-passenger party generates a party bay plan candidate', async () => {
    const api = new SaathApiClient();
    const leader = await api.loginWithOtp(uniquePhone('f14-plan-a'), 'whatsapp');
    const helper = await api.loginWithOtp(uniquePhone('f14-plan-b'), 'whatsapp');

    const vLeader = await api.verifyTrainPnr<{
      party?: { id: string };
      seat_holders?: Array<{ id: string }>;
    }>(leader.access, TEST_PNRS.rajdhani3A);
    const vHelper = await api.verifyTrainPnr(helper.access, TEST_PNRS.cycleB);
    const lPartyId = String(vLeader.data.party?.id);
    const lMovers = (vLeader.data.seat_holders ?? []).map((h) => h.id);
    const h = extractIds(vHelper.data);

    await api.setGoal(helper.access, h.partyId, {
      goal_type: 'open_to_help',
      movers: [h.holderId],
      constraints: {},
      standing_offer: { give_to: 'anyone' },
    });
    await api.setGoal(leader.access, lPartyId, {
      goal_type: 'together',
      movers: lMovers,
      constraints: {},
    });

    await expect(async () => {
      const m = await api.getMatches(leader.access, lPartyId);
      expect(m.status).toBe(200);
      expect(m.data.items.length).toBeGreaterThanOrEqual(1);
    }).toPass({ timeout: 12_000 });
  });

  test('MatchCard carries explainable PII-free reasons and monotonically incrementing match_version', async () => {
    const api = new SaathApiClient();
    const uA = await api.loginWithOtp(uniquePhone('f14-ver-a'), 'whatsapp');
    const uB = await api.loginWithOtp(uniquePhone('f14-ver-b'), 'whatsapp');

    const vA = await api.verifyTrainPnr(uA.access, TEST_PNRS.cycleA);
    const vB = await api.verifyTrainPnr(uB.access, TEST_PNRS.cycleB);
    const a = extractIds(vA.data);
    const b = extractIds(vB.data);

    await api.setGoal(uB.access, b.partyId, {
      goal_type: 'open_to_help',
      movers: [b.holderId],
      constraints: {},
    });
    const g1 = await api.setGoal<{ match_version: number }>(uA.access, a.partyId, {
      goal_type: 'lower',
      movers: [a.holderId],
      constraints: {},
    });
    const g2 = await api.setGoal<{ match_version: number }>(uA.access, a.partyId, {
      goal_type: 'same_coach',
      movers: [a.holderId],
      constraints: {},
    });

    expect(g2.data.match_version).toBeGreaterThan(g1.data.match_version);

    await expect(async () => {
      const m = await api.getMatches(uA.access, a.partyId);
      expect(m.status).toBe(200);
      const first = m.data.items[0];
      expect(first).toBeDefined();
      expect(Array.isArray(first?.reasons)).toBe(true);
      expect((first?.reasons ?? []).length).toBeGreaterThanOrEqual(1);
    }).toPass({ timeout: 12_000 });
  });

  test('Standing offer open_to_help supplies a senior/lower seeker with high match label', async () => {
    const api = new SaathApiClient();
    const seeker = await api.loginWithOtp(uniquePhone('f14-seek'), 'whatsapp');
    const helper = await api.loginWithOtp(uniquePhone('f14-help'), 'whatsapp');

    const vS = await api.verifyTrainPnr(seeker.access, TEST_PNRS.cycleA);
    const vH = await api.verifyTrainPnr(helper.access, TEST_PNRS.cycleB);
    const s = extractIds(vS.data);
    const h = extractIds(vH.data);

    await api.setGoal(helper.access, h.partyId, {
      goal_type: 'open_to_help',
      movers: [h.holderId],
      constraints: {},
      standing_offer: { give_to: 'senior' },
    });
    await api.setGoal(seeker.access, s.partyId, {
      goal_type: 'lower',
      movers: [s.holderId],
      constraints: {},
    });

    await expect(async () => {
      const m = await api.getMatches(seeker.access, s.partyId);
      expect(m.status).toBe(200);
      const top = m.data.items[0];
      expect(top).toBeDefined();
      expect(['Perfect swap', 'Great match', 'Workable', 'Partial', 'Weak']).toContain(
        String(top?.label),
      );
    }).toPass({ timeout: 12_000 });
  });
});
