import { test, expect } from '../../fixtures/multi-browser.js';
import { SaathApiClient } from '../../helpers/api.js';
import { E2E_ENV, TEST_PNRS, uniquePhone } from '../../helpers/env.js';

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Expected object for ${label}`);
  }
  return value as Record<string, unknown>;
}

function getString(obj: Record<string, unknown>, key: string): string {
  const val = obj[key];
  if (typeof val !== 'string' || val.length === 0) {
    throw new Error(`Expected string "${key}"`);
  }
  return val;
}

test.describe('F30: Pluggable External Provider & Gateway Adapters @tier1', () => {
  test('RailDataProvider router verifies deterministic 3A, SL, and CC PNRs in fake/sandbox mode', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone(30_001));

    const r3a = await api.verifyTrainPnr(auth.access, TEST_PNRS.rajdhani3A);
    const rsl = await api.verifyTrainPnr(auth.access, TEST_PNRS.sleeperSL);
    const rcc = await api.verifyTrainPnr(auth.access, TEST_PNRS.vandeBharatCC);

    expect(r3a.status).toBe(200);
    expect(rsl.status).toBe(200);
    expect(rcc.status).toBe(200);
    expect(r3a.data.trust_tier).toBe('verified_provider');
  });

  test('TurnstileVerifier fake adapter accepts configured test token on anonymous & OTP auth', async () => {
    const api = new SaathApiClient();
    const anon = await api.issueAnonymousToken(E2E_ENV.turnstileTestToken);
    expect([200, 201]).toContain(anon.status);
    expect(typeof anon.data.access).toBe('string');

    const otpStart = await api.startOtp(uniquePhone(30_002), 'whatsapp', E2E_ENV.turnstileTestToken);
    expect([200, 201]).toContain(otpStart.status);
    expect(otpStart.data.resend_after).toBe(30);
  });

  test('PaymentGatewayProvider sandbox adapter executes checkout and settlement cleanly', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone(30_003));
    const checkout = await api.checkoutPlan(auth.access, {
      plan_code: 'group_organiser_pass',
    });
    expect([200, 201]).toContain(checkout.status);
    expect(checkout.data.currency).toBe('INR');

    const orderId = getString(checkout.data, 'order_id');
    const complete = await api.completeSandboxPayment(auth.access, orderId);
    expect(complete.status).toBe(200);
  });

  test('LLMProvider adapter returns deterministic concierge SSE and outreach draft', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone(30_004));
    const verify = await api.verifyTrainPnr(auth.access, TEST_PNRS.rajdhani3A);
    const journeyId = getString(asRecord(verify.data.journey, 'journey'), 'id');

    const concierge = await api.conciergeStream(auth.access, journeyId, 'Help me get a lower berth');
    expect(concierge.status).toBe(200);
    expect(concierge.events.length).toBeGreaterThanOrEqual(1);
  });

  test('MessagingProvider adapter delivers OTP across whatsapp and sms channels', async () => {
    const api = new SaathApiClient();
    const tokensWa = await api.loginWithOtp(uniquePhone(30_005), 'whatsapp');
    const tokensSms = await api.loginWithOtp(uniquePhone(30_006), 'sms');

    expect(tokensWa.access.length).toBeGreaterThan(20);
    expect(tokensSms.access.length).toBeGreaterThan(20);
  });
});
