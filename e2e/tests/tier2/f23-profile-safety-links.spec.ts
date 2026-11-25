import { test, expect, injectAuthSession } from '../../fixtures/multi-browser.js';
import { SaathApiClient } from '../../helpers/api.js';
import { uniquePhone } from '../../helpers/env.js';

test.describe('F23 Tier 2: Profile Validation, Gender Guard & Offline Safety @tier2', () => {
  test('Unauthenticated GET/PATCH /v1/me return 401 RFC 9457', async () => {
    const api = new SaathApiClient();
    const g = await api.request('GET', '/v1/me');
    api.assertProblemJson(g, 401);

    const p = await api.request('PATCH', '/v1/me', { body: { locale: 'hi' } });
    api.assertProblemJson(p, 401);
  });

  test('Invalid locale code rejected with 422 RFC 9457', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone(232_001));
    const res = await api.patchMe(auth.access, { locale: 'xx_INVALID' });
    api.assertProblemJson(res, 422);
  });

  test('XSS/HTML or oversized display_alias is rejected (422) or stripped cleanly', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone(232_002));
    const res = await api.patchMe(auth.access, {
      display_alias: '<script>alert(1)</script>'.repeat(5),
    });
    expect([200, 422]).toContain(res.status);
    const aliasText = res.status === 200 ? String(res.data.display_alias ?? '') : '';
    expect(aliasText).not.toContain('<script>');
  });

  test('Male user setting women_only_default=true is rejected per gender guard (403/422)', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone(232_003));
    await api.patchMe(auth.access, { gender_self: 'male' });

    const res = await api.patchMe(auth.access, { women_only_default: true });
    api.assertProblemJson(res, [403, 422]);
  });

  test('Emergency links 139 and 182 remain rendered and accessible offline', async ({
    createIsolatedPassenger,
  }) => {
    const passenger = await createIsolatedPassenger('offline-safety');
    const auth = await passenger.api.loginWithOtp(uniquePhone(232_004));
    await injectAuthSession(passenger.page, auth);
    await passenger.page.goto('/profile', { waitUntil: 'domcontentloaded' });

    await passenger.context.setOffline(true);
    await expect(passenger.page.locator('a[href="tel:139"]')).toBeVisible();
    await expect(passenger.page.locator('a[href="tel:182"]')).toBeVisible();
    await passenger.context.setOffline(false);
  });
});
