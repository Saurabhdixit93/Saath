import { test, expect } from '../../fixtures/multi-browser.js';
import { createReportedMessage, getAdminToken } from '../../helpers/admin-seed.js';
import { SaathApiClient } from '../../helpers/api.js';
import { futureDateIso, uniquePhone } from '../../helpers/env.js';
import { EXPECTED_DPDP_EXPORT_FILES, parseDpdpExportZip } from '../../helpers/zip.js';

test.describe('@tier2 F41 Tier 2: Data Portability Export Boundaries', () => {
  test('Unauthenticated GET /v1/me/export returns 401 RFC 9457', async () => {
    const api = new SaathApiClient();
    api.assertProblemJson(await api.request('GET', '/v1/me/export'), 401);
  });

  test('Anonymous JWT is rejected (401/403) on GET /v1/me/export', async () => {
    const api = new SaathApiClient();
    const anon = await api.issueAnonymousToken();
    api.assertProblemJson(await api.request('GET', '/v1/me/export', { token: anon.data.access }), [401, 403]);
  });

  test('Brand-new user with zero journeys/swaps/messages still exports valid 8-file ZIP without 500', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone('f41-t2-empty'));

    const res = await api.exportMyData(auth.access);
    expect(res.status).toBe(200);
    const bundle = parseDpdpExportZip(res.buffer);
    expect(Object.keys(bundle).sort()).toEqual([...EXPECTED_DPDP_EXPORT_FILES].sort());
  });

  test('Deleted and banned users are denied (401/403/404) on GET /v1/me/export', async () => {
    const api = new SaathApiClient();
    const deletedAuth = await api.loginWithOtp(uniquePhone('f41-t2-deleted'));
    expect([200, 202]).toContain((await api.deleteMyAccount(deletedAuth.access)).status);
    expect([401, 403, 404]).toContain((await api.exportMyData(deletedAuth.access)).status);

    const adminToken = await getAdminToken(api);
    const rep = await createReportedMessage(api, 'f41-t2-banned', {
      travelDate: futureDateIso(27),
      seatA: '1',
      seatB: '3',
    });
    expect((await api.actOnModeration(adminToken, rep.reportId, 'ban')).status).toBe(200);
    expect([401, 403]).toContain((await api.exportMyData(rep.authB.access)).status);
  });

  test('Unsupported HTTP methods (POST, DELETE) on /v1/me/export return 405 RFC 9457', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone('f41-t2-405'));

    api.assertProblemJson(
      await api.request('POST', '/v1/me/export', { token: auth.access }),
      405,
    );
    api.assertProblemJson(
      await api.request('DELETE', '/v1/me/export', { token: auth.access }),
      405,
    );
  });
});
