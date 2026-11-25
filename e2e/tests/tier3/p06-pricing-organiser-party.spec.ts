import { test, expect } from '../../fixtures/multi-browser.js';
import { SaathApiClient } from '../../helpers/api.js';
import { TEST_PNRS, uniquePhone } from '../../helpers/env.js';

function extractIds(payload: Record<string, unknown>): {
  journeyId: string;
  partyId: string;
} {
  const journey = payload.journey as { id?: string } | undefined;
  const party = payload.party as { id?: string } | undefined;
  if (!journey?.id || !party?.id) {
    throw new Error(`Missing IDs in payload: ${JSON.stringify(payload)}`);
  }
  return { journeyId: journey.id, partyId: party.id };
}

test.describe('@tier3 P06: R3 Pricing -> Checkout & Webhook -> Group-Organiser Party Unlock', () => {
  test('Free Passenger P2P swaps remain ₹0 while Group-Organiser Trip Pass (₹199) unlocks via checkout + HMAC webhook', async () => {
    const api = new SaathApiClient();
    const plansRes = await api.getPricingPlans<{
      plans: Array<{ code: string; price_paise: number; billing_type: string }>;
    }>();
    expect(plansRes.status).toBe(200);

    const freePlan = plansRes.data.plans.find((p) => p.code === 'free_passenger');
    const orgPlan = plansRes.data.plans.find((p) => p.code === 'group_organiser_pass');
    expect(freePlan?.price_paise).toBe(0);
    expect(orgPlan?.price_paise).toBe(19900);

    const organiser = await api.loginWithOtp(uniquePhone('p06-org'), 'whatsapp');
    const v = await api.verifyTrainPnr(organiser.access, TEST_PNRS.cycleA);
    const { journeyId, partyId } = extractIds(v.data);

    const checkout = await api.checkoutPlan<{
      order_id: string;
      provider_order_id?: string;
      amount_paise: number;
    }>(organiser.access, {
      plan_code: 'group_organiser_pass',
      journey_id: journeyId,
      party_id: partyId,
      idempotency_key: `p06-${partyId}`,
    });
    expect([200, 201]).toContain(checkout.status);
    expect(checkout.data.amount_paise).toBe(19900);

    const webhookRes = await api.sendSignedPaymentWebhook({
      event: 'payment.captured',
      event_id: `evt_p06_${checkout.data.order_id}`,
      order_id: checkout.data.order_id,
      provider_order_id: checkout.data.provider_order_id ?? checkout.data.order_id,
      amount_paise: 19900,
    });
    expect([200, 201]).toContain(webhookRes.status);

    const ents = await api.getMyEntitlements<{
      entitlements: Array<{ plan_code: string; status: string }>;
    }>(organiser.access);
    expect(ents.status).toBe(200);
    expect(
      ents.data.entitlements.some(
        (e) => e.plan_code === 'group_organiser_pass' && e.status === 'active',
      ),
    ).toBe(true);
  });

  test('Sandbox checkout completion activates Group-Organiser entitlement idempotently', async () => {
    const api = new SaathApiClient();
    const organiser = await api.loginWithOtp(uniquePhone('p06-sbx'), 'whatsapp');
    const v = await api.verifyTrainPnr(organiser.access, TEST_PNRS.cycleB);
    const { journeyId, partyId } = extractIds(v.data);

    const checkout = await api.checkoutPlan<{ order_id: string }>(organiser.access, {
      plan_code: 'group_organiser_pass',
      journey_id: journeyId,
      party_id: partyId,
    });
    expect([200, 201]).toContain(checkout.status);

    const sbx = await api.completeSandboxPayment(organiser.access, checkout.data.order_id);
    expect([200, 201]).toContain(sbx.status);

    const ents = await api.getMyEntitlements<{
      entitlements: Array<{ plan_code: string; status: string }>;
    }>(organiser.access);
    expect(ents.data.entitlements.some((e) => e.plan_code === 'group_organiser_pass')).toBe(true);
  });

  test('Invalid HMAC payment webhook signature is rejected and never grants entitlement', async () => {
    const api = new SaathApiClient();
    const user = await api.loginWithOtp(uniquePhone('p06-badhmac'), 'whatsapp');
    const v = await api.verifyTrainPnr(user.access, TEST_PNRS.cycleC);
    const { journeyId, partyId } = extractIds(v.data);

    const checkout = await api.checkoutPlan<{ order_id: string }>(user.access, {
      plan_code: 'group_organiser_pass',
      journey_id: journeyId,
      party_id: partyId,
    });

    const badWebhook = await api.sendSignedPaymentWebhook(
      {
        event: 'payment.captured',
        event_id: `evt_bad_${checkout.data.order_id}`,
        order_id: checkout.data.order_id,
      },
      'wrong-secret-key',
      'invalid-hmac-signature',
    );
    api.assertProblemJson(badWebhook, [400, 401, 403]);

    const ents = await api.getMyEntitlements<{
      entitlements: Array<{ plan_code: string; status: string }>;
    }>(user.access);
    expect(
      ents.data.entitlements.some(
        (e) => e.plan_code === 'group_organiser_pass' && e.status === 'active',
      ),
    ).toBe(false);
  });
});
