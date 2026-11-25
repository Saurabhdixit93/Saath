import { test, expect, injectAuthSession } from '../../fixtures/multi-browser.js';
import { E2E_ENV, futureDateIso, uniquePhone, uniquePnr } from '../../helpers/env.js';

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Expected object for ${label}`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Expected array for ${label}`);
  }
  return value;
}

function getString(obj: Record<string, unknown>, key: string): string {
  const val = obj[key];
  if (typeof val !== 'string' || val.length === 0) {
    throw new Error(`Expected string "${key}"`);
  }
  return val;
}

function extractPartyInviteToken(inviteData: Record<string, unknown>): string {
  if (typeof inviteData.token === 'string' && inviteData.token.length > 0) {
    return inviteData.token;
  }
  const url = getString(inviteData, 'invite_url');
  const token = url.split('/').pop()?.split(/[?#]/)[0];
  if (!token) {
    throw new Error(`Could not extract party invite token from ${url}`);
  }
  return token;
}

test.describe('S02: Pricing, Group-Organiser Trip Pass & B2B Entitlements @tier4', () => {
  test('Free ₹0 P2P swaps stay free while ₹199/trip checkout+webhook unlocks >4-member organiser flow and B2B X-API-Key works', async ({
    createIsolatedPassenger,
  }) => {
    const organiser = await createIsolatedPassenger('organiser');
    const authOrg = await organiser.api.loginWithOtp(uniquePhone(402_001));

    // Verify Free Passenger ₹0 plan and no seat sales
    const plansRes = await organiser.api.getPricingPlans();
    expect(plansRes.status).toBe(200);
    const plans = asArray(plansRes.data.plans, 'plans').map((p) => asRecord(p, 'plan'));
    expect(plans.find((p) => p.code === 'free_passenger')?.price_paise).toBe(0);
    expect(plans.find((p) => p.code === 'group_organiser_pass')?.price_paise).toBe(19900);

    // Verify Pricing page UI
    await injectAuthSession(organiser.page, authOrg);
    await organiser.page.goto('/pricing', { waitUntil: 'domcontentloaded' });
    await expect(organiser.page.getByText(/₹0/).first()).toBeVisible();
    await expect(organiser.page.getByText(/₹199/).first()).toBeVisible();

    // Organiser verifies primary PNR and checks that unentitled organiser summary is gated (402/403)
    const travelDate = futureDateIso(21);
    const vOrg = await organiser.api.verifyTrainSms(
      authOrg.access,
      `IRCTC PNR:${uniquePnr('s02-org')},TRN:12951,DOJ:${travelDate},CLS:3A,B3 1 LB,NDLS-MMCT`,
    );
    expect(vOrg.ok).toBe(true);
    const jId = getString(asRecord(vOrg.data.journey, 'journey'), 'id');
    const hub = await organiser.api.getJourney(authOrg.access, jId);
    const partyId = getString(asRecord(hub.data.party, 'party'), 'id');

    const gatedBefore = await organiser.api.request(
      'GET',
      `/v1/parties/${partyId}/organiser-summary`,
      { token: authOrg.access },
    );
    organiser.api.assertProblemJson(gatedBefore, [402, 403]);

    // Checkout ₹199/trip Group-Organiser Trip Pass + settle via signed webhook
    const checkout = await organiser.api.checkoutPlan(authOrg.access, {
      plan_code: 'group_organiser_pass',
      journey_id: jId,
      party_id: partyId,
    });
    expect([200, 201]).toContain(checkout.status);
    expect(checkout.data.amount_paise).toBe(19900);

    const orderId = getString(checkout.data, 'order_id');
    const webhook = await organiser.api.sendSignedPaymentWebhook({
      event_id: `evt_s02_${Date.now()}`,
      event: 'payment.captured',
      order_id: orderId,
      provider_order_id: String(checkout.data.provider_order_id ?? orderId),
      amount_paise: 19900,
      currency: 'INR',
    });
    expect(webhook.status).toBe(200);

    // Entitlement persisted and visible on UI
    const entRes = await organiser.api.getMyEntitlements(authOrg.access);
    const active = asArray(entRes.data.entitlements, 'entitlements')
      .map((e) => asRecord(e, 'e'))
      .find((e) => e.plan_code === 'group_organiser_pass' && e.status === 'active');
    expect(active).toBeDefined();

    await organiser.page.reload({ waitUntil: 'domcontentloaded' });
    await expect(organiser.page.getByText(/Active|Trip Pass|Unlocked/i).first()).toBeVisible();

    // Multi-PNR party merge across 4 additional isolated passenger sessions (total 5 members -> >4 member group)
    const inviteRes = await organiser.api.createPartyInvite(authOrg.access, jId);
    const inviteToken = extractPartyInviteToken(inviteRes.data);

    const additionalMembers = [
      { seed: 402_002, pnrSeed: 's02-m2', seat: 'B3 2 MB' },
      { seed: 402_003, pnrSeed: 's02-m3', seat: 'B3 3 UB' },
      { seed: 402_004, pnrSeed: 's02-m4', seat: 'B3 4 LB' },
      { seed: 402_005, pnrSeed: 's02-m5', seat: 'B3 5 MB' },
    ] as const;

    let finalMemberCount = 0;
    for (const [idx, spec] of additionalMembers.entries()) {
      const extraMember = await createIsolatedPassenger(`group-member-${idx + 2}`);
      const authMember = await extraMember.api.loginWithOtp(uniquePhone(spec.seed));
      const joinRes = await extraMember.api.joinParty(authMember.access, inviteToken, {
        sms_text: `IRCTC PNR:${uniquePnr(spec.pnrSeed)},TRN:12951,DOJ:${travelDate},CLS:3A,${spec.seat},NDLS-MMCT`,
        mode: 'train',
      });
      expect([200, 201]).toContain(joinRes.status);
      finalMemberCount = asArray(joinRes.data.seat_holders, 'joinRes.seat_holders').length;
    }
    expect(finalMemberCount).toBeGreaterThanOrEqual(5);

    // Unlocked organiser summary/export now succeeds
    const unlockedAfter = await organiser.api.request(
      'GET',
      `/v1/parties/${partyId}/organiser-summary`,
      { token: authOrg.access },
    );
    expect(unlockedAfter.status).toBe(200);

    // B2B/API Partner flow via X-API-Key
    const b2bOk = await organiser.api.requestWithApiKey(
      'GET',
      '/v1/b2b/stats',
      E2E_ENV.b2bApiKey,
    );
    expect(b2bOk.status).toBe(200);
  });
});
