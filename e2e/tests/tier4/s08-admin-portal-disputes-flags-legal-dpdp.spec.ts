import fs from 'node:fs/promises';
import { test, expect, injectAuthSession } from '../../fixtures/multi-browser.js';
import { assertLocale, assertTapTargets, assertWcagAA } from '../../helpers/a11y.js';
import {
  asArray,
  asRecord,
  getAdminToken,
  seedSwapDispute,
  signInAdminUi,
} from '../../helpers/admin-seed.js';
import { SaathApiClient } from '../../helpers/api.js';
import { E2E_ENV, futureDateIso, TEST_PNRS, uniquePhone } from '../../helpers/env.js';
import { parseDpdpExportZip } from '../../helpers/zip.js';

test.describe('@tier4 S08: Admin Ops Portal Full E2E + WCAG 2.2 AA & Web DPDP/Legal/Grievance', () => {
  test('Operator completes /login -> / funnel+health -> /flags -> /fraud dispute override -> /audit + WCAG AA & Web DPDP/Legal en/hi flow', async ({
    browser,
    createIsolatedPassenger,
  }) => {
    const api = new SaathApiClient();
    const seededDispute = await seedSwapDispute(api, 's08-dispute', {
      travelDate: futureDateIso(41),
      seatA: '1',
      seatB: '3',
    });

    const adminCtx = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const adminPage = await adminCtx.newPage();

    const adminToken = await getAdminToken(api);
    const flagsBefore = await api.getAdminFlags(adminToken);
    const origRewardsFlag = Boolean(
      asArray(flagsBefore.data.items, 'flags')
        .map((f) => asRecord(f, 'f'))
        .find((f) => f.key === 'rewards_catalogue_enabled')?.value,
    );

    try {
      await signInAdminUi(adminPage, api);

      // 1. Admin Dashboard (/) funnel + provider health + WCAG 2.2 AA & tap targets
      await adminPage.goto(E2E_ENV.adminUrl, { waitUntil: 'domcontentloaded' });
      await expect(adminPage.getByText(/Funnel|Match rate|Verified/i).first()).toBeVisible();
      await expect(adminPage.getByText(/Provider|Outbox|Health/i).first()).toBeVisible();
      await assertWcagAA(adminPage);
      await assertTapTargets(adminPage);

      // 2. /flags toggle + restore + WCAG 2.2 AA & tap targets
      await adminPage.goto(`${E2E_ENV.adminUrl}/flags`, { waitUntil: 'domcontentloaded' });
      await expect(adminPage.getByText(/rewards_catalogue_enabled/i).first()).toBeVisible();
      await assertWcagAA(adminPage);
      await assertTapTargets(adminPage);

      const flagRow = adminPage
        .locator('tr, article, li, div')
        .filter({ hasText: /rewards_catalogue_enabled/i })
        .first();
      const flagToggle = flagRow
        .getByRole('switch')
        .or(flagRow.getByRole('checkbox'))
        .or(flagRow.getByRole('button', { name: /toggle|enable|disable|save/i }))
        .first();
      await expect(flagToggle).toBeVisible();
      await Promise.all([
        adminPage.waitForResponse(
          (res) =>
            res.url().includes('/v1/admin/flags/rewards_catalogue_enabled') &&
            res.request().method() === 'PATCH',
        ),
        flagToggle.click(),
      ]);

      // 3. /moderation WCAG 2.2 AA & tap targets
      await adminPage.goto(`${E2E_ENV.adminUrl}/moderation`, { waitUntil: 'domcontentloaded' });
      await expect(adminPage.getByText(/Moderation|Queue/i).first()).toBeVisible();
      await assertWcagAA(adminPage);
      await assertTapTargets(adminPage);

      // 4. /fraud collusion graph + dispute override UI + WCAG 2.2 AA & tap targets
      await adminPage.goto(`${E2E_ENV.adminUrl}/fraud`, { waitUntil: 'domcontentloaded' });
      await expect(adminPage.getByText(/Fraud|Graph|Collusion/i).first()).toBeVisible();
      await expect(adminPage.getByText(/Dispute|Redemption|Override/i).first()).toBeVisible();
      await assertWcagAA(adminPage);
      await assertTapTargets(adminPage);

      const disputeRow = adminPage
        .locator('tr, article, li, [data-dispute-id]')
        .filter({ hasText: new RegExp(seededDispute.swapId.slice(0, 8), 'i') })
        .or(adminPage.locator('tr, article, li').filter({ hasText: /swap_dispute|not_completed/i }))
        .first();
      const completeBtn = disputeRow.getByRole('button', { name: /complete/i }).first();
      await expect(completeBtn).toBeVisible();
      await Promise.all([
        adminPage.waitForResponse(
          (res) =>
            res.url().includes('/v1/admin/disputes/') &&
            res.url().includes('/override') &&
            res.request().method() === 'POST',
        ),
        completeBtn.click(),
      ]);

      // 5. /audit filter + WCAG 2.2 AA & tap targets
      await adminPage.goto(`${E2E_ENV.adminUrl}/audit`, { waitUntil: 'domcontentloaded' });
      await expect(adminPage.getByText(/Audit/i).first()).toBeVisible();
      await expect(adminPage.getByText(/admin\.dispute_override|admin\.flag_updated/i).first()).toBeVisible();
      await assertWcagAA(adminPage);
      await assertTapTargets(adminPage);
    } finally {
      await api.patchAdminFlag(
        adminToken,
        'rewards_catalogue_enabled',
        origRewardsFlag,
        'Restore after S08',
      );
      await adminCtx.close();
    }

    // 6. Web DPDP first-verify consent + bilingual Legal/Grievance + /profile export/delete
    const passenger = await createIsolatedPassenger('s08-web-dpdp');
    const auth = await passenger.api.loginWithOtp(uniquePhone('s08-pax'));

    for (const legalRoute of ['/legal/privacy', '/legal/terms', '/grievance']) {
      await passenger.page.goto(legalRoute, { waitUntil: 'domcontentloaded' });
      await assertLocale(passenger.page, 'en');
      await assertWcagAA(passenger.page);
      await assertTapTargets(passenger.page);

      await passenger.page.getByRole('button', { name: /हिं|EN|Language/i }).click();
      await assertLocale(passenger.page, 'hi');
      await assertWcagAA(passenger.page);
      await assertTapTargets(passenger.page);
    }

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
    const [download] = await Promise.all([
      passenger.page.waitForEvent('download'),
      passenger.page.getByRole('button', { name: /Download my data|Export/i }).click(),
    ]);
    const zipBytes = await fs.readFile(String(await download.path()));
    expect(Object.keys(parseDpdpExportZip(zipBytes))).toHaveLength(8);

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
  });
});
