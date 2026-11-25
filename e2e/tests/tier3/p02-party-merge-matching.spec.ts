import { test, expect } from '../../fixtures/multi-browser.js';
import { SaathApiClient } from '../../helpers/api.js';
import { E2E_ENV, TEST_PNRS, uniquePhone } from '../../helpers/env.js';
import { SaathWsClient } from '../../helpers/ws-sse.js';

function extractIds(payload: Record<string, unknown>): {
  journeyId: string;
  partyId: string;
  holders: Array<{ id: string }>;
} {
  const journey = payload.journey as { id?: string } | undefined;
  const party = payload.party as { id?: string } | undefined;
  const holders = payload.seat_holders as Array<{ id: string }> | undefined;
  if (!journey?.id || !party?.id || !holders || holders.length === 0) {
    throw new Error(`Missing IDs in payload: ${JSON.stringify(payload)}`);
  }
  return { journeyId: journey.id, partyId: party.id, holders };
}

function extractInviteToken(inviteData: { invite_url: string; token?: string }): string {
  if (inviteData.token) {
    return inviteData.token;
  }
  const url = new URL(inviteData.invite_url, E2E_ENV.webUrl);
  const parts = url.pathname.split('/').filter(Boolean);
  const last = parts[parts.length - 1];
  if (!last) {
    throw new Error(`Missing invite token in ${inviteData.invite_url}`);
  }
  return last;
}

function requireFirstHolderId(holders: Array<{ id: string }>): string {
  const first = holders[0];
  if (!first) {
    throw new Error('Expected at least one seat holder');
  }
  return first.id;
}

test.describe('@tier3 P02: Party Merge -> Goal -> Live Matching & WS Recompute', () => {
  test('Joining a 2nd PNR via invite token expands party and recomputes joint bay plan', async () => {
    const api = new SaathApiClient();
    const leader = await api.loginWithOtp(uniquePhone('p02-ldr'), 'whatsapp');
    const spouse = await api.loginWithOtp(uniquePhone('p02-sp'), 'whatsapp');
    const helper = await api.loginWithOtp(uniquePhone('p02-hlp'), 'whatsapp');

    const vL = await api.verifyTrainPnr(leader.access, TEST_PNRS.cycleA);
    const l = extractIds(vL.data);
    const invite = await api.createPartyInvite(leader.access, l.journeyId);
    expect(invite.ok).toBe(true);

    const joinRes = await api.joinParty<{ seat_holders?: Array<{ id: string }> }>(
      spouse.access,
      extractInviteToken(invite.data),
      { pnr: TEST_PNRS.cycleB, mode: 'train' },
    );
    expect([200, 201]).toContain(joinRes.status);
    const allMovers = (joinRes.data.seat_holders ?? []).map((h) => h.id);
    expect(allMovers.length).toBeGreaterThanOrEqual(2);

    const vH = await api.verifyTrainPnr(helper.access, TEST_PNRS.cycleC);
    const h = extractIds(vH.data);
    const hHolderId = requireFirstHolderId(h.holders);
    await api.setGoal(helper.access, h.partyId, {
      goal_type: 'open_to_help',
      movers: [hHolderId],
      constraints: {},
    });

    await api.setGoal(leader.access, l.partyId, {
      goal_type: 'together',
      movers: allMovers,
      constraints: {},
    });

    await expect(async () => {
      const m = await api.getMatches(leader.access, l.partyId);
      expect(m.status).toBe(200);
      expect(m.data.items.length).toBeGreaterThanOrEqual(1);
    }).toPass({ timeout: 12_000 });
  });

  test('Goal change after party merge emits match.updated over WebSocket /v1/ws', async () => {
    const api = new SaathApiClient();
    const leader = await api.loginWithOtp(uniquePhone('p02-ws-l'), 'whatsapp');
    const helper = await api.loginWithOtp(uniquePhone('p02-ws-h'), 'whatsapp');

    const vL = await api.verifyTrainPnr(leader.access, TEST_PNRS.cycleA);
    const vH = await api.verifyTrainPnr(helper.access, TEST_PNRS.cycleB);
    const l = extractIds(vL.data);
    const h = extractIds(vH.data);

    const lHolderId = requireFirstHolderId(l.holders);
    const hHolderId = requireFirstHolderId(h.holders);

    const ws = new SaathWsClient();
    await ws.connectAndAuth(leader.access);

    try {
      await api.setGoal(helper.access, h.partyId, {
        goal_type: 'open_to_help',
        movers: [hHolderId],
        constraints: {},
      });
      await api.setGoal(leader.access, l.partyId, {
        goal_type: 'lower',
        movers: [lHolderId],
        constraints: {},
      });

      const evt = await ws.waitForEvent(
        'match.updated',
        (e) => e.party_id === l.partyId,
        15_000,
      );
      expect(evt.party_id).toBe(l.partyId);
      expect(typeof evt.match_version).toBe('number');
    } finally {
      await ws.close();
    }
  });

  test('women_only party goal excludes male/undisclosed helper from cycle matches', async () => {
    const api = new SaathApiClient();
    const woman = await api.loginWithOtp(uniquePhone('p02-wo-w'), 'whatsapp');
    const man = await api.loginWithOtp(uniquePhone('p02-wo-m'), 'whatsapp');

    await api.patchMe(woman.access, { gender_self: 'female' });
    await api.patchMe(man.access, { gender_self: 'male' });

    const vW = await api.verifyTrainPnr(woman.access, TEST_PNRS.cycleA);
    const vM = await api.verifyTrainPnr(man.access, TEST_PNRS.cycleB);
    const w = extractIds(vW.data);
    const m = extractIds(vM.data);

    const wHolderId = requireFirstHolderId(w.holders);
    const mHolderId = requireFirstHolderId(m.holders);

    await api.setGoal(man.access, m.partyId, {
      goal_type: 'open_to_help',
      movers: [mHolderId],
      constraints: {},
    });
    await api.setGoal(woman.access, w.partyId, {
      goal_type: 'lower',
      movers: [wHolderId],
      constraints: { women_only: true },
    });

    await expect(async () => {
      const matches = await api.getMatches(woman.access, w.partyId);
      expect(matches.status).toBe(200);
      expect(matches.data.items).toHaveLength(0);
    }).toPass({ timeout: 10_000 });
  });
});
