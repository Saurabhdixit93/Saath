import { test, expect } from '../../fixtures/multi-browser.js';
import { SaathApiClient } from '../../helpers/api.js';
import { E2E_ENV, uniquePhone } from '../../helpers/env.js';

function assertProdSessionGuard(status: number): void {
  if (E2E_ENV.envMode === 'production') {
    expect([401, 403]).toContain(status);
  } else {
    expect([200, 201]).toContain(status);
  }
}

test.describe('@tier2 F31 Tier 2: Admin SSO Session & require_admin_actor Boundaries', () => {
  test('Missing credentials, whitespace email, and extra unknown body fields return 422 RFC 9457', async () => {
    const api = new SaathApiClient();

    api.assertProblemJson(await api.request('POST', '/v1/admin/auth/session', { body: {} }), 422);
    api.assertProblemJson(
      await api.request('POST', '/v1/admin/auth/session', { body: { email: '   ' } }),
      422,
    );
    api.assertProblemJson(
      await api.request('POST', '/v1/admin/auth/session', {
        body: { email: E2E_ENV.adminTestEmail, role: 'superadmin' },
      }),
      422,
    );
  });

  test('Non-allowlisted email returns 403 and invalid OIDC id_token/code returns 401/403 RFC 9457', async () => {
    const api = new SaathApiClient();

    api.assertProblemJson(await api.createAdminSession('intruder@evil.example'), 403);
    api.assertProblemJson(
      await api.createAdminSession(undefined, { id_token: 'invalid.oidc.id_token' }),
      [401, 403, 422],
    );
    api.assertProblemJson(
      await api.createAdminSession(undefined, { code: 'bad-auth-code' }),
      [401, 403, 422],
    );
  });

  test('Unauthenticated requests and malformed/tampered Bearer JWTs return 401 across /v1/admin/*', async () => {
    const api = new SaathApiClient();
    const fakeAlgNone = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from('{"sub":"admin:ops@saath.test","kind":"admin"}').toString('base64url')}.`;

    for (const path of [
      '/v1/admin/analytics/funnel',
      '/v1/admin/providers/health',
      '/v1/admin/moderation/queue',
      '/v1/admin/fraud/graph',
      '/v1/admin/flags',
      '/v1/admin/disputes',
      '/v1/admin/redemptions',
      '/v1/admin/audit-log',
    ]) {
      api.assertProblemJson(await api.request('GET', path), 401);
      api.assertProblemJson(await api.request('GET', path, { token: 'invalid.jwt.token' }), 401);
      api.assertProblemJson(await api.request('GET', path, { token: fakeAlgNone }), 401);
    }
  });

  test('Passenger JWT and anonymous JWT are rejected with 403 on all /v1/admin/* endpoints', async () => {
    const api = new SaathApiClient();
    const user = await api.loginWithOtp(uniquePhone('f31-t2-user'));
    const anon = await api.issueAnonymousToken();

    for (const token of [user.access, anon.data.access]) {
      api.assertProblemJson(await api.getAdminFunnel(token), 403);
      api.assertProblemJson(await api.getAdminProvidersHealth(token), 403);
      api.assertProblemJson(await api.getAdminModerationQueue(token), 403);
      api.assertProblemJson(await api.getAdminFraudGraph(token), 403);
      api.assertProblemJson(await api.getAdminFlags(token), 403);
      api.assertProblemJson(await api.getAdminDisputes(token), 403);
      api.assertProblemJson(await api.getAdminRedemptions(token), 403);
      api.assertProblemJson(await api.getAdminAuditLog(token), 403);
    }
  });

  test('Production passwordless email guard and /test-login + /admin/reset-demo absence check', async () => {
    const api = new SaathApiClient();
    const sessionRes = await api.createAdminSession(E2E_ENV.adminTestEmail);
    assertProdSessionGuard(sessionRes.status);

    const testLoginRes = await api.request('POST', '/test-login', {
      body: { phone: uniquePhone('f31-t2-prod') },
    });
    const resetRes = await api.request('POST', '/admin/reset-demo');
    const expected = E2E_ENV.envMode === 'production' ? [404, 405] : [200, 404, 405];
    expect(expected).toContain(testLoginRes.status);
    expect(expected).toContain(resetRes.status);
  });
});
