import { test, expect } from '../../fixtures/multi-browser.js';
import { getAdminToken } from '../../helpers/admin-seed.js';
import { SaathApiClient } from '../../helpers/api.js';
import { uniquePhone } from '../../helpers/env.js';

const DPDP_PURPOSES = [
  'verification',
  'matching',
  'notifications',
  'analytics',
  'whatsapp',
] as const;

test.describe('@tier1 F40 (Feature 10): Itemised Consent Notice & Ledger API', () => {
  test('Fresh user GET /v1/me/consents returns notice_version and all 5 DPDP purposes', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone('f40-init'));

    const res = await api.getConsents<{
      notice_version: string;
      purposes: Array<string | { purpose: string }>;
      consents: Array<{ purpose: string; notice_version: string; granted: boolean; at?: string }>;
    }>(auth.access);
    expect(res.status).toBe(200);
    expect(typeof res.data.notice_version).toBe('string');
    expect(res.data.notice_version.length).toBeGreaterThan(0);
    expect(Array.isArray(res.data.purposes)).toBe(true);
    expect(res.data.purposes.length).toBeGreaterThanOrEqual(5);

    const purposeNames = res.data.purposes.map((p) =>
      typeof p === 'string' ? p : p.purpose,
    );
    for (const expected of DPDP_PURPOSES) {
      expect(purposeNames).toContain(expected);
    }
  });

  test('POST /v1/me/consents records all 5 purposes with granted booleans and timestamps', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone('f40-all5'));
    const initial = await api.getConsents<{ notice_version: string }>(auth.access);
    const noticeVersion = initial.data.notice_version;

    const save = await api.saveConsents<{
      consents: Array<{ purpose: string; notice_version: string; granted: boolean; at?: string }>;
    }>(
      auth.access,
      DPDP_PURPOSES.map((purpose) => ({
        purpose,
        notice_version: noticeVersion,
        granted: purpose !== 'analytics',
      })),
    );
    expect([200, 201]).toContain(save.status);
    expect(save.data.consents.length).toBeGreaterThanOrEqual(5);

    for (const purpose of DPDP_PURPOSES) {
      const row = save.data.consents.find((c) => c.purpose === purpose);
      expect(row).toBeDefined();
      expect(row?.granted).toBe(purpose !== 'analytics');
      expect(row?.notice_version).toBe(noticeVersion);
      expect(typeof row?.at).toBe('string');
    }
  });

  test('Partial POST /v1/me/consents updates targeted purpose while preserving others', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone('f40-partial'));
    const initial = await api.getConsents<{ notice_version: string }>(auth.access);
    const v = initial.data.notice_version;

    await api.saveConsents(
      auth.access,
      DPDP_PURPOSES.map((purpose) => ({ purpose, notice_version: v, granted: true })),
    );

    const updateAnalytics = await api.saveConsents(auth.access, [
      { purpose: 'analytics', notice_version: v, granted: false },
    ]);
    expect([200, 201]).toContain(updateAnalytics.status);

    const after = await api.getConsents<{
      consents: Array<{ purpose: string; granted: boolean }>;
    }>(auth.access);
    expect(after.status).toBe(200);
    expect(after.data.consents.find((c) => c.purpose === 'analytics')?.granted).toBe(false);
    expect(after.data.consents.find((c) => c.purpose === 'verification')?.granted).toBe(true);
    expect(after.data.consents.find((c) => c.purpose === 'matching')?.granted).toBe(true);
  });

  test('Recorded consents persist across fresh OTP re-login', async () => {
    const api = new SaathApiClient();
    const phone = uniquePhone('f40-relogin');
    const auth1 = await api.loginWithOtp(phone);
    const initial = await api.getConsents<{ notice_version: string }>(auth1.access);

    await api.saveConsents(auth1.access, [
      { purpose: 'verification', notice_version: initial.data.notice_version, granted: true },
      { purpose: 'whatsapp', notice_version: initial.data.notice_version, granted: false },
    ]);

    const auth2 = await api.loginWithOtp(phone);
    const reloaded = await api.getConsents<{
      consents: Array<{ purpose: string; granted: boolean }>;
    }>(auth2.access);
    expect(reloaded.status).toBe(200);
    expect(reloaded.data.consents.find((c) => c.purpose === 'verification')?.granted).toBe(true);
    expect(reloaded.data.consents.find((c) => c.purpose === 'whatsapp')?.granted).toBe(false);
  });

  test('Saving consents writes a DPDP consent entry to audit_log', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);
    const auth = await api.loginWithOtp(uniquePhone('f40-audit'));
    const initial = await api.getConsents<{ notice_version: string }>(auth.access);

    const before = await api.getAdminAuditLog<{ total: number }>(adminToken);
    await api.saveConsents(auth.access, [
      { purpose: 'verification', notice_version: initial.data.notice_version, granted: true },
    ]);

    const after = await api.getAdminAuditLog<{
      total: number;
      items: Array<Record<string, unknown>>;
    }>(adminToken, { limit: 10 });
    expect(after.data.total).toBeGreaterThan(before.data.total);
    expect(JSON.stringify(after.data.items)).toMatch(/consent|dpdp/i);
  });
});
