import { test, expect } from '@playwright/test';
import { SaathApiClient } from '../../helpers/api.js';
import { uniquePhone } from '../../helpers/env.js';

test.describe('@tier2 F04: Token Rotation & Reuse Attack Detection', () => {
  test('Replaying an already-rotated refresh token revokes the entire token family', async () => {
    const api = new SaathApiClient();
    const t0 = await api.loginWithOtp(uniquePhone('f04-t2-reuse'), 'whatsapp');

    const t1 = await api.refreshTokens(t0.refresh);
    expect(t1.status).toBe(200);

    // Attacker replays old t0.refresh
    const attackerReplay = await api.refreshTokens(t0.refresh);
    api.assertProblemJson(attackerReplay, 401);
    expect(attackerReplay.status).toBe(401);

    // Entire family is now revoked: legitimate t1.refresh must also fail with 401
    const legitimateAfterReuse = await api.refreshTokens(t1.data.refresh);
    api.assertProblemJson(legitimateAfterReuse, 401);
    expect(legitimateAfterReuse.status).toBe(401);
  });

  test('Tampered or unknown refresh token returns 401 problem+json', async () => {
    const api = new SaathApiClient();
    const res = await api.refreshTokens('rt_tampered_invalid_token_value_1234567890');
    const problem = api.assertProblemJson(res, 401);
    expect(problem.status).toBe(401);
  });

  test('Missing or non-Bearer Authorization header rejected with 401', async () => {
    const api = new SaathApiClient();
    const noHeader = await api.request('GET', '/v1/me');
    api.assertProblemJson(noHeader, 401);

    const basicHeader = await api.request('GET', '/v1/me', {
      headers: { Authorization: 'Basic dXNlcjpwYXNz' },
    });
    const problem = api.assertProblemJson(basicHeader, 401);
    expect(problem.status).toBe(401);
  });

  test('Logout with invalid or missing token returns 401', async () => {
    const api = new SaathApiClient();
    const res = await api.logout('invalid.jwt.token');
    const problem = api.assertProblemJson(res, 401);
    expect(problem.status).toBe(401);
  });

  test('Anonymous access JWT cannot be exchanged via /v1/auth/refresh', async () => {
    const api = new SaathApiClient();
    const anon = await api.issueAnonymousToken();
    expect(anon.ok).toBe(true);

    const res = await api.refreshTokens(anon.data.access);
    const problem = api.assertProblemJson(res, [401, 422]);
    expect([401, 422]).toContain(problem.status);
  });
});
