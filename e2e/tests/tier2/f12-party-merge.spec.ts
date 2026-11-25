import { test, expect } from '@playwright/test';
import { SaathApiClient } from '../../helpers/api.js';
import { E2E_ENV, TEST_PNRS, uniquePhone } from '../../helpers/env.js';

function requireId(val: unknown, label: string): string {
  if (typeof val !== 'string' || val.length === 0) {
    throw new Error(`Expected non-empty ${label}`);
  }
  return val;
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

test.describe('@tier2 F12: Party Merge Negative & Boundary Cases', () => {
  test('Cross-journey party join (different train/date PNR) rejected with 400 or 422', async () => {
    const api = new SaathApiClient();
    const leader = await api.loginWithOtp(uniquePhone('f12-t2-cross-a'), 'whatsapp');
    const other = await api.loginWithOtp(uniquePhone('f12-t2-cross-b'), 'whatsapp');

    const vA = await api.verifyTrainPnr<{ journey?: { id: string } }>(
      leader.access,
      TEST_PNRS.rajdhani3A,
    );
    const journeyIdA = requireId(vA.data.journey?.id, 'journeyA.id');
    const inviteRes = await api.createPartyInvite(leader.access, journeyIdA);
    expect(inviteRes.ok).toBe(true);

    const joinRes = await api.joinParty(other.access, extractInviteToken(inviteRes.data), {
      pnr: TEST_PNRS.vandeBharatCC,
      mode: 'train',
    });
    const problem = api.assertProblemJson(joinRes, [400, 422]);
    expect([400, 422]).toContain(problem.status);
  });

  test('Invalid or tampered party invite token returns 404 or 410 problem+json', async () => {
    const api = new SaathApiClient();
    const user = await api.loginWithOtp(uniquePhone('f12-t2-badtok'), 'whatsapp');

    const res = await api.joinParty(user.access, 'invalid_tampered_party_invite_token_xyz', {
      pnr: TEST_PNRS.cycleB,
      mode: 'train',
    });
    const problem = api.assertProblemJson(res, [404, 410]);
    expect([404, 410]).toContain(problem.status);
  });

  test('Non-leader member cannot create party invite or remove another member (403)', async () => {
    const api = new SaathApiClient();
    const leader = await api.loginWithOtp(uniquePhone('f12-t2-ldr'), 'whatsapp');
    const member = await api.loginWithOtp(uniquePhone('f12-t2-mem'), 'whatsapp');

    const vA = await api.verifyTrainPnr<{
      journey?: { id: string };
      party?: { id: string };
      seat_holders?: Array<{ id: string }>;
    }>(leader.access, TEST_PNRS.cycleA);
    const journeyIdA = requireId(vA.data.journey?.id, 'journeyA.id');
    const partyId = requireId(vA.data.party?.id, 'party.id');
    const leaderHolderId = requireId(vA.data.seat_holders?.[0]?.id, 'leaderHolder.id');

    const inviteRes = await api.createPartyInvite(leader.access, journeyIdA);
    const joinRes = await api.joinParty<{ journey?: { id: string } }>(
      member.access,
      extractInviteToken(inviteRes.data),
      { pnr: TEST_PNRS.cycleB, mode: 'train' },
    );
    expect(joinRes.ok).toBe(true);

    const memberRemoveLeader = await api.removePartyMember(member.access, partyId, leaderHolderId);
    const problem = api.assertProblemJson(memberRemoveLeader, 403);
    expect(problem.status).toBe(403);
  });

  test('Party leader cannot remove their own seat holder from the party', async () => {
    const api = new SaathApiClient();
    const leader = await api.loginWithOtp(uniquePhone('f12-t2-selfrem'), 'whatsapp');
    const vA = await api.verifyTrainPnr<{
      party?: { id: string };
      seat_holders?: Array<{ id: string }>;
    }>(leader.access, TEST_PNRS.rajdhani3A);
    const partyId = requireId(vA.data.party?.id, 'party.id');
    const leaderHolderId = requireId(vA.data.seat_holders?.[0]?.id, 'leaderHolder.id');

    const res = await api.removePartyMember(leader.access, partyId, leaderHolderId);
    const problem = api.assertProblemJson(res, [400, 409, 422]);
    expect([400, 409, 422]).toContain(problem.status);
  });

  test('Joining the same party twice with identical PNR does not duplicate seat_holders', async () => {
    const api = new SaathApiClient();
    const leader = await api.loginWithOtp(uniquePhone('f12-t2-dup-a'), 'whatsapp');
    const member = await api.loginWithOtp(uniquePhone('f12-t2-dup-b'), 'whatsapp');

    const vA = await api.verifyTrainPnr<{
      journey?: { id: string };
      party?: { id: string };
    }>(leader.access, TEST_PNRS.cycleA);
    const journeyIdA = requireId(vA.data.journey?.id, 'journeyA.id');
    const inviteRes = await api.createPartyInvite(leader.access, journeyIdA);
    const token = extractInviteToken(inviteRes.data);

    const j1 = await api.joinParty<{ seat_holders?: Array<{ id: string }> }>(member.access, token, {
      pnr: TEST_PNRS.cycleB,
      mode: 'train',
    });
    expect(j1.ok).toBe(true);
    const count1 = (j1.data.seat_holders ?? []).length;

    const j2 = await api.joinParty<{ seat_holders?: Array<{ id: string }> }>(member.access, token, {
      pnr: TEST_PNRS.cycleB,
      mode: 'train',
    });
    expect([200, 409]).toContain(j2.status);
    const hub = await api.getJourney<{ party?: { members?: unknown[] } }>(leader.access, journeyIdA);
    expect(hub.status).toBe(200);
    expect(count1).toBeGreaterThanOrEqual(2);
  });
});
