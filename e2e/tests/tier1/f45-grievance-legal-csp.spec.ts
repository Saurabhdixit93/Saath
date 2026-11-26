import { test, expect, injectAuthSession } from '../../fixtures/multi-browser.js';
import { assertLocale, assertTapTargets, assertWcagAA } from '../../helpers/a11y.js';
import { SaathApiClient } from '../../helpers/api.js';
import { E2E_ENV, uniquePhone } from '../../helpers/env.js';

test.describe('@tier1 F45 (Feature 15): Grievance Officer, Legal Pages & Nonce CSP', () => {
  test('Footer renders /legal/privacy, /legal/terms, and /grievance links and /sitemap.xml indexes them', async ({
    page,
  }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const footer = page.locator('footer');
    await expect(footer.locator('a[href*="/legal/privacy"]')).toBeVisible();
    await expect(footer.locator('a[href*="/legal/terms"]')).toBeVisible();
    await expect(footer.locator('a[href*="/grievance"]')).toBeVisible();

    const sitemapRes = await fetch(`${E2E_ENV.webUrl}/sitemap.xml`);
    expect(sitemapRes.status).toBe(200);
    const xml = await sitemapRes.text();
    expect(xml).toContain('/legal/privacy');
    expect(xml).toContain('/legal/terms');
    expect(xml).toContain('/grievance');
  });

  test('/legal/privacy renders all 5 DPDP purposes and retention windows in en and hi', async ({
    page,
  }) => {
    await page.goto('/legal/privacy', { waitUntil: 'domcontentloaded' });
    const main = page.locator('main');
    await expect(main).toContainText(/verification/i);
    await expect(main).toContainText(/matching/i);
    await expect(main).toContainText(/notifications/i);
    await expect(main).toContainText(/analytics/i);
    await expect(main).toContainText(/whatsapp/i);
    await expect(main).toContainText(/retention|hours|days|purge/i);
    await assertWcagAA(page);
    await assertTapTargets(page);

    await page.getByRole('button', { name: /हिं|EN|Language/i }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', /^hi/i);
    await assertLocale(page, 'hi');
  });

  test('/legal/terms renders TTE authority and non-IRCTC affiliation disclaimers in en and hi', async ({
    page,
  }) => {
    await page.goto('/legal/terms', { waitUntil: 'domcontentloaded' });
    const main = page.locator('main');
    await expect(main).toContainText(/TTE/i);
    await expect(main).toContainText(/IRCTC/i);
    await assertWcagAA(page);
    await assertTapTargets(page);

    await page.getByRole('button', { name: /हिं|EN|Language/i }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', /^hi/i);
    await assertLocale(page, 'hi');
  });

  test('/grievance renders Grievance Officer email and SLA timeline in en and hi', async ({
    page,
  }) => {
    await page.goto('/grievance', { waitUntil: 'domcontentloaded' });
    const main = page.locator('main');
    await expect(main).toContainText(/Grievance Officer/i);
    await expect(main).toContainText(/@/);
    await expect(main).toContainText(/hours|days|SLA|72|48|30/i);
    await assertWcagAA(page);
    await assertTapTargets(page);

    await page.getByRole('button', { name: /हिं|EN|Language/i }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', /^hi/i);
    await assertLocale(page, 'hi');
  });

  test('apps/web serves nonce-based Content-Security-Policy across /, /legal/*, /grievance, and /profile', async ({
    createIsolatedPassenger,
  }) => {
    const passenger = await createIsolatedPassenger('f45-csp');
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone('f45-csp'));
    await injectAuthSession(passenger.page, auth);

    for (const route of ['/', '/legal/privacy', '/legal/terms', '/grievance', '/profile']) {
      const response = await passenger.page.goto(route, { waitUntil: 'domcontentloaded' });
      expect(response?.status()).toBe(200);
      const csp = response?.headers()['content-security-policy'] ?? '';
      expect(csp).toContain('nonce-');
      const scriptSrc = /script-src[^;]*/i.exec(csp)?.[0] ?? '';
      expect(scriptSrc).toContain('nonce-');
      expect(scriptSrc).not.toContain("'unsafe-inline'");
    }
  });
});
