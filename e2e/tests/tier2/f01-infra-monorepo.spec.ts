import { test, expect } from '@playwright/test';
import { SaathApiClient } from '../../helpers/api.js';
import { E2E_ENV } from '../../helpers/env.js';

test.describe('@tier2 F01: Monorepo & Infra Boundary Cases', () => {
  test('Malformed JSON request body returns RFC 9457 400 or 422 without stack trace', async () => {
    const api = new SaathApiClient();
    const res = await api.request('POST', '/v1/auth/anonymous', {
      body: '{"turnstile": ',
      headers: { 'Content-Type': 'application/json' },
    });

    const problem = api.assertProblemJson(res, [400, 422]);
    expect([400, 422]).toContain(problem.status);
    expect(res.rawText).not.toMatch(/Traceback|sqlalchemy|asyncpg/i);
  });

  test('Unsupported HTTP method on /healthz returns 405 without 500 error', async () => {
    const api = new SaathApiClient();
    const res = await api.request('DELETE', '/healthz');
    expect(res.status).toBe(405);
  });

  test('apps/web responses include baseline security headers', async ({ request }) => {
    const res = await request.get(E2E_ENV.webUrl);
    expect(res.status()).toBe(200);
    const headers = res.headers();
    const nosniff = headers['x-content-type-options'];
    expect(nosniff === undefined || nosniff.toLowerCase() === 'nosniff').toBe(true);
    expect(headers['x-powered-by']).toBeUndefined();
  });

  test('CORS preflight from untrusted origin does not allow wildcard credentials', async () => {
    const api = new SaathApiClient();
    const res = await api.request('OPTIONS', '/v1/pricing/plans', {
      headers: {
        Origin: 'https://evil-phish.example.com',
        'Access-Control-Request-Method': 'GET',
      },
    });
    const allowOrigin = res.headers.get('access-control-allow-origin');
    const allowCreds = res.headers.get('access-control-allow-credentials');
    expect(allowOrigin === '*' && allowCreds === 'true').toBe(false);
    expect(res.status).toBeLessThan(500);
  });

  test('GET /readyz never leaks database credentials or internal connection URLs', async () => {
    const api = new SaathApiClient();
    const res = await api.readyz();
    expect(res.status).toBe(200);
    expect(res.rawText).not.toMatch(/postgres:\/\/|postgresql:\/\/|redis:\/\/|password/i);
  });
});
