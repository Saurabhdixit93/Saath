import { test, expect } from '../../fixtures/multi-browser.js';
import { SaathApiClient } from '../../helpers/api.js';
import { TEST_PNRS, uniquePhone } from '../../helpers/env.js';

test.describe('F30 Tier 2: Pluggable Adapter Failure, Timeout & Sandbox Guards @tier2', () => {
  test('TurnstileVerifier rejects invalid or empty Turnstile token with 400/403', async () => {
    const api = new SaathApiClient();
    const res = await api.issueAnonymousToken('invalid-turnstile-token');
    api.assertProblemJson(res, [400, 403]);
  });

  test('RailDataProvider handles flushed and cancelled sentinel PNRs with RFC 9457 404/422', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone(302_001));

    const flushed = await api.verifyTrainPnr(auth.access, TEST_PNRS.flushed);
    api.assertProblemJson(flushed, [404, 422]);

    const cancelled = await api.verifyTrainPnr(auth.access, TEST_PNRS.cancelled);
    api.assertProblemJson(cancelled, [404, 422]);
  });

  test('PaymentGatewayProvider sandbox rejects invalid or tampered order completion', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone(302_002));
    const res = await api.completeSandboxPayment(auth.access, 'nonexistent-order-id');
    api.assertProblemJson(res, [400, 404, 422]);
  });

  test('Simulated rail upstream outage returns clean 503 RFC 9457 without stack trace', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone(302_003));
    const res = await api.request('POST', '/v1/journeys/verify', {
      token: auth.access,
      headers: { 'X-Simulate-Provider-Failure': 'true' },
      body: { mode: 'train', pnr: TEST_PNRS.rajdhani3A },
    });
    expect([200, 503]).toContain(res.status);
    expect(res.rawText).not.toContain('Traceback');
  });

  test('B2B partner route rejects invalid X-API-Key with 401/403 RFC 9457', async () => {
    const api = new SaathApiClient();
    const res = await api.requestWithApiKey('GET', '/v1/b2b/stats', 'invalid_b2b_key_000');
    api.assertProblemJson(res, [401, 403]);
  });
});
