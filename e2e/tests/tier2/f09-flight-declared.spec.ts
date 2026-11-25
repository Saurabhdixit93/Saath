import { test, expect } from '@playwright/test';
import { SaathApiClient } from '../../helpers/api.js';
import { buildBcbpString } from '../../helpers/bcbp.js';
import { futureDateIso, uniquePhone } from '../../helpers/env.js';

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

test.describe('@tier2 F09: Flight Declared Fallback Boundary & Cycle Rules', () => {
  test('Invalid flight number, past date, or bad seat format in declared payload returns 422', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone('f09-t2-fmt'), 'whatsapp');

    const badCases = [
      { flight_no: 'INVALID', date: futureDateIso(5), seat: '14A' },
      { flight_no: '6E 2134', date: '2020-01-01', seat: '14A' },
      { flight_no: '6E 2134', date: futureDateIso(5), seat: 'ZZ' },
    ];

    for (const declared of badCases) {
      const res = await api.verifyFlightDeclared(auth.access, declared);
      const problem = api.assertProblemJson(res, 422);
      expect(problem.status).toBe(422);
    }
  });

  test('Declared seat outside aircraft layout (99Z) rejected with 422 problem+json', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone('f09-t2-seat'), 'whatsapp');

    const res = await api.verifyFlightDeclared(auth.access, {
      flight_no: '6E 2134',
      date: futureDateIso(6),
      seat: '99Z',
    });
    const problem = api.assertProblemJson(res, 422);
    expect(problem.status).toBe(422);
  });

  test('Declared flight node is strictly excluded from 3-way cycles (2-cycles only)', async () => {
    const api = new SaathApiClient();
    const travelDate = futureDateIso(11);
    const uA = await api.loginWithOtp(uniquePhone('f09-t2-c3a'), 'whatsapp');
    const uB = await api.loginWithOtp(uniquePhone('f09-t2-c3b'), 'whatsapp');
    const uC = await api.loginWithOtp(uniquePhone('f09-t2-c3c'), 'whatsapp');

    const vA = await api.verifyFlightDeclared(uA.access, {
      flight_no: '6E 2134',
      date: travelDate,
      seat: '14B',
    });
    const vB = await api.verifyFlightBcbp(
      uB.access,
      buildBcbpString({
        pnr: 'F9C3B1',
        from: 'DEL',
        to: 'BOM',
        carrier: '6E',
        flightNo: '2134',
        julianDate: travelDate,
        seatNo: '14A',
      }),
    );
    const vC = await api.verifyFlightBcbp(
      uC.access,
      buildBcbpString({
        pnr: 'F9C3C1',
        from: 'DEL',
        to: 'BOM',
        carrier: '6E',
        flightNo: '2134',
        julianDate: travelDate,
        seatNo: '14C',
      }),
    );

    const a = extractIds(vA.data);
    const b = extractIds(vB.data);
    const c = extractIds(vC.data);

    await api.setGoal(uA.access, a.partyId, { goal_type: 'window', movers: [a.holderId], constraints: {} });
    await api.setGoal(uB.access, b.partyId, { goal_type: 'aisle', movers: [b.holderId], constraints: {} });
    await api.setGoal(uC.access, c.partyId, { goal_type: 'window', movers: [c.holderId], constraints: {} });

    await expect(async () => {
      const m = await api.getMatches(uA.access, a.partyId, 'cycle');
      expect(m.status).toBe(200);
      const hasCycle3or4 = m.data.items.some(
        (item) => item.kind === 'cycle3' || item.kind === 'cycle4',
      );
      expect(hasCycle3or4).toBe(false);
    }).toPass({ timeout: 10_000 });
  });

  test('Declared flight passenger scores lower than verified_bcbp passenger for same goal', async () => {
    const api = new SaathApiClient();
    const travelDate = futureDateIso(12);
    const seeker = await api.loginWithOtp(uniquePhone('f09-t2-sk'), 'whatsapp');
    const bcbpHelper = await api.loginWithOtp(uniquePhone('f09-t2-bcbp'), 'whatsapp');
    const declaredHelper = await api.loginWithOtp(uniquePhone('f09-t2-dec'), 'whatsapp');

    const vSeeker = await api.verifyFlightBcbp(
      seeker.access,
      buildBcbpString({
        pnr: 'SK1291',
        from: 'DEL',
        to: 'BOM',
        carrier: '6E',
        flightNo: '2134',
        julianDate: travelDate,
        seatNo: '15B',
      }),
    );
    const vBcbp = await api.verifyFlightBcbp(
      bcbpHelper.access,
      buildBcbpString({
        pnr: 'BC1292',
        from: 'DEL',
        to: 'BOM',
        carrier: '6E',
        flightNo: '2134',
        julianDate: travelDate,
        seatNo: '15A',
      }),
    );
    const vDec = await api.verifyFlightDeclared(declaredHelper.access, {
      flight_no: '6E 2134',
      date: travelDate,
      seat: '16A',
    });

    const s = extractIds(vSeeker.data);
    const b = extractIds(vBcbp.data);
    const d = extractIds(vDec.data);

    await api.setGoal(bcbpHelper.access, b.partyId, { goal_type: 'open_to_help', movers: [b.holderId], constraints: {} });
    await api.setGoal(declaredHelper.access, d.partyId, { goal_type: 'open_to_help', movers: [d.holderId], constraints: {} });
    await api.setGoal(seeker.access, s.partyId, { goal_type: 'window', movers: [s.holderId], constraints: {} });

    await expect(async () => {
      const m = await api.getMatches(seeker.access, s.partyId);
      expect(m.status).toBe(200);
      const bcbpCard = m.data.items.find((c) => c.others.some((o) => o.trust === 'verified_bcbp'));
      const decCard = m.data.items.find((c) => c.others.some((o) => o.trust === 'declared'));
      expect(bcbpCard).toBeDefined();
      expect(decCard).toBeDefined();
      expect(Number(bcbpCard?.score)).toBeGreaterThan(Number(decCard?.score));
    }).toPass({ timeout: 12_000 });
  });

  test('Duplicate declared flight seat claim by another user returns 409 Conflict', async () => {
    const api = new SaathApiClient();
    const travelDate = futureDateIso(13);
    const u1 = await api.loginWithOtp(uniquePhone('f09-t2-d1'), 'whatsapp');
    const u2 = await api.loginWithOtp(uniquePhone('f09-t2-d2'), 'whatsapp');

    const r1 = await api.verifyFlightDeclared(u1.access, {
      flight_no: '6E 2134',
      date: travelDate,
      seat: '21C',
    });
    expect([200, 201]).toContain(r1.status);

    const r2 = await api.verifyFlightDeclared(u2.access, {
      flight_no: '6E 2134',
      date: travelDate,
      seat: '21C',
    });
    const problem = api.assertProblemJson(r2, 409);
    expect(problem.status).toBe(409);
  });
});
