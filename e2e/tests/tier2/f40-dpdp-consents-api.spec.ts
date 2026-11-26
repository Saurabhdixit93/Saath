import { test, expect } from '../../fixtures/multi-browser.js';
import { SaathApiClient } from '../../helpers/api.js';
import { uniquePhone } from '../../helpers/env.js';
import { assertNoPiiLeak } from '../../helpers/pii.js';

test.describe('@tier2 F40 Tier 2: Itemised Consent Notice & Ledger Boundaries', () => {
  test('Unauthenticated GET and POST /v1/me/consents return 401 RFC 9457', async () => {
    const api = new SaathApiClient();
    api.assertProblemJson(await api.request('GET', '/v1/me/consents'), 401);
    api.assertProblemJson(
      await api.request('POST', '/v1/me/consents', { body: { consents: [] } }),
      401,
    );
  });

  test('Anonymous JWT is rejected (401/403) on GET and POST /v1/me/consents', async () => {
    const api = new SaathApiClient();
    const anon = await api.issueAnonymousToken();

    api.assertProblemJson(await api.getConsents(anon.data.access), [401, 403]);
    api.assertProblemJson(
      await api.saveConsents(anon.data.access, [
        { purpose: 'verification', notice_version: '1.0', granted: true },
      ]),
      [401, 403],
    );
  });

  test('Invalid purpose, missing notice_version, and empty consents array return 422 RFC 9457', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone('f40-t2-val'));

    api.assertProblemJson(
      await api.saveConsents(auth.access, [
        { purpose: 'sell_to_brokers', notice_version: '1.0', granted: true },
      ]),
      422,
    );
    api.assertProblemJson(
      await api.request('POST', '/v1/me/consents', {
        token: auth.access,
        body: { consents: [{ purpose: 'verification', granted: true }] },
      }),
      422,
    );
    api.assertProblemJson(
      await api.request('POST', '/v1/me/consents', {
        token: auth.access,
        body: { consents: [] },
      }),
      422,
    );
  });

  test('Deleted user JWT is rejected on GET and POST /v1/me/consents', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone('f40-t2-del'));
    expect([200, 202]).toContain((await api.deleteMyAccount(auth.access)).status);

    api.assertProblemJson(await api.getConsents(auth.access), [401, 403, 404]);
    api.assertProblemJson(
      await api.saveConsents(auth.access, [
        { purpose: 'verification', notice_version: '1.0', granted: true },
      ]),
      [401, 403, 404],
    );
  });

  test('Withdrawing optional analytics, notifications, and whatsapp consents persists granted=false without PII leak', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone('f40-t2-withdraw'));
    const init = await api.getConsents<{ notice_version: string }>(auth.access);

    await api.saveConsents(auth.access, [
      { purpose: 'analytics', notice_version: init.data.notice_version, granted: true },
      { purpose: 'notifications', notice_version: init.data.notice_version, granted: true },
      { purpose: 'whatsapp', notice_version: init.data.notice_version, granted: true },
    ]);

    const withdraw = await api.saveConsents<{
      consents: Array<{ purpose: string; granted: boolean }>;
    }>(auth.access, [
      { purpose: 'analytics', notice_version: init.data.notice_version, granted: false },
      { purpose: 'notifications', notice_version: init.data.notice_version, granted: false },
      { purpose: 'whatsapp', notice_version: init.data.notice_version, granted: false },
    ]);
    expect([200, 201]).toContain(withdraw.status);
    assertNoPiiLeak(withdraw.data, 'f40-t2-withdraw');
    expect(withdraw.data.consents.find((c) => c.purpose === 'analytics')?.granted).toBe(false);
    expect(withdraw.data.consents.find((c) => c.purpose === 'notifications')?.granted).toBe(false);
    expect(withdraw.data.consents.find((c) => c.purpose === 'whatsapp')?.granted).toBe(false);
  });
});
