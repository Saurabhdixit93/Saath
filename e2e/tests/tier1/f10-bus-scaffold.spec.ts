import { test, expect } from '@playwright/test';
import { assertLocale, assertTapTargets } from '../../helpers/a11y.js';
import { SaathApiClient } from '../../helpers/api.js';
import { E2E_ENV, uniquePhone } from '../../helpers/env.js';

test.describe('@tier1 F10: Bus Mode Scaffold', () => {
  test('Home page displays Train, Flight, and Bus mode tabs', async ({ page }) => {
    await page.goto(E2E_ENV.webUrl, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('tab', { name: /train/i })).toBeVisible();
    await expect(page.getByRole('tab', { name: /flight/i })).toBeVisible();
    await expect(page.getByRole('tab', { name: /bus/i })).toBeVisible();
  });

  test('Selecting Bus tab displays clean coming-soon v1.1 placeholder in English', async ({
    page,
  }) => {
    await page.goto(E2E_ENV.webUrl, { waitUntil: 'domcontentloaded' });
    await page.getByRole('tab', { name: /bus/i }).click();

    await expect(
      page.getByText(/coming soon|v1\.1|redbus|abhibus|sleeper bus/i).first(),
    ).toBeVisible();
    await assertLocale(page, 'en');
  });

  test('Bus tab coming-soon copy renders cleanly in Hindi (hi) locale', async ({ page }) => {
    await page.goto(E2E_ENV.webUrl, { waitUntil: 'domcontentloaded' });
    const langToggle = page.getByRole('button', { name: /हिं|hindi|en|language/i }).first();
    await langToggle.click();

    await page.getByRole('tab', { name: /bus|बस/i }).click();
    await assertLocale(page, 'hi');
    await expect(page.getByText(/बस|जल्द|आ रहा/i).first()).toBeVisible();
  });

  test('Mobile 360x800 viewport preserves >=48px tap targets across Train/Flight/Bus tabs', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto(E2E_ENV.webUrl, { waitUntil: 'domcontentloaded' });
    await page.getByRole('tab', { name: /bus/i }).click();
    await assertTapTargets(page);
    expect(page.url()).toContain(E2E_ENV.webUrl.replace(/\/$/, ''));
  });

  test('POST /v1/journeys/verify with mode=bus returns clean RFC 9457 422 or 501', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone('f10-bus-api'), 'whatsapp');

    const res = await api.verifyJourney(auth.access, {
      mode: 'bus',
      pnr: 'BUS1234567',
    });
    const problem = api.assertProblemJson(res, [422, 501]);
    expect([422, 501]).toContain(problem.status);
  });
});
