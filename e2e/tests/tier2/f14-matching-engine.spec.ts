import { test, expect } from '@playwright/test';
import { SaathApiClient } from '../../helpers/api.js';
import { buildBcbpString } from '../../helpers/bcbp.js';
import { TEST_PNRS, futureDateIso, uniquePhone } from '../../helpers/env.js';

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

test.describe('@tier2 F14: Matching Engine Constraints & Exclusion Invariants', () => {
  test('no_middle=true constraint excludes middle berth (MB/M) partners from matches', async () => {
    const api = new SaathApiClient();
    const seeker = await api.loginWithOtp(uniquePhone('f14-t2-nomid-s'), 'whatsapp');
    const midHelper = await api.loginWithOtp(uniquePhone('f14-t2-nomid-h'), 'whatsapp');
    const travelDate = futureDateIso(14);

    const vSeeker = await api.verifyFlightBcbp(
      seeker.access,
      buildBcbpString({
        pnr: 'NM111A',
        from: 'DEL',
        to: 'BOM',
        carrier: '6E',
        flightNo: '2134',
        julianDate: travelDate,
        seatNo: '14A',
      }),
    );
    const vMid = await api.verifyFlightBcbp(
      midHelper.access,
      buildBcbpString({
        pnr: 'NM222B',
        from: 'DEL',
        to: 'BOM',
        carrier: '6E',
        flightNo: '2134',
        julianDate: travelDate,
        seatNo: '14B',
      }),
    );

    const s = extractIds(vSeeker.data);
    const h = extractIds(vMid.data);

    await api.setGoal(midHelper.access, h.partyId, {
      goal_type: 'window',
      movers: [h.holderId],
      constraints: {},
    });
    await api.setGoal(seeker.access, s.partyId, {
      goal_type: 'open_to_help',
      movers: [s.holderId],
      constraints: { no_middle: true },
    });

    await expect(async () => {
      const m = await api.getMatches(seeker.access, s.partyId);
      expect(m.status).toBe(200);
      const gotMiddle = m.data.items.some((card) =>
        ['MB', 'SM', 'M'].includes(String(card.you_get.seat_type)),
      );
      expect(gotMiddle).toBe(false);
    }).toPass({ timeout: 10_000 });
  });

  test('verified_only=true excludes declared flight passengers from match results', async () => {
    const api = new SaathApiClient();
    const travelDate = futureDateIso(15);
    const seeker = await api.loginWithOtp(uniquePhone('f14-t2-veronly-s'), 'whatsapp');
    const declaredHelper = await api.loginWithOtp(uniquePhone('f14-t2-veronly-d'), 'whatsapp');

    const vSeeker = await api.verifyFlightBcbp(
      seeker.access,
      buildBcbpString({
        pnr: 'VO111A',
        from: 'DEL',
        to: 'BOM',
        carrier: '6E',
        flightNo: '2134',
        julianDate: travelDate,
        seatNo: '18C',
      }),
    );
    const vDec = await api.verifyFlightDeclared(declaredHelper.access, {
      flight_no: '6E 2134',
      date: travelDate,
      seat: '18A',
    });

    const s = extractIds(vSeeker.data);
    const d = extractIds(vDec.data);

    await api.setGoal(declaredHelper.access, d.partyId, {
      goal_type: 'aisle',
      movers: [d.holderId],
      constraints: {},
    });
    await api.setGoal(seeker.access, s.partyId, {
      goal_type: 'window',
      movers: [s.holderId],
      constraints: { verified_only: true },
    });

    await expect(async () => {
      const m = await api.getMatches(seeker.access, s.partyId);
      expect(m.status).toBe(200);
      const hasDeclared = m.data.items.some((c) => c.others.some((o) => o.trust === 'declared'));
      expect(hasDeclared).toBe(false);
    }).toPass({ timeout: 10_000 });
  });

  test('same_coach_only=true excludes partners located in a different coach', async () => {
    const api = new SaathApiClient();
    const uA = await api.loginWithOtp(uniquePhone('f14-t2-sc-a'), 'whatsapp');
    const uB = await api.loginWithOtp(uniquePhone('f14-t2-sc-b'), 'whatsapp');
    const travelDate = futureDateIso(5);

    const vA = await api.verifyTrainSms(
      uA.access,
      `IRCTC PNR:${TEST_PNRS.cycleA},TRN:12951,DOJ:${travelDate},CLS:3A,B3 42 UB,NDLS-MMCT`,
    );
    const vB = await api.verifyTrainSms(
      uB.access,
      `IRCTC PNR:${TEST_PNRS.cycleB},TRN:12951,DOJ:${travelDate},CLS:3A,B9 11 LB,NDLS-MMCT`,
    );
    const a = extractIds(vA.data);
    const b = extractIds(vB.data);

    await api.setGoal(uB.access, b.partyId, {
      goal_type: 'open_to_help',
      movers: [b.holderId],
      constraints: {},
    });
    await api.setGoal(uA.access, a.partyId, {
      goal_type: 'lower',
      movers: [a.holderId],
      constraints: { same_coach_only: true },
    });

    await expect(async () => {
      const m = await api.getMatches(uA.access, a.partyId);
      expect(m.status).toBe(200);
      const crossCoach = m.data.items.some((c) => c.you_get.coach && c.you_get.coach !== 'B3');
      expect(crossCoach).toBe(false);
    }).toPass({ timeout: 10_000 });
  });

  test('Blocked user is excluded from future match candidates', async () => {
    const api = new SaathApiClient();
    const uA = await api.loginWithOtp(uniquePhone('f14-t2-blk-a'), 'whatsapp');
    const uB = await api.loginWithOtp(uniquePhone('f14-t2-blk-b'), 'whatsapp');

    const vA = await api.verifyTrainPnr(uA.access, TEST_PNRS.cycleA);
    const vB = await api.verifyTrainPnr(uB.access, TEST_PNRS.cycleB);
    const a = extractIds(vA.data);
    const b = extractIds(vB.data);

    await api.setGoal(uB.access, b.partyId, { goal_type: 'open_to_help', movers: [b.holderId], constraints: {} });
    await api.setGoal(uA.access, a.partyId, { goal_type: 'lower', movers: [a.holderId], constraints: {} });

    let partnerAlias = '';
    await expect(async () => {
      const m = await api.getMatches(uA.access, a.partyId);
      expect(m.data.items.length).toBeGreaterThanOrEqual(1);
      partnerAlias = m.data.items[0]?.others[0]?.alias ?? '';
      expect(partnerAlias.length).toBeGreaterThan(0);
    }).toPass({ timeout: 12_000 });

    const blockRes = await api.blockUser(uA.access, partnerAlias);
    expect([200, 201]).toContain(blockRes.status);

    await expect(async () => {
      const mAfter = await api.getMatches(uA.access, a.partyId);
      expect(mAfter.data.items.some((c) => c.others.some((o) => o.alias === partnerAlias))).toBe(
        false,
      );
    }).toPass({ timeout: 10_000 });
  });

  test('Non-overlapping route segments on same train produce zero matches', async () => {
    const api = new SaathApiClient();
    const uA = await api.loginWithOtp(uniquePhone('f14-t2-seg-a'), 'whatsapp');
    const uB = await api.loginWithOtp(uniquePhone('f14-t2-seg-b'), 'whatsapp');
    const travelDate = futureDateIso(16);

    const vA = await api.verifyTrainSms(
      uA.access,
      `IRCTC PNR:${TEST_PNRS.cycleA},TRN:12951,DOJ:${travelDate},CLS:3A,B3 42 UB,NDLS-KOTA`,
    );
    const vB = await api.verifyTrainSms(
      uB.access,
      `IRCTC PNR:${TEST_PNRS.cycleB},TRN:12951,DOJ:${travelDate},CLS:3A,B3 11 LB,BRC-MMCT`,
    );
    const a = extractIds(vA.data);
    const b = extractIds(vB.data);

    await api.setGoal(uB.access, b.partyId, { goal_type: 'open_to_help', movers: [b.holderId], constraints: {} });
    await api.setGoal(uA.access, a.partyId, { goal_type: 'lower', movers: [a.holderId], constraints: {} });

    await expect(async () => {
      const m = await api.getMatches(uA.access, a.partyId);
      expect(m.status).toBe(200);
      expect(m.data.items).toHaveLength(0);
    }).toPass({ timeout: 10_000 });
  });
});
