import { test, expect } from '../../fixtures/multi-browser.js';
import {
  asArray,
  asRecord,
  createReportedMessage,
  getAdminToken,
  seedSwapDispute,
  signInAdminUi,
} from '../../helpers/admin-seed.js';
import { SaathApiClient } from '../../helpers/api.js';
import { E2E_ENV, futureDateIso } from '../../helpers/env.js';

test.describe('@tier1 F39 (Feature 9): Admin Portal UI (apps/admin)', () => {
  test(':3001/login signs in and / Overview displays Funnel, Match rate, and Provider/Outbox health', async ({
    page,
  }) => {
    const api = new SaathApiClient();
    await signInAdminUi(page, api);

    await page.goto(E2E_ENV.adminUrl, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
      'content',
      /noindex.*nofollow|nofollow.*noindex/i,
    );
    await expect(page.getByText(/Funnel|Match rate|Verified/i).first()).toBeVisible();
    await expect(page.getByText(/Provider|Outbox|Health/i).first()).toBeVisible();
  });

  test(':3001/moderation lists seeded report and executes dismiss action via UI button', async ({
    page,
  }) => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);
    const rep = await createReportedMessage(api, 'f39-mod-ui', {
      travelDate: futureDateIso(26),
      seatA: '1',
      seatB: '3',
      reason: 'f39_ui_moderation_reason',
    });

    await signInAdminUi(page, api);
    await page.goto(`${E2E_ENV.adminUrl}/moderation`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(/f39_ui_moderation_reason/i).first()).toBeVisible();

    const row = page
      .locator('tr, article, li, [data-report-id]')
      .filter({ hasText: /f39_ui_moderation_reason/i })
      .first();
    const dismissBtn = row.getByRole('button', { name: /dismiss/i }).first();
    await expect(dismissBtn).toBeVisible();

    await Promise.all([
      page.waitForResponse(
        (res) =>
          res.url().includes(`/v1/admin/moderation/${rep.reportId}/action`) &&
          res.request().method() === 'POST',
      ),
      dismissBtn.click(),
    ]);

    const dismissed = await api.getAdminModerationQueue(adminToken, { status: 'dismissed' });
    const items = asArray(dismissed.data.items, 'dismissed').map((i) => asRecord(i, 'i'));
    expect(items.some((i) => i.report_id === rep.reportId)).toBe(true);
  });

  test(':3001/flags toggles rewards_catalogue_enabled via UI, persists on reload, and restores', async ({
    page,
  }) => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);

    const flagsBefore = await api.getAdminFlags(adminToken);
    const origFlag = asArray(flagsBefore.data.items, 'flags')
      .map((f) => asRecord(f, 'f'))
      .find((f) => f.key === 'rewards_catalogue_enabled');
    const originalValue = Boolean(origFlag?.value);

    try {
      await signInAdminUi(page, api);
      await page.goto(`${E2E_ENV.adminUrl}/flags`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByText(/rewards_catalogue_enabled/i).first()).toBeVisible();

      const flagRow = page
        .locator('tr, article, li, div')
        .filter({ hasText: /rewards_catalogue_enabled/i })
        .first();
      const toggleControl = flagRow
        .getByRole('switch')
        .or(flagRow.getByRole('checkbox'))
        .or(flagRow.getByRole('button', { name: /toggle|enable|disable|save/i }))
        .first();
      await expect(toggleControl).toBeVisible();

      await Promise.all([
        page.waitForResponse(
          (res) =>
            res.url().includes('/v1/admin/flags/rewards_catalogue_enabled') &&
            res.request().method() === 'PATCH',
        ),
        toggleControl.click(),
      ]);

      await page.reload({ waitUntil: 'domcontentloaded' });
      const flagsAfter = await api.getAdminFlags(adminToken);
      const updated = asArray(flagsAfter.data.items, 'flags')
        .map((f) => asRecord(f, 'f'))
        .find((f) => f.key === 'rewards_catalogue_enabled');
      expect(Boolean(updated?.value)).toBe(!originalValue);
    } finally {
      await api.patchAdminFlag(
        adminToken,
        'rewards_catalogue_enabled',
        originalValue,
        'Restore after F39 UI test',
      );
    }
  });

  test(':3001/fraud renders collusion graph & disputes and overrides a seeded swap dispute', async ({
    page,
  }) => {
    const api = new SaathApiClient();
    const seeded = await seedSwapDispute(api, 'f39-fraud-ui', {
      travelDate: futureDateIso(26),
      seatA: '4',
      seatB: '6',
    });

    await signInAdminUi(page, api);
    await page.goto(`${E2E_ENV.adminUrl}/fraud`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(/Fraud|Graph|Collusion/i).first()).toBeVisible();
    await expect(page.getByText(/Dispute|Redemption|Override/i).first()).toBeVisible();

    const disputeRow = page
      .locator('tr, article, li, [data-dispute-id]')
      .filter({ hasText: new RegExp(seeded.swapId.slice(0, 8), 'i') })
      .or(page.locator('tr, article, li').filter({ hasText: /swap_dispute|not_completed/i }))
      .first();
    const completeBtn = disputeRow.getByRole('button', { name: /complete/i }).first();
    await expect(completeBtn).toBeVisible();

    await Promise.all([
      page.waitForResponse(
        (res) =>
          res.url().includes('/v1/admin/disputes/') &&
          res.url().includes('/override') &&
          res.request().method() === 'POST',
      ),
      completeBtn.click(),
    ]);

    const swapAfter = await api.getSwap(seeded.authA.access, seeded.swapId);
    expect(swapAfter.status).toBe(200);
    expect(swapAfter.data.status).toBe('completed');
  });

  test(':3001/audit displays audit entries and supports action filtering', async ({ page }) => {
    const api = new SaathApiClient();
    await signInAdminUi(page, api);

    await page.goto(`${E2E_ENV.adminUrl}/audit`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(/Audit/i).first()).toBeVisible();
    await expect(page.getByText(/admin\.session_created/i).first()).toBeVisible();

    const actionInput = page
      .getByLabel(/action/i)
      .or(page.getByPlaceholder(/action/i))
      .first();
    await expect(actionInput).toBeVisible();
    await actionInput.fill('admin.session_created');
    await expect(page.getByText(/admin\.session_created/i).first()).toBeVisible();
  });
});
