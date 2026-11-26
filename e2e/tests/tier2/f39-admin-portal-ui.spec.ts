import { test, expect } from '../../fixtures/multi-browser.js';
import { signInAdminUi } from '../../helpers/admin-seed.js';
import { assertTapTargets, assertWcagAA } from '../../helpers/a11y.js';
import { SaathApiClient } from '../../helpers/api.js';
import { E2E_ENV } from '../../helpers/env.js';
import { assertNoPiiLeak } from '../../helpers/pii.js';

test.describe('@tier2 F39 Tier 2: Admin Portal UI Boundaries & WCAG 2.2 AA', () => {
  test('Unauthenticated visits to /, /moderation, /fraud, /flags, and /audit gate to /login without PII leak', async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      for (const route of ['/', '/moderation', '/fraud', '/flags', '/audit']) {
        await page.goto(`${E2E_ENV.adminUrl}${route}`, { waitUntil: 'domcontentloaded' });
        const bodyText = await page.locator('body').innerText();
        assertNoPiiLeak({ text: bodyText }, `unauth-admin-${route}`);
        const onLogin = /\/login/.test(page.url());
        const hasLoginPrompt = /sign in|operator sso|login/i.test(bodyText);
        expect(onLogin || hasLoginPrompt).toBe(true);
      }
    } finally {
      await context.close();
    }
  });

  test('Non-allowlisted email submitted on /login is rejected cleanly without authenticating', async ({
    page,
  }) => {
    await page.goto(`${E2E_ENV.adminUrl}/login`, { waitUntil: 'domcontentloaded' });
    const emailInput = page
      .getByLabel(/email/i)
      .or(page.getByPlaceholder(/email|ops@saath/i))
      .or(page.getByRole('textbox'))
      .first();
    await expect(emailInput).toBeVisible();
    await emailInput.fill('intruder@evil.example');

    await page
      .getByRole('button', { name: /sign in|login|continue|session|submit/i })
      .first()
      .click();

    await expect(page).toHaveURL(/\/login/);
    await expect(
      page.getByText(/not allowlisted|forbidden|denied|unauthorized|failed/i).first(),
    ).toBeVisible();
  });

  test('Tampered saath_admin_token redirects back to /login without crashing', async ({ page }) => {
    await page.goto(`${E2E_ENV.adminUrl}/login`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      window.localStorage.setItem('saath_access_token', 'tampered.admin.token');
      window.localStorage.setItem('saath_admin_token', 'tampered.admin.token');
    });
    await page.context().addCookies([
      { name: 'saath_admin_token', value: 'tampered.admin.token', url: E2E_ENV.adminUrl },
    ]);

    await page.goto(`${E2E_ENV.adminUrl}/moderation`, { waitUntil: 'domcontentloaded' });
    const bodyText = await page.locator('body').innerText();
    expect(/\/login/.test(page.url()) || /sign in|login|unauthorized/i.test(bodyText)).toBe(true);
  });

  test('Unknown Admin Portal route returns 404 without 500 or PII leak', async ({ request }) => {
    const res = await request.get(`${E2E_ENV.adminUrl}/nonexistent-admin-route-xyz`);
    expect(res.status()).toBe(404);
    const body = await res.text();
    assertNoPiiLeak({ text: body }, 'admin-404');
  });

  test('Admin Portal /login, /, /moderation, /fraud, /flags, and /audit pass WCAG 2.2 AA & >=48px tap targets at 360x800', async ({
    browser,
  }) => {
    const api = new SaathApiClient();
    const context = await browser.newContext({
      viewport: { width: 360, height: 800 },
      hasTouch: true,
    });
    const page = await context.newPage();
    try {
      await page.goto(`${E2E_ENV.adminUrl}/login`, { waitUntil: 'domcontentloaded' });
      await assertWcagAA(page);
      await assertTapTargets(page);

      await signInAdminUi(page, api);
      for (const route of ['/', '/moderation', '/fraud', '/flags', '/audit']) {
        await page.goto(`${E2E_ENV.adminUrl}${route}`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByRole('heading').first()).toBeVisible();
        await assertWcagAA(page);
        await assertTapTargets(page);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth,
        );
        expect(overflow).toBeLessThanOrEqual(2);
      }
    } finally {
      await context.close();
    }
  });
});
