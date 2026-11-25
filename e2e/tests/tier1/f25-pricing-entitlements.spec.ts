import { test, expect, injectAuthSession } from '../../fixtures/multi-browser.js';
import { SaathApiClient } from '../../helpers/api.js';
import { E2E_ENV, TEST_PNRS, uniquePhone } from '../../helpers/env.js';

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
    throw new Error(`Expected string "${key}" in ${JSON.stringify(obj)}`);
  }
  return val;
}

test.describe('F25: Pricing & Non-Seat-Sale Entitlements (R3) @tier1', () => {
  test('GET /v1/pricing/plans exposes Free ₹0, Group-Organiser ₹199/trip, and B2B Partner without seat sales', async () => {
    const api = new SaathApiClient();
    const res = await api.getPricingPlans();
    expect(res.status).toBe(200);

    const plans = asArray(res.data.plans, 'plans').map((p) => asRecord(p, 'plan'));
    const freePlan = plans.find((p) => p.code === 'free_passenger');
    const orgPlan = plans.find((p) => p.code === 'group_organiser_pass');
    const b2bPlan = plans.find((p) => p.code === 'b2b_partner');

    expect(freePlan).toBeDefined();
    expect(freePlan?.price_paise).toBe(0);
    expect(orgPlan).toBeDefined();
    expect(orgPlan?.price_paise).toBe(19900);
    expect(orgPlan?.currency).toBe('INR');
    expect(orgPlan?.billing_type).toBe('per_trip');
    expect(b2bPlan).toBeDefined();
    expect(JSON.stringify(plans).toLowerCase()).not.toContain('buy_seat');
  });

  test('UI /pricing renders all 3 plans and explicit ₹0 P2P swap guarantee', async ({ page }) => {
    await page.goto('/pricing', { waitUntil: 'domcontentloaded' });

    await expect(page.getByText(/Free Passenger|₹0/i).first()).toBeVisible();
    await expect(page.getByText(/Group-Organiser|₹199/i).first()).toBeVisible();
    await expect(page.getByText(/B2B|Partner/i).first()).toBeVisible();
    await expect(
      page.getByText(/always free|₹0|no seat sales/i).first(),
    ).toBeVisible();
  });

  test('Sandbox checkout + complete activates Group-Organiser Trip Pass entitlement', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone(25_001));
    const verify = await api.verifyTrainPnr(auth.access, TEST_PNRS.rajdhani3A);
    const journey = asRecord(verify.data.journey, 'journey');
    const journeyId = getString(journey, 'id');
    const hub = await api.getJourney(auth.access, journeyId);
    const partyId = getString(asRecord(hub.data.party, 'party'), 'id');

    const checkout = await api.checkoutPlan(auth.access, {
      plan_code: 'group_organiser_pass',
      journey_id: journeyId,
      party_id: partyId,
      idempotency_key: `e2e-25-${Date.now()}`,
    });
    expect([200, 201]).toContain(checkout.status);
    expect(checkout.data.amount_paise).toBe(19900);
    expect(checkout.data.currency).toBe('INR');

    const orderId = getString(checkout.data, 'order_id');
    const complete = await api.completeSandboxPayment(auth.access, orderId);
    expect(complete.status).toBe(200);

    const entRes = await api.getMyEntitlements(auth.access);
    expect(entRes.status).toBe(200);
    const entitlements = asArray(entRes.data.entitlements, 'entitlements').map((e) =>
      asRecord(e, 'entitlement'),
    );
    const activePass = entitlements.find(
      (e) => e.plan_code === 'group_organiser_pass' && e.status === 'active',
    );
    expect(activePass).toBeDefined();
  });

  test('Signed payment webhook transitions order to paid and persists scoped entitlement', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone(25_002));
    const verify = await api.verifyTrainPnr(auth.access, TEST_PNRS.sleeperSL);
    const journeyId = getString(asRecord(verify.data.journey, 'journey'), 'id');

    const checkout = await api.checkoutPlan(auth.access, {
      plan_code: 'group_organiser_pass',
      journey_id: journeyId,
    });
    expect([200, 201]).toContain(checkout.status);
    const orderId = getString(checkout.data, 'order_id');
    const providerOrderId = String(checkout.data.provider_order_id ?? orderId);

    const webhook = await api.sendSignedPaymentWebhook({
      event_id: `evt_e2e_25_${Date.now()}`,
      event: 'payment.captured',
      order_id: orderId,
      provider_order_id: providerOrderId,
      amount_paise: 19900,
      currency: 'INR',
    });
    expect(webhook.status).toBe(200);

    const entRes = await api.getMyEntitlements(auth.access);
    const entitlements = asArray(entRes.data.entitlements, 'entitlements').map((e) =>
      asRecord(e, 'entitlement'),
    );
    expect(
      entitlements.some((e) => e.plan_code === 'group_organiser_pass' && e.status === 'active'),
    ).toBe(true);
  });

  test('UI /pricing reflects active entitlement and B2B X-API-Key partner endpoint succeeds', async ({
    createIsolatedPassenger,
  }) => {
    const passenger = await createIsolatedPassenger('pricing-entitled');
    const auth = await passenger.api.loginWithOtp(uniquePhone(25_003));
    const checkout = await passenger.api.checkoutPlan(auth.access, {
      plan_code: 'group_organiser_pass',
    });
    await passenger.api.completeSandboxPayment(auth.access, getString(checkout.data, 'order_id'));

    await injectAuthSession(passenger.page, auth);
    await passenger.page.goto('/pricing', { waitUntil: 'domcontentloaded' });
    await expect(passenger.page.getByText(/Active|Trip Pass|Organiser/i).first()).toBeVisible();

    const b2bRes = await passenger.api.requestWithApiKey(
      'GET',
      '/v1/b2b/stats',
      E2E_ENV.b2bApiKey,
    );
    expect([200, 201]).toContain(b2bRes.status);
  });
});
