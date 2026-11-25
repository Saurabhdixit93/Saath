import { test, expect } from '@playwright/test';
import { SaathApiClient } from '../../helpers/api.js';
import { E2E_ENV } from '../../helpers/env.js';

test.describe('@tier1 F01: Monorepo & Local/Prod Stack', () => {
  test('GET /healthz returns 200 ok status', async () => {
    const api = new SaathApiClient();
    const res = await api.healthz();
    expect(res.status).toBe(200);
    expect(res.data.status).toBe('ok');
  });

  test('GET /readyz verifies PostgreSQL 16 and Redis 7 readiness', async () => {
    const api = new SaathApiClient();
    const res = await api.readyz();
    expect(res.status).toBe(200);
    expect(res.data.status).toBe('ready');
    expect(res.data.db).toBe('ok');
    expect(res.data.redis).toBe('ok');
  });

  test('apps/web SSR home page loads with Saath brand copy', async ({ page }) => {
    const response = await page.goto(E2E_ENV.webUrl, { waitUntil: 'domcontentloaded' });
    expect(response?.status()).toBe(200);
    await expect(page.getByRole('heading', { name: /sit together\. safely\./i })).toBeVisible();
    await expect(page.getByRole('tab', { name: /train/i })).toBeVisible();
  });

  test('apps/admin portal responds without server 500 error', async ({ request }) => {
    const res = await request.get(E2E_ENV.adminUrl);
    expect(res.status()).toBeLessThan(500);
    expect([200, 302, 307, 401, 403]).toContain(res.status());
  });

  test('API serves OpenAPI schema and RFC 9457 problem+json on missing route', async () => {
    const api = new SaathApiClient();
    const openapiRes = await api.request<{ openapi: string; paths: Record<string, unknown> }>(
      'GET',
      '/openapi.json',
    );
    expect(openapiRes.status).toBe(200);
    expect(openapiRes.data.openapi).toMatch(/^3\./);
    expect(Object.keys(openapiRes.data.paths).length).toBeGreaterThan(10);

    const missingRes = await api.request('GET', '/v1/nonexistent-contract-endpoint');
    const problem = api.assertProblemJson(missingRes, 404);
    expect(problem.status).toBe(404);
  });
});
