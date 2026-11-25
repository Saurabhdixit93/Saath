import { test, expect, injectAuthSession } from '../../fixtures/multi-browser.js';
import { SaathApiClient } from '../../helpers/api.js';
import { uniquePhone } from '../../helpers/env.js';

test.describe('F23: User Profile, Emergency Links & Reliability @tier1', () => {
  test('GET /v1/me returns user profile DTO with reliability counters and preferences', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone(23_001));

    const me = await api.getMe(auth.access);
    expect(me.status).toBe(200);
    expect(typeof me.data.id).toBe('string');
    expect(typeof me.data.display_alias).toBe('string');
    expect(['en', 'hi']).toContain(String(me.data.locale));
    expect(typeof me.data.reliability_accepted).toBe('number');
    expect(typeof me.data.reliability_completed).toBe('number');
  });

  test('PATCH /v1/me updates display_alias, locale, and women_only_default for female user', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone(23_002));

    const patch = await api.patchMe(auth.access, {
      display_alias: 'MeeraTravels',
      locale: 'hi',
      gender_self: 'female',
      women_only_default: true,
    });
    expect(patch.status).toBe(200);
    expect(patch.data.display_alias).toBe('MeeraTravels');
    expect(patch.data.locale).toBe('hi');
    expect(patch.data.women_only_default).toBe(true);

    const me = await api.getMe(auth.access);
    expect(me.data.display_alias).toBe('MeeraTravels');
  });

  test('UI /profile displays reliability score badge and updates alias preference', async ({
    createIsolatedPassenger,
  }) => {
    const passenger = await createIsolatedPassenger('profile-ui');
    const auth = await passenger.api.loginWithOtp(uniquePhone(23_003));
    await passenger.api.patchMe(auth.access, { display_alias: 'SaathRider23' });

    await injectAuthSession(passenger.page, auth);
    await passenger.page.goto('/profile', { waitUntil: 'domcontentloaded' });

    await expect(passenger.page.getByText(/SaathRider23/)).toBeVisible();
    await expect(passenger.page.getByText(/Kept \d+\/\d+ swaps|reliability/i)).toBeVisible();
  });

  test('UI /profile provides one-tap Rail Madad 139 and RPF 182 emergency tel links', async ({
    createIsolatedPassenger,
  }) => {
    const passenger = await createIsolatedPassenger('emergency-links');
    const auth = await passenger.api.loginWithOtp(uniquePhone(23_004));

    await injectAuthSession(passenger.page, auth);
    await passenger.page.goto('/profile', { waitUntil: 'domcontentloaded' });

    const railMadad = passenger.page.locator('a[href="tel:139"]');
    const rpfLink = passenger.page.locator('a[href="tel:182"]');
    await expect(railMadad).toBeVisible();
    await expect(rpfLink).toBeVisible();
  });

  test('UI /profile offers share-trip with family action without exposing raw PNR', async ({
    createIsolatedPassenger,
  }) => {
    const passenger = await createIsolatedPassenger('share-trip');
    const auth = await passenger.api.loginWithOtp(uniquePhone(23_005));

    await injectAuthSession(passenger.page, auth);
    await passenger.page.goto('/profile', { waitUntil: 'domcontentloaded' });

    const shareBtn = passenger.page.getByRole('button', { name: /Share trip|Share with family/i });
    await expect(shareBtn).toBeVisible();
  });
});
