import { test, expect } from '../../fixtures/multi-browser.js';
import { SaathApiClient } from '../../helpers/api.js';
import { TEST_PNRS, uniquePhone } from '../../helpers/env.js';

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

test.describe('F25 Tier 2: Pricing Webhook HMAC, Idempotency & Entitlement Gates @tier2', () => {
  test('Invalid payment webhook HMAC signature is rejected with 400/401/403', async () => {
    const api = new SaathApiClient();
    const res = await api.sendSignedPaymentWebhook(
      {
        event_id: `evt_bad_sig_${Date.now()}`,
        event: 'payment.captured',
        order_id: 'ord_fake_123',
      },
      'wrong-secret',
      '0000000000000000000000000000000000000000000000000000000000000000',
    );
    api.assertProblemJson(res, [400, 401, 403]);
  });

  test('Duplicate payment webhook event_id is idempotent and does not duplicate entitlements', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone(252_001));
    const checkout = await api.checkoutPlan(auth.access, {
      plan_code: 'group_organiser_pass',
    });
    const orderId = getString(checkout.data, 'order_id');
    const eventId = `evt_dup_${Date.now()}`;
    const payload = {
      event_id: eventId,
      event: 'payment.captured',
      order_id: orderId,
      provider_order_id: String(checkout.data.provider_order_id ?? orderId),
      amount_paise: 19900,
      currency: 'INR',
    };

    const w1 = await api.sendSignedPaymentWebhook(payload);
    expect(w1.status).toBe(200);
    const w2 = await api.sendSignedPaymentWebhook(payload);
    expect(w2.status).toBe(200);

    const entRes = await api.getMyEntitlements(auth.access);
    const entitlements = asArray(entRes.data.entitlements, 'entitlements').map((e) =>
      asRecord(e, 'ent'),
    );
    const matching = entitlements.filter((e) => e.plan_code === 'group_organiser_pass');
    expect(matching.length).toBe(1);
  });

  test('Unentitled user attempting >4-member organiser export/planner gets 402/403 upgrade error', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone(252_002));
    const v = await api.verifyTrainPnr(auth.access, TEST_PNRS.rajdhani3A);
    const jId = getString(asRecord(v.data.journey, 'j'), 'id');
    const hub = await api.getJourney(auth.access, jId);
    const pId = getString(asRecord(hub.data.party, 'p'), 'id');

    const res = await api.request('GET', `/v1/parties/${pId}/organiser-summary`, {
      token: auth.access,
    });
    api.assertProblemJson(res, [402, 403]);
  });

  test('Non-seat-sale invariant rejects unknown/seat-sale checkout plan and blocks tampering', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone(252_003));
    const res = await api.checkoutPlan(auth.access, {
      plan_code: 'buy_lower_berth_priority',
    });
    api.assertProblemJson(res, [400, 403, 404, 422]);
  });

  test('Unauthenticated entitlements and invalid sandbox order completion return 401/404', async () => {
    const api = new SaathApiClient();
    const unauth = await api.request('GET', '/v1/me/entitlements');
    api.assertProblemJson(unauth, 401);

    const auth = await api.loginWithOtp(uniquePhone(252_004));
    const badOrder = await api.completeSandboxPayment(auth.access, '00000000-0000-0000-0000-000000000999');
    api.assertProblemJson(badOrder, [400, 404, 422]);
  });
});
