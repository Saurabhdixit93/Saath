import { test, expect } from '../../fixtures/multi-browser.js';
import {
  asArray,
  asRecord,
  getAdminToken,
  seedSwapDispute,
} from '../../helpers/admin-seed.js';
import { SaathApiClient } from '../../helpers/api.js';
import { futureDateIso, uniquePhone } from '../../helpers/env.js';
import { assertNoPiiLeak } from '../../helpers/pii.js';

test.describe('@tier2 F36 Tier 2: Karma Fraud Graph & Collusion Boundaries', () => {
  test('Unauthenticated GET /v1/admin/fraud/graph returns 401 RFC 9457', async () => {
    const api = new SaathApiClient();
    api.assertProblemJson(await api.request('GET', '/v1/admin/fraud/graph'), 401);
  });

  test('Passenger and anonymous JWTs return 403 RFC 9457 on /v1/admin/fraud/graph', async () => {
    const api = new SaathApiClient();
    const user = await api.loginWithOtp(uniquePhone('f36-t2-user'));
    const anon = await api.issueAnonymousToken();

    api.assertProblemJson(await api.getAdminFraudGraph(user.access), 403);
    api.assertProblemJson(await api.getAdminFraudGraph(anon.data.access), 403);
  });

  test('Unsupported HTTP methods (POST, DELETE) on /v1/admin/fraud/graph return 405 RFC 9457', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);

    api.assertProblemJson(
      await api.request('POST', '/v1/admin/fraud/graph', { token: adminToken }),
      405,
    );
    api.assertProblemJson(
      await api.request('DELETE', '/v1/admin/fraud/graph', { token: adminToken }),
      405,
    );
  });

  test('Fraud graph never exposes raw push_endpoint URLs, phones, emails, or PNRs', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);
    const secretEndpoint = `https://push.secret.example/sub/f36t2-${Date.now()}`;

    const pair = await seedSwapDispute(api, 'f36-t2-pii', {
      travelDate: futureDateIso(31),
      seatA: '1',
      seatB: '3',
      completeFirst: true,
    });
    await api.savePushSubscription(pair.authA.access, {
      endpoint: secretEndpoint,
      keys: { p256dh: 'p256dh-secret-key', auth: 'auth-secret' },
    });
    await api.savePushSubscription(pair.authB.access, {
      endpoint: secretEndpoint,
      keys: { p256dh: 'p256dh-secret-key', auth: 'auth-secret' },
    });

    const graph = await api.getAdminFraudGraph(adminToken);
    expect(graph.status).toBe(200);
    assertNoPiiLeak(graph.data, 'f36-t2-fraud-no-pii', [secretEndpoint]);
    expect(JSON.stringify(graph.data)).not.toContain(secretEndpoint);
  });

  test('Fraud graph remains valid without 500 error when an involved user deletes their account', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);
    const pair = await seedSwapDispute(api, 'f36-t2-deleted', {
      travelDate: futureDateIso(31),
      seatA: '4',
      seatB: '6',
      completeFirst: true,
    });

    expect([200, 202]).toContain((await api.deleteMyAccount(pair.authB.access)).status);

    const graph = await api.getAdminFraudGraph(adminToken);
    expect(graph.status).toBe(200);
    const nodes = asArray(graph.data.nodes, 'nodes').map((n) => asRecord(n, 'n'));
    const deletedNode = nodes.find((n) => n.user_id === pair.authB.user.id);
    expect(deletedNode?.status).toBe('deleted');
    assertNoPiiLeak(graph.data, 'f36-t2-deleted-node-no-pii');
  });
});
