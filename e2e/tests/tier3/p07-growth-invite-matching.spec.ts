import { test, expect } from '../../fixtures/multi-browser.js';
import { SaathApiClient } from '../../helpers/api.js';
import { E2E_ENV, TEST_PNRS, uniquePhone } from '../../helpers/env.js';
import { assertNoPiiLeak } from '../../helpers/pii.js';

function extractIds(payload: Record<string, unknown>): {
  journeyId: string;
  partyId: string;
  holderId: string;
} {
  const journey = payload.journey as { id?: string } | undefined;
  const party = payload.party as { id?: string } | undefined;
  const holders = payload.seat_holders as Array<{ id: string }> | undefined;
  if (!journey?.id || !party?.id || !holders?.[0]?.id) {
    throw new Error(`Missing IDs in payload: ${JSON.stringify(payload)}`);
  }
  return { journeyId: journey.id, partyId: party.id, holderId: holders[0].id };
}

test.describe('@tier3 P07: Growth Invite-the-Seat -> Visitor Verify -> Live Match', () => {
  test('Invite-the-seat link converts cold-start coach visitor into open_to_help match for inviter', async ({
    page,
  }) => {
    const api = new SaathApiClient();
    const inviter = await api.loginWithOtp(uniquePhone('p07-inv'), 'whatsapp');
    const visitor = await api.loginWithOtp(uniquePhone('p07-vis'), 'whatsapp');

    const vInv = await api.verifyTrainPnr(inviter.access, TEST_PNRS.cycleA);
    const inv = extractIds(vInv.data);

    await api.setGoal(inviter.access, inv.partyId, {
      goal_type: 'lower',
      movers: [inv.holderId],
      constraints: {},
    });

    const inviteRes = await api.createSeatInvite<{
      token: string;
      invite_url: string;
      message_en: string;
      message_hi: string;
    }>(inviter.access, inv.journeyId, { coach: 'B5', seat_no: '11' });
    expect([200, 201]).toContain(inviteRes.status);
    expect(inviteRes.data.message_en.length).toBeGreaterThan(10);
    expect(inviteRes.data.message_hi.length).toBeGreaterThan(10);

    const pubInvite = await api.getPublicInvite(inviteRes.data.token);
    expect(pubInvite.status).toBe(200);
    assertNoPiiLeak(pubInvite.data, 'p07-public-invite', [TEST_PNRS.cycleA]);

    await page.goto(`${E2E_ENV.webUrl}/j/${inviteRes.data.token}`, {
      waitUntil: 'domcontentloaded',
    });
    await expect(page.getByText(/B5|help|pnr|verify/i).first()).toBeVisible();

    const vVis = await api.verifyTrainPnr(visitor.access, TEST_PNRS.cycleB);
    const vis = extractIds(vVis.data);
    await api.setGoal(visitor.access, vis.partyId, {
      goal_type: 'open_to_help',
      movers: [vis.holderId],
      constraints: {},
      standing_offer: { give_to: 'anyone' },
    });

    await expect(async () => {
      const m = await api.getMatches(inviter.access, inv.partyId);
      expect(m.data.items.length).toBeGreaterThanOrEqual(1);
    }).toPass({ timeout: 12_000 });
  });

  test('Public PNR status utility endpoint returns aggregates without leaking co-passenger PII', async () => {
    const api = new SaathApiClient();
    const res = await api.getPublicPnrStatus(TEST_PNRS.rajdhani3A);
    expect(res.status).toBe(200);
    assertNoPiiLeak(res.data, 'p07-public-pnr-status', [TEST_PNRS.rajdhani3A]);
  });

  test('Expired or unknown /j/[token] returns 404/410 and renders graceful fallback CTA on UI', async ({
    page,
  }) => {
    const api = new SaathApiClient();
    const res = await api.getPublicInvite('nonexistent_seat_invite_token_999');
    api.assertProblemJson(res, [404, 410]);

    await page.goto(`${E2E_ENV.webUrl}/j/nonexistent_seat_invite_token_999`, {
      waitUntil: 'domcontentloaded',
    });
    await expect(
      page.getByText(/expired|invalid invite|no longer valid|link expired/i).first(),
    ).toBeVisible();
  });
});
