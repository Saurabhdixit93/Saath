import { test, expect } from '../../fixtures/multi-browser.js';
import {
  asArray,
  asRecord,
  getAdminToken,
  seedMatchedPairWithChat,
} from '../../helpers/admin-seed.js';
import { SaathApiClient } from '../../helpers/api.js';
import { futureDateIso } from '../../helpers/env.js';

test.describe('@tier1 F33 (Feature 3): Provider Health & Notification Delivery', () => {
  test('GET /v1/admin/providers/health returns providers[] and outbox stats', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);

    const res = await api.getAdminProvidersHealth(adminToken);
    expect(res.status).toBe(200);
    const providers = asArray(res.data.providers, 'providers');
    expect(providers.length).toBeGreaterThanOrEqual(1);

    for (const rawItem of providers) {
      const item = asRecord(rawItem, 'provider item');
      expect(typeof item.name).toBe('string');
      expect(typeof item.category).toBe('string');
      expect(typeof item.mode).toBe('string');
      expect(['closed', 'open']).toContain(item.circuit_state);
      expect(typeof item.failures).toBe('number');
      expect(typeof item.open_ttl_seconds).toBe('number');
    }
  });

  test('providers[] surfaces configured rail, flight, messaging, push, llm, turnstile, and payment adapters', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);

    const res = await api.getAdminProvidersHealth(adminToken);
    expect(res.status).toBe(200);
    const providers = asArray(res.data.providers, 'providers').map((p) =>
      asRecord(p, 'provider'),
    );
    const categories = new Set(providers.map((p) => String(p.category)));

    for (const expectedCategory of ['rail', 'flight', 'messaging', 'push', 'llm', 'turnstile', 'payment']) {
      expect(categories.has(expectedCategory)).toBe(true);
    }
  });

  test('Healthy environment reports closed circuit breakers with zero failures and zero TTL', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);

    const res = await api.getAdminProvidersHealth(adminToken);
    expect(res.status).toBe(200);
    const providers = asArray(res.data.providers, 'providers').map((p) =>
      asRecord(p, 'provider'),
    );
    const fakeRail = providers.find((p) => String(p.category) === 'rail');
    expect(fakeRail).toBeDefined();
    expect(fakeRail?.circuit_state).toBe('closed');
    expect(Number(fakeRail?.failures)).toBe(0);
    expect(Number(fakeRail?.open_ttl_seconds)).toBe(0);
  });

  test('outbox health reports non-negative queued, sent, dead_letter, and lag_seconds', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);

    const res = await api.getAdminProvidersHealth(adminToken);
    expect(res.status).toBe(200);
    const outbox = asRecord(res.data.outbox, 'outbox');
    expect(Number(outbox.queued)).toBeGreaterThanOrEqual(0);
    expect(Number(outbox.sent)).toBeGreaterThanOrEqual(0);
    expect(Number(outbox.dead_letter)).toBeGreaterThanOrEqual(0);
    expect(typeof outbox.lag_seconds).toBe('number');
    expect(Number(outbox.lag_seconds)).toBeGreaterThanOrEqual(0);
  });

  test('Creating a swap proposal enqueues SwapProposed notification reflected in outbox totals', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);

    const before = await api.getAdminProvidersHealth(adminToken);
    expect(before.status).toBe(200);
    const outboxBefore = asRecord(before.data.outbox, 'outboxBefore');
    const totalBefore =
      Number(outboxBefore.queued) + Number(outboxBefore.sent) + Number(outboxBefore.dead_letter);

    await seedMatchedPairWithChat(api, 'f33-outbox', {
      travelDate: futureDateIso(29),
      seatA: '9',
      seatB: '11',
      createSwap: true,
    });

    const after = await api.getAdminProvidersHealth(adminToken);
    expect(after.status).toBe(200);
    const outboxAfter = asRecord(after.data.outbox, 'outboxAfter');
    const totalAfter =
      Number(outboxAfter.queued) + Number(outboxAfter.sent) + Number(outboxAfter.dead_letter);
    expect(totalAfter).toBeGreaterThan(totalBefore);
  });
});
