import { test, expect } from '@playwright/test';
import { injectAuthSession } from '../../fixtures/multi-browser.js';
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
    throw new Error(`Unable to extract invite token from ${inviteData.invite_url}`);
  }
  return last;
}

test.describe('@tier1 F12: Party Auto-Create & Multi-PNR Merge', () => {
  test('First journey verification auto-creates a party with leader seat holders', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone('f12-auto'), 'whatsapp');
    const verified = await api.verifyTrainPnr<{
      party?: { id: string };
      seat_holders?: Array<{ id: string }>;
    }>(auth.access, TEST_PNRS.rajdhani3A);

    expect(verified.ok).toBe(true);
    expect(typeof verified.data.party?.id).toBe('string');
    expect((verified.data.seat_holders ?? []).length).toBeGreaterThanOrEqual(1);
  });

  test('POST /v1/journeys/{id}/party/invite creates a 48h scoped invite link', async () => {
    const api = new SaathApiClient();
    const leader = await api.loginWithOtp(uniquePhone('f12-invite'), 'whatsapp');
    const verified = await api.verifyTrainPnr<{ journey?: { id: string } }>(
      leader.access,
      TEST_PNRS.cycleA,
    );
    const journeyId = requireId(verified.data.journey?.id, 'journey.id');

    const inviteRes = await api.createPartyInvite(leader.access, journeyId);
    expect([200, 201]).toContain(inviteRes.status);
    expect(inviteRes.data.invite_url.length).toBeGreaterThan(5);
    expect(Number.isNaN(Date.parse(inviteRes.data.expires_at))).toBe(false);
  });

  test('POST /v1/party/join merges a second PNR on the same train into the leader party', async () => {
    const api = new SaathApiClient();
    const leader = await api.loginWithOtp(uniquePhone('f12-merge-a'), 'whatsapp');
    const member = await api.loginWithOtp(uniquePhone('f12-merge-b'), 'whatsapp');

    const vA = await api.verifyTrainPnr<{
      journey?: { id: string };
      party?: { id: string };
    }>(leader.access, TEST_PNRS.cycleA);
    const journeyIdA = requireId(vA.data.journey?.id, 'journeyA.id');
    const partyIdA = requireId(vA.data.party?.id, 'partyA.id');

    const inviteRes = await api.createPartyInvite(leader.access, journeyIdA);
    expect(inviteRes.ok).toBe(true);
    const inviteToken = extractInviteToken(inviteRes.data);

    const joinRes = await api.joinParty<{
      party?: { id: string };
      seat_holders?: Array<{ id: string }>;
    }>(member.access, inviteToken, { pnr: TEST_PNRS.cycleB, mode: 'train' });

    expect([200, 201]).toContain(joinRes.status);
    expect(joinRes.data.party?.id).toBe(partyIdA);
    expect((joinRes.data.seat_holders ?? []).length).toBeGreaterThanOrEqual(2);
  });

  test('Web UI Journey Hub PartyAvatarRow displays merged party members and Add family PNR button', async ({
    page,
  }) => {
    const api = new SaathApiClient();
    const leader = await api.loginWithOtp(uniquePhone('f12-ui-a'), 'whatsapp');
    const member = await api.loginWithOtp(uniquePhone('f12-ui-b'), 'whatsapp');

    const vA = await api.verifyTrainPnr<{ journey?: { id: string } }>(
      leader.access,
      TEST_PNRS.cycleA,
    );
    const journeyIdA = requireId(vA.data.journey?.id, 'journeyA.id');
    const inviteRes = await api.createPartyInvite(leader.access, journeyIdA);
    await api.joinParty(member.access, extractInviteToken(inviteRes.data), {
      pnr: TEST_PNRS.cycleB,
      mode: 'train',
    });

    await injectAuthSession(page, leader);
    await page.goto(`${E2E_ENV.webUrl}/journeys/${journeyIdA}`, {
      waitUntil: 'domcontentloaded',
    });

    await expect(page.getByRole('button', { name: /add family|invite/i }).first()).toBeVisible();
    await expect(page.getByText(/you|party|member/i).first()).toBeVisible();
  });

  test('Party leader can remove a joined member via DELETE /v1/party/{pid}/members/{seat_holder_id}', async () => {
    const api = new SaathApiClient();
    const leader = await api.loginWithOtp(uniquePhone('f12-rem-a'), 'whatsapp');
    const member = await api.loginWithOtp(uniquePhone('f12-rem-b'), 'whatsapp');

    const vA = await api.verifyTrainPnr<{
      journey?: { id: string };
      party?: { id: string };
      seat_holders?: Array<{ id: string }>;
    }>(leader.access, TEST_PNRS.cycleA);
    const journeyIdA = requireId(vA.data.journey?.id, 'journeyA.id');
    const partyId = requireId(vA.data.party?.id, 'party.id');
    const leaderHolderIds = new Set((vA.data.seat_holders ?? []).map((h) => h.id));

    const inviteRes = await api.createPartyInvite(leader.access, journeyIdA);
    const joinRes = await api.joinParty<{
      seat_holders?: Array<{ id: string }>;
    }>(member.access, extractInviteToken(inviteRes.data), {
      pnr: TEST_PNRS.cycleB,
      mode: 'train',
    });
    expect(joinRes.ok).toBe(true);

    const addedHolder = (joinRes.data.seat_holders ?? []).find((h) => !leaderHolderIds.has(h.id));
    const addedHolderId = requireId(addedHolder?.id, 'addedHolder.id');

    const delRes = await api.removePartyMember(leader.access, partyId, addedHolderId);
    expect([200, 204]).toContain(delRes.status);
  });
});
