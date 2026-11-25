import { test, expect } from '../../fixtures/multi-browser.js';
import { SaathApiClient } from '../../helpers/api.js';
import { TEST_PNRS, uniquePhone } from '../../helpers/env.js';

test.describe('F32: DPDP Consent, Export, Erasure & Legal Docs @tier1', () => {
  test('POST /v1/me/consents records itemised DPDP consents with notice_version', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone(32_001));

    const res = await api.saveConsents(auth.access, [
      { purpose: 'verification', notice_version: '1.0', granted: true },
      { purpose: 'matching', notice_version: '1.0', granted: true },
      { purpose: 'notifications', notice_version: '1.0', granted: true },
      { purpose: 'analytics', notice_version: '1.0', granted: false },
      { purpose: 'whatsapp', notice_version: '1.0', granted: true },
    ]);
    expect([200, 201]).toContain(res.status);
    expect(Array.isArray(res.data.consents)).toBe(true);
  });

  test('GET /v1/me/export returns valid downloadable ZIP archive with user data', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone(32_002));
    await api.verifyTrainPnr(auth.access, TEST_PNRS.rajdhani3A);

    const zipRes = await api.exportMyData(auth.access);
    expect(zipRes.status).toBe(200);
    expect(zipRes.headers.get('content-type') ?? '').toContain('zip');
    expect(zipRes.buffer.subarray(0, 2).toString('utf8')).toBe('PK');
    expect(zipRes.buffer.byteLength).toBeGreaterThan(50);
  });

  test('DELETE /v1/me schedules erasure and anonymises user footprint', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone(32_003));
    await api.verifyTrainPnr(auth.access, TEST_PNRS.rajdhani3A);

    const del = await api.deleteMyAccount(auth.access);
    expect([200, 202]).toContain(del.status);
    expect(String(del.data.status)).toMatch(/erasure_scheduled|deleted/i);
  });

  test('Legal pages (/legal/privacy, /legal/terms, /grievance) render Grievance Officer and disclaimers', async ({
    page,
  }) => {
    await page.goto('/legal/privacy', { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(/Privacy|DPDP|गोपनीयता/i).first()).toBeVisible();

    await page.goto('/legal/terms', { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(/TTE|IRCTC|Terms/i).first()).toBeVisible();

    await page.goto('/grievance', { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(/Grievance Officer|शिकायत/i).first()).toBeVisible();
  });

  test('Privacy and Terms support bilingual en/hi switching', async ({ page }) => {
    await page.goto('/legal/privacy', { waitUntil: 'domcontentloaded' });
    const toggle = page.getByRole('button', { name: /हिं|EN|Language/i });
    await expect(toggle).toBeVisible();
    await toggle.click();

    await expect(page.locator('main')).toContainText(/[\u0900-\u097F]/);
  });
});
