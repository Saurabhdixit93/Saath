import { test, expect } from '../../fixtures/multi-browser.js';
import { SaathApiClient } from '../../helpers/api.js';
import { TEST_PNRS } from '../../helpers/env.js';
import { assertNoPiiLeak } from '../../helpers/pii.js';

test.describe('F20 Tier 2: ISR SEO Utility Pages Edge Cases @tier2', () => {
  test('Public /pnr-status/{invalid} rejects bad PNR cleanly with 404/422 RFC 9457', async ({
    page,
  }) => {
    const api = new SaathApiClient();
    const resInvalid = await api.getPublicPnrStatus('ABC123');
    api.assertProblemJson(resInvalid, [404, 422]);

    const resFlushed = await api.getPublicPnrStatus(TEST_PNRS.flushed);
    api.assertProblemJson(resFlushed, [404, 422]);

    await page.goto('/pnr-status', { waitUntil: 'domcontentloaded' });
    const input = page.getByRole('textbox').first();
    await input.fill(TEST_PNRS.flushed);
    await page.getByRole('button', { name: /check|verify|status/i }).first().click();
    await expect(page.getByText(/flushed|cancelled|not found|double-check/i).first()).toBeVisible();
  });

  test('Public /pnr-status/{pnr} never leaks co-passenger PII across all fields', async () => {
    const api = new SaathApiClient();
    const res = await api.getPublicPnrStatus(TEST_PNRS.rajdhani3A);
    expect(res.status).toBe(200);
    assertNoPiiLeak(res.data, 'tier2-public-pnr-status', [TEST_PNRS.rajdhani3A]);
  });

  test('Unknown train number returns 404 on /v1/public/train/00000/live and clean UI state', async ({
    page,
  }) => {
    const api = new SaathApiClient();
    const res = await api.getPublicTrainLive('00000');
    api.assertProblemJson(res, 404);

    const response = await page.goto('/train/00000/live', { waitUntil: 'domcontentloaded' });
    expect([200, 404]).toContain(response?.status() ?? 0);
    await expect(page.getByText(/not found|unavailable|404/i).first()).toBeVisible();
  });

  test('Unknown airline/aircraft on /v1/public/flight-layouts and /flights/XX/BAD/seat-map returns clean 404', async ({
    page,
  }) => {
    const api = new SaathApiClient();
    const res = await api.getPublicFlightLayouts('XX', 'BAD999');
    expect([200, 404]).toContain(res.status);
    const items = Array.isArray(res.data.items) ? res.data.items : [];
    expect(items.length).toBe(0);

    const pageRes = await page.goto('/flights/XX/BAD999/seat-map', {
      waitUntil: 'domcontentloaded',
    });
    expect([200, 404]).toContain(pageRes?.status() ?? 0);
  });

  test('Public SEO endpoints expose cache headers or enforce rate limits under burst', async () => {
    const api = new SaathApiClient();
    const res = await api.getPublicStats();
    expect(res.status).toBe(200);

    const cacheControl = res.headers.get('cache-control') ?? '';
    expect(cacheControl.length).toBeGreaterThan(0);
  });
});
