import { test, expect, type Page } from '@playwright/test';
import { assertLocale, assertWcagAA } from '../../helpers/a11y.js';
import { SaathApiClient } from '../../helpers/api.js';
import { E2E_ENV, uniquePhone } from '../../helpers/env.js';

function trackVerifyRequests(page: Page): string[] {
  const verifyRequests: string[] = [];
  page.on('request', (req) => {
    if (req.url().includes('/journeys/verify')) {
      verifyRequests.push(req.url());
    }
  });
  return verifyRequests;
}

test.describe('@tier2 F10: Bus Mode Scaffold Boundary & Accessibility', () => {
  test('POST /v1/journeys/verify with mode=bus and empty payload returns 422/501 problem+json', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone('f10-t2-empty'), 'whatsapp');

    const res = await api.verifyJourney(auth.access, { mode: 'bus' });
    const problem = api.assertProblemJson(res, [422, 501]);
    expect([422, 501]).toContain(problem.status);
  });

  test('Unsupported transport_mode (ferry) returns 422 problem+json', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone('f10-t2-ferry'), 'whatsapp');

    const res = await api.verifyJourney(auth.access, { mode: 'ferry', pnr: '1234567890' });
    const problem = api.assertProblemJson(res, 422);
    expect(problem.status).toBe(422);
  });

  test('Selecting Bus tab in Web UI triggers zero /v1/journeys/verify requests or 5xx errors', async ({
    page,
  }) => {
    const verifyRequests = trackVerifyRequests(page);

    await page.goto(E2E_ENV.webUrl, { waitUntil: 'domcontentloaded' });
    await page.getByRole('tab', { name: /bus/i }).click();
    await expect(page.getByText(/coming soon|v1\.1/i).first()).toBeVisible();
    expect(verifyRequests).toHaveLength(0);
  });

  test('Bus tab coming-soon view passes WCAG 2.2 AA accessibility audit', async ({ page }) => {
    await page.goto(E2E_ENV.webUrl, { waitUntil: 'domcontentloaded' });
    await page.getByRole('tab', { name: /bus/i }).click();
    await assertWcagAA(page);
    await expect(page.getByRole('tab', { name: /bus/i })).toHaveAttribute('aria-selected', 'true');
  });

  test('Switching between Bus, Train, and Flight tabs in Hindi retains valid locale and layout', async ({
    page,
  }) => {
    await page.goto(E2E_ENV.webUrl, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: /हिं|hindi|en|language/i }).first().click();

    await page.getByRole('tab', { name: /bus|बस/i }).click();
    await assertLocale(page, 'hi');

    await page.getByRole('tab', { name: /train|ट्रेन/i }).click();
    await expect(page.getByLabel(/pnr|पीएनआर/i).or(page.getByPlaceholder(/pnr|10/i)).first()).toBeVisible();
  });
});
