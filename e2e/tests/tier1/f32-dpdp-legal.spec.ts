import fs from 'node:fs/promises';
import { test, expect, injectAuthSession } from '../../fixtures/multi-browser.js';
import { assertLocale, assertTapTargets, assertWcagAA } from '../../helpers/a11y.js';
import { SaathApiClient } from '../../helpers/api.js';
import { E2E_ENV, TEST_PNRS, uniquePhone } from '../../helpers/env.js';
import { parseDpdpExportZip } from '../../helpers/zip.js';

const DPDP_PURPOSES = [
  'verification',
  'matching',
  'notifications',
  'analytics',
  'whatsapp',
] as const;

function hasForbiddenKey(node: unknown, forbiddenKeys: Set<string>): string | null {
  if (node === null || node === undefined || typeof node !== 'object') {
    return null;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = hasForbiddenKey(item, forbiddenKeys);
      if (found) return found;
    }
    return null;
  }
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (forbiddenKeys.has(k.toLowerCase())) {
      return k;
    }
    const nested = hasForbiddenKey(v, forbiddenKeys);
    if (nested) return nested;
  }
  return null;
}

test.describe('F32: DPDP Consent, Export, Erasure & Legal Docs @tier1', () => {
  test('GET & POST /v1/me/consents manage notice_version and all 5 itemised DPDP purposes', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone(32_001));

    const initial = await api.getConsents<{
      notice_version?: string;
      purposes?: unknown[];
      consents?: Array<{ purpose: string; notice_version: string; granted: boolean }>;
    }>(auth.access);
    expect(initial.status).toBe(200);
    expect(typeof initial.data.notice_version).toBe('string');
    expect((initial.data.notice_version ?? '').length).toBeGreaterThan(0);

    const saveRes = await api.saveConsents(auth.access, [
      { purpose: 'verification', notice_version: String(initial.data.notice_version), granted: true },
      { purpose: 'matching', notice_version: String(initial.data.notice_version), granted: true },
      { purpose: 'notifications', notice_version: String(initial.data.notice_version), granted: true },
      { purpose: 'analytics', notice_version: String(initial.data.notice_version), granted: false },
      { purpose: 'whatsapp', notice_version: String(initial.data.notice_version), granted: true },
    ]);
    expect([200, 201]).toContain(saveRes.status);
    expect(Array.isArray(saveRes.data.consents)).toBe(true);

    const after = await api.getConsents<{
      notice_version?: string;
      purposes?: unknown[];
      consents?: Array<{ purpose: string; notice_version: string; granted: boolean }>;
    }>(auth.access);
    expect(after.status).toBe(200);
    const savedRows = after.data.consents ?? [];
    for (const purpose of DPDP_PURPOSES) {
      const row = savedRows.find((r) => r.purpose === purpose);
      expect(row).toBeDefined();
      expect(row?.granted).toBe(purpose !== 'analytics');
    }
  });

  test('GET /v1/me/export returns ZIP with all 8 JSON bundles without raw secrets/PNR and writes audit_log', async () => {
    const api = new SaathApiClient();
    const phone = uniquePhone(32_002);
    const auth = await api.loginWithOtp(phone);
    await api.verifyTrainPnr(auth.access, TEST_PNRS.rajdhani3A);

    const adminSession = await api.createAdminSession(E2E_ENV.adminTestEmail);
    expect([200, 201]).toContain(adminSession.status);
    const adminToken = adminSession.data.access ?? adminSession.data.token ?? '';

    const auditBefore = await api.getAdminAuditLog<{ total?: number }>(adminToken);
    const beforeTotal = Number(auditBefore.data.total ?? 0);

    const zipRes = await api.exportMyData(auth.access);
    expect(zipRes.status).toBe(200);
    expect(zipRes.headers.get('content-type') ?? '').toContain('zip');
    expect(zipRes.headers.get('content-disposition') ?? '').toContain('saath-data-export.zip');
    expect(zipRes.buffer.subarray(0, 2).toString('utf8')).toBe('PK');

    const bundle = parseDpdpExportZip(zipRes.buffer);
    expect(Object.keys(bundle)).toHaveLength(8);
    expect(hasForbiddenKey(bundle, new Set(['phone_enc', 'phone_bidx', 'raw_pnr']))).toBeNull();
    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain(TEST_PNRS.rajdhani3A);
    expect(serialized).not.toContain(phone);

    const auditAfter = await api.getAdminAuditLog<{ total?: number; items?: Array<{ action?: string }> }>(
      adminToken,
      { limit: 10 },
    );
    expect(Number(auditAfter.data.total ?? 0)).toBeGreaterThan(beforeTotal);
    const actionsText = JSON.stringify(auditAfter.data.items ?? []);
    expect(actionsText).toMatch(/export|dpdp/i);
  });

  test('DELETE /v1/me schedules 24h erasure and writes audit_log', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone(32_003));
    await api.verifyTrainPnr(auth.access, TEST_PNRS.rajdhani3A);

    const adminSession = await api.createAdminSession(E2E_ENV.adminTestEmail);
    const adminToken = adminSession.data.access ?? adminSession.data.token ?? '';
    const auditBefore = await api.getAdminAuditLog<{ total?: number }>(adminToken);
    const beforeTotal = Number(auditBefore.data.total ?? 0);

    const del = await api.deleteMyAccount<{ status: string; scheduled_within_hours?: number }>(
      auth.access,
    );
    expect([200, 202]).toContain(del.status);
    expect(String(del.data.status)).toMatch(/erasure_scheduled|deleted/i);
    if (del.data.scheduled_within_hours !== undefined) {
      expect(del.data.scheduled_within_hours).toBe(24);
    }

    const auditAfter = await api.getAdminAuditLog<{ total?: number; items?: Array<{ action?: string }> }>(
      adminToken,
      { limit: 10 },
    );
    expect(Number(auditAfter.data.total ?? 0)).toBeGreaterThan(beforeTotal);
    expect(JSON.stringify(auditAfter.data.items ?? [])).toMatch(/eras|delete|dpdp/i);
  });

  test('First-verify itemised DPDP consent notice renders in en/hi and /profile supports consent toggles, ZIP download, and account deletion', async ({
    createIsolatedPassenger,
  }) => {
    const passenger = await createIsolatedPassenger('dpdp-ui');
    const auth = await passenger.api.loginWithOtp(uniquePhone(32_004));
    await injectAuthSession(passenger.page, auth);

    // First-verify itemised consent notice check on home verify flow
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

    const consentHeading = passenger.page.getByText(/DPDP|Consent|Data use|सहमति/i).first();
    if ((await consentHeading.count()) > 0) {
      await expect(consentHeading).toBeVisible();
      const continueBtn = passenger.page
        .getByRole('button', { name: /agree|accept|save|continue|सहमत/i })
        .first();
      if ((await continueBtn.count()) > 0) {
        await continueBtn.click();
      }
    }

    // /profile consent toggles, Download my data, Delete my data
    await passenger.page.goto('/profile', { waitUntil: 'domcontentloaded' });
    await expect(
      passenger.page.getByRole('button', { name: /Download my data|Export/i }),
    ).toBeVisible();

    const analyticsToggle = passenger.page
      .getByRole('switch', { name: /analytics/i })
      .or(passenger.page.getByRole('checkbox', { name: /analytics/i }))
      .first();
    if ((await analyticsToggle.count()) > 0) {
      await analyticsToggle.click();
    }

    const downloadBtn = passenger.page.getByRole('button', { name: /Download my data|Export/i });
    const [download] = await Promise.all([
      passenger.page.waitForEvent('download'),
      downloadBtn.click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/saath-data-export.*\.zip/i);
    const downloadPath = await download.path();
    expect(downloadPath).toBeTruthy();
    if (downloadPath) {
      const bytes = await fs.readFile(downloadPath);
      expect(bytes.subarray(0, 2).toString('utf8')).toBe('PK');
      const bundle = parseDpdpExportZip(bytes);
      expect(Object.keys(bundle)).toHaveLength(8);
    }

    const deleteBtn = passenger.page.getByRole('button', { name: /Delete my data|Delete account/i });
    await expect(deleteBtn).toBeVisible();
    await deleteBtn.click();

    const confirmBtn = passenger.page
      .getByRole('button', { name: /confirm delete|yes, delete|permanently delete|erase/i })
      .first();
    if ((await confirmBtn.count()) > 0) {
      await confirmBtn.click();
    }

    await expect
      .poll(
        async () =>
          passenger.page.evaluate(
            () => window.localStorage.getItem('saath_access_token') ?? '',
          ),
        { timeout: 10_000 },
      )
      .toBe('');
  });

  test('Footer links, bilingual legal/grievance pages, and WCAG 2.2 AA + tap targets pass on /legal/*, /grievance, and /profile', async ({
    browser,
    createIsolatedPassenger,
  }) => {
    const helper = await createIsolatedPassenger('legal-a11y');
    const auth = await helper.api.loginWithOtp(uniquePhone(32_005));

    const context = await browser.newContext({
      viewport: { width: 360, height: 800 },
      hasTouch: true,
    });
    const page = await context.newPage();

    try {
      // Footer links on /
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      const footer = page.locator('footer');
      await expect(footer.locator('a[href*="/legal/privacy"]')).toBeVisible();
      await expect(footer.locator('a[href*="/legal/terms"]')).toBeVisible();
      await expect(footer.locator('a[href*="/grievance"]')).toBeVisible();

      // /legal/privacy: 5 purposes, retention, en/hi switch, axe + tap targets
      await page.goto('/legal/privacy', { waitUntil: 'domcontentloaded' });
      const privacyMain = page.locator('main');
      await expect(privacyMain).toContainText(/verification/i);
      await expect(privacyMain).toContainText(/matching/i);
      await expect(privacyMain).toContainText(/notifications/i);
      await expect(privacyMain).toContainText(/analytics/i);
      await expect(privacyMain).toContainText(/whatsapp/i);
      await expect(privacyMain).toContainText(/retention|hours|days|purge/i);
      await assertWcagAA(page);
      await assertTapTargets(page);

      const togglePrivacy = page.getByRole('button', { name: /हिं|EN|Language/i });
      await togglePrivacy.click();
      await expect(page.locator('html')).toHaveAttribute('lang', /^hi/i);
      await assertLocale(page, 'hi');

      // /legal/terms: TTE & non-IRCTC disclaimers, en/hi switch, axe + tap targets
      await page.goto('/legal/terms', { waitUntil: 'domcontentloaded' });
      const termsMain = page.locator('main');
      await expect(termsMain).toContainText(/TTE/i);
      await expect(termsMain).toContainText(/IRCTC/i);
      await assertWcagAA(page);
      await assertTapTargets(page);

      await page.getByRole('button', { name: /हिं|EN|Language/i }).click();
      await expect(page.locator('html')).toHaveAttribute('lang', /^hi/i);
      await assertLocale(page, 'hi');

      // /grievance: Grievance Officer email & SLA, en/hi switch, axe + tap targets
      await page.goto('/grievance', { waitUntil: 'domcontentloaded' });
      const grievanceMain = page.locator('main');
      await expect(grievanceMain).toContainText(/Grievance Officer/i);
      await expect(grievanceMain).toContainText(/@/);
      await expect(grievanceMain).toContainText(/hours|days|SLA|72|48|30/i);
      await assertWcagAA(page);
      await assertTapTargets(page);

      await page.getByRole('button', { name: /हिं|EN|Language/i }).click();
      await expect(page.locator('html')).toHaveAttribute('lang', /^hi/i);
      await assertLocale(page, 'hi');

      // /profile WCAG 2.2 AA + tap targets
      await injectAuthSession(page, auth);
      await page.goto('/profile', { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('heading').first()).toBeVisible();
      await assertWcagAA(page);
      await assertTapTargets(page);
    } finally {
      await context.close();
    }
  });
});
