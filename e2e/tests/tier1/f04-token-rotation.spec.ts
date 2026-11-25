import { test, expect } from '@playwright/test';
import { SaathApiClient } from '../../helpers/api.js';
import { uniquePhone } from '../../helpers/env.js';

test.describe('@tier1 F04: Token Rotation & Reuse Detection', () => {
  test('POST /v1/auth/refresh rotates both access and refresh tokens', async () => {
    const api = new SaathApiClient();
    const initial = await api.loginWithOtp(uniquePhone('f04-rotate'), 'whatsapp');

    const refreshed = await api.refreshTokens(initial.refresh);
    expect(refreshed.status).toBe(200);
    expect(typeof refreshed.data.access).toBe('string');
    expect(typeof refreshed.data.refresh).toBe('string');
    expect(refreshed.data.refresh).not.toBe(initial.refresh);
  });

  test('Newly rotated access token authorizes GET /v1/me', async () => {
    const api = new SaathApiClient();
    const initial = await api.loginWithOtp(uniquePhone('f04-use-new'), 'whatsapp');
    const refreshed = await api.refreshTokens(initial.refresh);
    expect(refreshed.status).toBe(200);

    const meRes = await api.getMe(refreshed.data.access);
    expect(meRes.status).toBe(200);
    expect(meRes.data.id).toBe(initial.user.id);
  });

  test('Old refresh token cannot be used again after rotation', async () => {
    const api = new SaathApiClient();
    const initial = await api.loginWithOtp(uniquePhone('f04-old-invalid'), 'whatsapp');
    const refreshed = await api.refreshTokens(initial.refresh);
    expect(refreshed.status).toBe(200);

    const reuseRes = await api.refreshTokens(initial.refresh);
    api.assertProblemJson(reuseRes, 401);
    expect(reuseRes.status).toBe(401);
  });

  test('POST /v1/auth/logout revokes the current refresh session', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone('f04-logout'), 'sms');

    const logoutRes = await api.logout(auth.access);
    expect([200, 204]).toContain(logoutRes.status);

    const afterLogoutRefresh = await api.refreshTokens(auth.refresh);
    api.assertProblemJson(afterLogoutRefresh, 401);
    expect(afterLogoutRefresh.status).toBe(401);
  });

  test('Multiple device sessions for same user rotate independently until individual logout', async () => {
    const api = new SaathApiClient();
    const phone = uniquePhone('f04-multi-device');
    const device1 = await api.loginWithOtp(phone, 'whatsapp');
    const device2 = await api.loginWithOtp(phone, 'whatsapp');

    const logout1 = await api.logout(device1.access);
    expect([200, 204]).toContain(logout1.status);

    const refresh2 = await api.refreshTokens(device2.refresh);
    expect(refresh2.status).toBe(200);
    const me2 = await api.getMe(refresh2.data.access);
    expect(me2.status).toBe(200);
    expect(me2.data.id).toBe(device2.user.id);
  });
});
