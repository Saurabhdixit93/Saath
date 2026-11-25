import { test, expect } from '@playwright/test';
import { SaathApiClient } from '../../helpers/api.js';

test.describe('@tier2 F02: Anonymous Session Boundary Cases', () => {
  test('Invalid or missing Turnstile token rejected with 400/403 problem+json', async () => {
    const api = new SaathApiClient();
    const badRes = await api.issueAnonymousToken('invalid-turnstile-token');
    const problem = api.assertProblemJson(badRes, [400, 403]);
    expect([400, 403]).toContain(problem.status);

    const emptyRes = await api.request('POST', '/v1/auth/anonymous', { body: {} });
    api.assertProblemJson(emptyRes, [400, 403, 422]);
  });

  test('Tampered or malformed Bearer JWT rejected with 401 problem+json', async () => {
    const api = new SaathApiClient();
    const res = await api.request('GET', '/v1/journeys', {
      token: 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJhbm9uOmZha2UifQ.tampered_sig',
    });
    const problem = api.assertProblemJson(res, 401);
    expect(problem.status).toBe(401);
  });

  test('Anonymous token cannot mutate user profile or submit swaps', async () => {
    const api = new SaathApiClient();
    const anon = await api.issueAnonymousToken();
    expect(anon.ok).toBe(true);

    const patchMe = await api.patchMe(anon.data.access, { display_alias: 'AnonHacker' });
    api.assertProblemJson(patchMe, [401, 403]);
    expect([401, 403]).toContain(patchMe.status);

    const createSwap = await api.createSwap(anon.data.access, 'mc_00000000000000000000000000');
    api.assertProblemJson(createSwap, [401, 403]);
  });

  test('Anonymous token cannot access DPDP export or account deletion endpoints', async () => {
    const api = new SaathApiClient();
    const anon = await api.issueAnonymousToken();
    expect(anon.ok).toBe(true);

    const exp = await api.exportMyData(anon.data.access);
    expect([401, 403]).toContain(exp.status);

    const del = await api.deleteMyAccount(anon.data.access);
    api.assertProblemJson(del, [401, 403]);
  });

  test('Anonymous token cannot access /v1/admin/* endpoints', async () => {
    const api = new SaathApiClient();
    const anon = await api.issueAnonymousToken();
    expect(anon.ok).toBe(true);

    const adminRes = await api.getAdminFunnel(anon.data.access);
    api.assertProblemJson(adminRes, [401, 403]);
    expect([401, 403]).toContain(adminRes.status);
  });
});
