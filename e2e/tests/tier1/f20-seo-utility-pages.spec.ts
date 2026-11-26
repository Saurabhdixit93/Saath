import { test, expect } from '../../fixtures/multi-browser.js';
import { SaathApiClient } from '../../helpers/api.js';
import { E2E_ENV, TEST_PNRS, futureDateIso } from '../../helpers/env.js';
import { assertNoPiiLeak } from '../../helpers/pii.js';

test.describe('F20: ISR SEO Utility Pages & Sitemap @tier1', () => {
  test('/pnr-status page and /v1/public/pnr-status/{pnr} return status aggregates without co-passenger PII', async ({
    page,
  }) => {
    const api = new SaathApiClient();
    const res = await api.getPublicPnrStatus(TEST_PNRS.rajdhani3A);
    expect(res.status).toBe(200);
    assertNoPiiLeak(res.data, 'public-pnr-status', [TEST_PNRS.rajdhani3A]);

    await page.goto('/pnr-status', { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(/PNR Status|Find a swap|open to help/i).first()).toBeVisible();

    const ldScripts = await page.locator('script[type="application/ld+json"]').allTextContents();
    expect(ldScripts.length).toBeGreaterThanOrEqual(1);
    expect(ldScripts.join('\n')).toMatch(/FAQPage|BreadcrumbList/);
  });

  test('/train/12951/live and /train/12951/chart-time render live status, chart time, and JSON-LD', async ({
    page,
  }) => {
    const api = new SaathApiClient();
    const date = futureDateIso(2);

    const liveRes = await api.getPublicTrainLive('12951', date);
    expect(liveRes.status).toBe(200);
    expect(String(liveRes.data.train_no)).toBe('12951');

    const chartRes = await api.getPublicTrainChartTime('12951', date);
    expect(chartRes.status).toBe(200);
    expect(chartRes.data.chart_due_at).toBeDefined();

    await page.goto('/train/12951/live', { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(/12951/).first()).toBeVisible();
    await expect(page.locator('script[type="application/ld+json"]').first()).toBeAttached();

    await page.goto('/train/12951/chart-time', { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(/12951/).first()).toBeVisible();
    await expect(page.getByText(/Chart|chart/i).first()).toBeVisible();
  });

  test('/train/12951/coach-position renders coach composition and swap CTA', async ({ page }) => {
    const api = new SaathApiClient();
    const compRes = await api.getPublicTrainComposition('12951');
    expect(compRes.status).toBe(200);
    expect(Array.isArray(compRes.data.coaches)).toBe(true);

    await page.goto('/train/12951/coach-position', { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(/12951/).first()).toBeVisible();
    await expect(page.getByText(/Find a swap|Open to help|Coach/i).first()).toBeVisible();
  });

  test('/flights/6E/A320neo/seat-map renders aircraft layout SVG from /v1/public/flight-layouts', async ({
    page,
  }) => {
    const api = new SaathApiClient();
    const layoutsRes = await api.getPublicFlightLayouts('6E', 'A320neo');
    expect(layoutsRes.status).toBe(200);
    expect(Array.isArray(layoutsRes.data.items)).toBe(true);

    await page.goto('/flights/6E/A320neo/seat-map', { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(/A320neo/i).first()).toBeVisible();
    await expect(page.locator('svg').first()).toBeVisible();
  });

  test('/blog/[slug], /sitemap.xml, and /robots.txt serve valid SEO artifacts', async ({
    page,
  }) => {
    const sitemapRes = await fetch(`${E2E_ENV.webUrl}/sitemap.xml`);
    expect(sitemapRes.status).toBe(200);
    const sitemapText = await sitemapRes.text();
    expect(sitemapText).toContain('<urlset');
    expect(sitemapText).toContain('/pnr-status');
    expect(sitemapText).toContain('/legal/privacy');
    expect(sitemapText).toContain('/legal/terms');
    expect(sitemapText).toContain('/grievance');

    const robotsRes = await fetch(`${E2E_ENV.webUrl}/robots.txt`);
    expect(robotsRes.status).toBe(200);
    const robotsText = await robotsRes.text();
    expect(robotsText.toLowerCase()).toContain('sitemap:');

    await page.goto('/blog/how-seat-swapping-works-in-indian-railways', {
      waitUntil: 'domcontentloaded',
    });
    const title = await page.title();
    expect(title.length).toBeGreaterThan(3);
  });
});
