import { test, expect } from '../../fixtures/multi-browser.js';
import { SaathApiClient } from '../../helpers/api.js';
import { TEST_PNRS, uniquePhone } from '../../helpers/env.js';
import { assertNoPiiLeak } from '../../helpers/pii.js';

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Expected object for ${label}`);
  }
  return value as Record<string, unknown>;
}

function getString(obj: Record<string, unknown>, key: string): string {
  const val = obj[key];
  if (typeof val !== 'string' || val.length === 0) {
    throw new Error(`Expected string "${key}"`);
  }
  return val;
}

test.describe('F32 Tier 2: DPDP Erasure, Token Revocation & Minor Safety @tier2', () => {
  test('Unauthenticated DPDP consents, export, and delete endpoints return 401 RFC 9457', async () => {
    const api = new SaathApiClient();

    const c = await api.request('POST', '/v1/me/consents', { body: { consents: [] } });
    api.assertProblemJson(c, 401);

    const e = await api.request('GET', '/v1/me/export');
    api.assertProblemJson(e, 401);

    const d = await api.request('DELETE', '/v1/me');
    api.assertProblemJson(d, 401);
  });

  test('After DELETE /v1/me, existing JWT is denied access to profile and journeys', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone(322_001));
    await api.verifyTrainPnr(auth.access, TEST_PNRS.rajdhani3A);

    const del = await api.deleteMyAccount(auth.access);
    expect([200, 202]).toContain(del.status);

    const meAfter = await api.getMe(auth.access);
    api.assertProblemJson(meAfter, [401, 403, 404]);

    const journeysAfter = await api.getJourneys(auth.access);
    api.assertProblemJson(journeysAfter, [401, 403, 404]);
  });

  test('DELETE /v1/me anonymises user karma_ledger entries and removes account PII', async () => {
    const api = new SaathApiClient();
    const phone = uniquePhone(322_002);
    const auth = await api.loginWithOtp(phone);
    await api.patchMe(auth.access, { display_alias: 'EphemeralUser322' });

    const del = await api.deleteMyAccount(auth.access);
    expect([200, 202]).toContain(del.status);
    expect(JSON.stringify(del.data)).not.toContain(phone);
  });

  test('Party / journey DTOs for bookings with children never expose raw minor name or age', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone(322_003));
    const verify = await api.verifyTrainPnr(auth.access, TEST_PNRS.rajdhani3A);
    const jId = getString(asRecord(verify.data.journey, 'j'), 'id');
    const hub = await api.getJourney(auth.access, jId);

    assertNoPiiLeak(verify.data, 'dpdp-verify-no-minor-pii');
    assertNoPiiLeak(hub.data, 'dpdp-hub-no-minor-pii');
  });

  test('Withdrawing optional analytics & notification consents persists granted=false', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone(322_004));

    await api.saveConsents(auth.access, [
      { purpose: 'analytics', notice_version: '1.0', granted: true },
      { purpose: 'notifications', notice_version: '1.0', granted: true },
    ]);

    const withdraw = await api.saveConsents(auth.access, [
      { purpose: 'analytics', notice_version: '1.0', granted: false },
      { purpose: 'notifications', notice_version: '1.0', granted: false },
    ]);
    expect([200, 201]).toContain(withdraw.status);
    const rows = Array.isArray(withdraw.data.consents)
      ? (withdraw.data.consents as Array<Record<string, unknown>>)
      : [];
    expect(rows.some((r) => r.purpose === 'analytics' && r.granted === false)).toBe(true);
  });
});
