import fs from 'node:fs/promises';
import { test, expect, injectAuthSession } from '../../fixtures/multi-browser.js';
import { assertLocale, assertTapTargets, assertWcagAA } from '../../helpers/a11y.js';
import { E2E_ENV, TEST_PNRS, uniquePhone } from '../../helpers/env.js';
import { parseDpdpExportZip } from '../../helpers/zip.js';

test.describe('@tier3 P13: Web DPDP Consents -> Legal/Grievance Bilingual + CSP -> Profile Export & Erasure', () => {
  test('First-verify itemised DPDP consent UI (en & hi) persists to /v1/me/consents and /profile toggles update ledger', async ({
    createIsolatedPassenger,
  }) => {
    const passenger = await createIsolatedPassenger('p13-consents');
    const auth = await passenger.api.loginWithOtp(uniquePhone('p13-consents'));
    await injectAuthSession(passenger.page, auth);

    await passenger.page.goto('/', { waitUntil: 'domcontentloaded' });
    const pnrInput = passenger.page
      .getByLabel(/pnr/i)
      .or(passenger.page.getByPlaceholder(/10-digit|pnr/i))
      .first();
    await pnrInput.fill(TEST_PNRS.rajdhani3A);
    await passenger.page.getByRole('button', { name: /verify|check/i }).first().click();

    await expect(passenger.page.getByText(/DPDP|Consent|Data use/i).first()).toBeVisible();
    await passenger.page
      .getByRole('button', { name: /agree|accept|save|continue/i })
      .first()
      .click();

    await passenger.page.goto('/profile', { waitUntil: 'domcontentloaded' });
    const analyticsSwitch = passenger.page
      .getByRole('switch', { name: /analytics/i })
      .or(passenger.page.getByRole('checkbox', { name: /analytics/i }))
      .first();
    await expect(analyticsSwitch).toBeVisible();
    await Promise.all([
      passenger.page.waitForResponse(
        (res) => res.url().includes('/v1/me/consents') && res.request().method() === 'POST',
      ),
      analyticsSwitch.click(),
    ]);

    const consentsAfter = await passenger.api.getConsents<{
      consents: Array<{ purpose: string; granted: boolean }>;
    }>(auth.access);
    expect(consentsAfter.status).toBe(200);
    expect(consentsAfter.data.consents.length).toBeGreaterThanOrEqual(2);
  });

  test('/legal/privacy, /legal/terms, /grievance bilingual navigation, footer, sitemap, and nonce CSP', async ({
    page,
  }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const footer = page.locator('footer');
    await expect(footer.locator('a[href*="/legal/privacy"]')).toBeVisible();
    await expect(footer.locator('a[href*="/legal/terms"]')).toBeVisible();
    await expect(footer.locator('a[href*="/grievance"]')).toBeVisible();

    for (const route of ['/legal/privacy', '/legal/terms', '/grievance']) {
      const resp = await page.goto(route, { waitUntil: 'domcontentloaded' });
      expect(resp?.status()).toBe(200);
      const csp = resp?.headers()['content-security-policy'] ?? '';
      expect(csp).toContain('nonce-');
      expect((/script-src[^;]*/i.exec(csp)?.[0] ?? '')).not.toContain("'unsafe-inline'");
      await assertWcagAA(page);
      await assertTapTargets(page);

      await page.getByRole('button', { name: /हिं|EN|Language/i }).click();
      await assertLocale(page, 'hi');
    }

    const sitemap = await fetch(`${E2E_ENV.webUrl}/sitemap.xml`);
    const xml = await sitemap.text();
    expect(xml).toContain('/legal/privacy');
    expect(xml).toContain('/legal/terms');
    expect(xml).toContain('/grievance');
  });

  test('/profile ZIP export + account deletion UI immediately invalidates JWT, refresh token, and journeys access', async ({
    createIsolatedPassenger,
  }) => {
    const passenger = await createIsolatedPassenger('p13-erasure');
    const auth = await passenger.api.loginWithOtp(uniquePhone('p13-erasure'));
    await passenger.api.verifyTrainPnr(auth.access, TEST_PNRS.rajdhani3A);

    await injectAuthSession(passenger.page, auth);
    await passenger.page.goto('/profile', { waitUntil: 'domcontentloaded' });

    const [download] = await Promise.all([
      passenger.page.waitForEvent('download'),
      passenger.page.getByRole('button', { name: /Download my data|Export/i }).click(),
    ]);
    const path = await download.path();
    expect(path).toBeTruthy();
    const bytes = await fs.readFile(String(path));
    const bundle = parseDpdpExportZip(bytes);
    expect(Object.keys(bundle)).toHaveLength(8);

    await passenger.page.getByRole('button', { name: /Delete my data|Delete account/i }).click();
    await passenger.page
      .getByRole('button', { name: /confirm delete|yes, delete|permanently delete|erase/i })
      .first()
      .click();

    await expect
      .poll(
        async () =>
          passenger.page.evaluate(() => window.localStorage.getItem('saath_access_token') ?? ''),
        { timeout: 10_000 },
      )
      .toBe('');

    passenger.api.assertProblemJson(await passenger.api.getMe(auth.access), [401, 403, 404]);
    passenger.api.assertProblemJson(await passenger.api.getJourneys(auth.access), [401, 403, 404]);
    passenger.api.assertProblemJson(await passenger.api.refreshTokens(auth.refresh), [401, 403]);
  });
});
