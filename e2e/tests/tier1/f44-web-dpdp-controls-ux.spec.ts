import fs from 'node:fs/promises';
import { test, expect, injectAuthSession } from '../../fixtures/multi-browser.js';
import { assertLocale } from '../../helpers/a11y.js';
import { TEST_PNRS, uniquePhone } from '../../helpers/env.js';
import { parseDpdpExportZip } from '../../helpers/zip.js';

test.describe('@tier1 F44 (Feature 14): Web DPDP Controls & Consent UX (apps/web)', () => {
  test('First-verify itemised DPDP consent notice renders in English and saves consents to backend', async ({
    createIsolatedPassenger,
  }) => {
    const passenger = await createIsolatedPassenger('f44-consent-en');
    const auth = await passenger.api.loginWithOtp(uniquePhone('f44-en'));
    await injectAuthSession(passenger.page, auth);

    await passenger.page.goto('/', { waitUntil: 'domcontentloaded' });
    const pnrInput = passenger.page
      .getByLabel(/pnr/i)
      .or(passenger.page.getByPlaceholder(/10-digit|pnr/i))
      .first();
    await expect(pnrInput).toBeVisible();
    await pnrInput.fill(TEST_PNRS.rajdhani3A);
    await passenger.page
      .getByRole('button', { name: /verify|check|सत्यापित/i })
      .first()
      .click();

    const consentDialog = passenger.page.getByText(/DPDP|Consent|Data use|सहमति/i).first();
    await expect(consentDialog).toBeVisible();
    const acceptBtn = passenger.page
      .getByRole('button', { name: /agree|accept|save|continue|सहमत/i })
      .first();
    await expect(acceptBtn).toBeVisible();
    await acceptBtn.click();

    await expect
      .poll(
        async () => {
          const res = await passenger.api.getConsents<{
            consents?: Array<{ purpose: string; granted: boolean }>;
          }>(auth.access);
          return (res.data.consents ?? []).length;
        },
        { timeout: 10_000 },
      )
      .toBeGreaterThanOrEqual(2);
  });

  test('First-verify itemised DPDP consent notice renders in Hindi with Devanagari script', async ({
    createIsolatedPassenger,
  }) => {
    const passenger = await createIsolatedPassenger('f44-consent-hi');
    const auth = await passenger.api.loginWithOtp(uniquePhone('f44-hi'));
    await injectAuthSession(passenger.page, auth);

    await passenger.page.goto('/hi', { waitUntil: 'domcontentloaded' });
    await assertLocale(passenger.page, 'hi');

    const pnrInput = passenger.page
      .getByLabel(/pnr|पीएनआर/i)
      .or(passenger.page.getByPlaceholder(/10-digit|pnr|पीएनआर/i))
      .first();
    await expect(pnrInput).toBeVisible();
    await pnrInput.fill(TEST_PNRS.rajdhani3A);
    await passenger.page
      .getByRole('button', { name: /verify|check|सत्यापित/i })
      .first()
      .click();

    const consentText = passenger.page.getByText(/सहमति|डेटा|DPDP|Consent/i).first();
    await expect(consentText).toBeVisible();
    await passenger.page
      .getByRole('button', { name: /सहमत|जारी|सहेजें|agree|accept|save|continue/i })
      .first()
      .click();
  });

  test('/profile renders itemised consent toggles and persists optional analytics changes across reload', async ({
    createIsolatedPassenger,
  }) => {
    const passenger = await createIsolatedPassenger('f44-toggles');
    const auth = await passenger.api.loginWithOtp(uniquePhone('f44-toggles'));
    const init = await passenger.api.getConsents<{ notice_version: string }>(auth.access);
    await passenger.api.saveConsents(auth.access, [
      { purpose: 'verification', notice_version: init.data.notice_version, granted: true },
      { purpose: 'matching', notice_version: init.data.notice_version, granted: true },
      { purpose: 'analytics', notice_version: init.data.notice_version, granted: false },
    ]);

    await injectAuthSession(passenger.page, auth);
    await passenger.page.goto('/profile', { waitUntil: 'domcontentloaded' });

    const analyticsToggle = passenger.page
      .getByRole('switch', { name: /analytics/i })
      .or(passenger.page.getByRole('checkbox', { name: /analytics/i }))
      .first();
    await expect(analyticsToggle).toBeVisible();

    await Promise.all([
      passenger.page.waitForResponse(
        (res) => res.url().includes('/v1/me/consents') && res.request().method() === 'POST',
      ),
      analyticsToggle.click(),
    ]);

    await passenger.page.reload({ waitUntil: 'domcontentloaded' });
    const after = await passenger.api.getConsents<{
      consents: Array<{ purpose: string; granted: boolean }>;
    }>(auth.access);
    expect(after.data.consents.find((c) => c.purpose === 'analytics')?.granted).toBe(true);
  });

  test('/profile Download my data button exports valid 8-file saath-data-export.zip', async ({
    createIsolatedPassenger,
  }) => {
    const passenger = await createIsolatedPassenger('f44-download');
    const auth = await passenger.api.loginWithOtp(uniquePhone('f44-dl'));
    await passenger.api.verifyTrainPnr(auth.access, TEST_PNRS.rajdhani3A);

    await injectAuthSession(passenger.page, auth);
    await passenger.page.goto('/profile', { waitUntil: 'domcontentloaded' });

    const downloadBtn = passenger.page.getByRole('button', { name: /Download my data|Export/i });
    await expect(downloadBtn).toBeVisible();
    const [download] = await Promise.all([
      passenger.page.waitForEvent('download'),
      downloadBtn.click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/saath-data-export.*\.zip/i);
    const downloadPath = await download.path();
    expect(downloadPath).toBeTruthy();
    const bytes = await fs.readFile(String(downloadPath));
    expect(bytes.subarray(0, 2).toString('utf8')).toBe('PK');
    const bundle = parseDpdpExportZip(bytes);
    expect(Object.keys(bundle)).toHaveLength(8);
  });

  test('/profile Delete my data flow confirms erasure, clears localStorage tokens, and invalidates JWT', async ({
    createIsolatedPassenger,
  }) => {
    const passenger = await createIsolatedPassenger('f44-delete');
    const auth = await passenger.api.loginWithOtp(uniquePhone('f44-del'));
    await injectAuthSession(passenger.page, auth);
    await passenger.page.goto('/profile', { waitUntil: 'domcontentloaded' });

    const deleteBtn = passenger.page.getByRole('button', { name: /Delete my data|Delete account/i });
    await expect(deleteBtn).toBeVisible();
    await deleteBtn.click();

    const confirmBtn = passenger.page
      .getByRole('button', { name: /confirm delete|yes, delete|permanently delete|erase/i })
      .first();
    await expect(confirmBtn).toBeVisible();
    await Promise.all([
      passenger.page.waitForResponse(
        (res) => res.url().includes('/v1/me') && res.request().method() === 'DELETE',
      ),
      confirmBtn.click(),
    ]);

    await expect
      .poll(
        async () =>
          passenger.page.evaluate(() => window.localStorage.getItem('saath_access_token') ?? ''),
        { timeout: 10_000 },
      )
      .toBe('');

    const meAfter = await passenger.api.getMe(auth.access);
    passenger.api.assertProblemJson(meAfter, [401, 403, 404]);
  });
});
