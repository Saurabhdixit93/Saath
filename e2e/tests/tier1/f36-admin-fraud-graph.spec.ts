import { test, expect } from '../../fixtures/multi-browser.js';
import {
  asArray,
  asRecord,
  getAdminToken,
  getString,
  seedSwapDispute,
} from '../../helpers/admin-seed.js';
import { SaathApiClient } from '../../helpers/api.js';
import { futureDateIso } from '../../helpers/env.js';

test.describe('@tier1 F36 (Feature 6): Karma Fraud Graph & Collusion', () => {
  test('GET /v1/admin/fraud/graph returns nodes, edges, flagged_pairs, shared_devices, and anomalies arrays', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);

    const res = await api.getAdminFraudGraph(adminToken);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data.nodes)).toBe(true);
    expect(Array.isArray(res.data.edges)).toBe(true);
    expect(Array.isArray(res.data.flagged_pairs)).toBe(true);
    expect(Array.isArray(res.data.shared_devices)).toBe(true);
    expect(Array.isArray(res.data.anomalies)).toBe(true);
  });

  test('Viewing fraud graph records admin.fraud_graph_viewed in audit_log', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);

    const before = await api.getAdminAuditLog<{ total: number }>(adminToken, {
      action: 'admin.fraud_graph_viewed',
    });
    expect(before.status).toBe(200);

    const graph = await api.getAdminFraudGraph(adminToken);
    expect(graph.status).toBe(200);

    const after = await api.getAdminAuditLog<{
      total: number;
      items: Array<Record<string, unknown>>;
    }>(adminToken, {
      action: 'admin.fraud_graph_viewed',
      limit: 5,
    });
    expect(after.status).toBe(200);
    expect(after.data.total).toBeGreaterThan(before.data.total);
    expect(after.data.items[0]?.resource).toBe('fraud:graph');
  });

  test('Shared push_endpoint / push_p256dh fingerprints surface in shared_devices and flagged_pairs', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);

    const pair = await seedSwapDispute(api, 'f36-shared-dev', {
      travelDate: futureDateIso(30),
      seatA: '1',
      seatB: '3',
      completeFirst: true,
    });
    const sharedEndpoint = `https://push.saath.test/sub/f36-${Date.now()}`;
    const sharedP256dh = `BTestKeyShared_${Date.now()}`;

    expect(
      (
        await api.savePushSubscription(pair.authA.access, {
          endpoint: sharedEndpoint,
          keys: { p256dh: sharedP256dh, auth: 'authA123' },
        })
      ).status,
    ).toBeLessThan(300);
    expect(
      (
        await api.savePushSubscription(pair.authB.access, {
          endpoint: sharedEndpoint,
          keys: { p256dh: sharedP256dh, auth: 'authB123' },
        })
      ).status,
    ).toBeLessThan(300);

    const graph = await api.getAdminFraudGraph(adminToken);
    expect(graph.status).toBe(200);
    const clusters = asArray(graph.data.shared_devices, 'shared_devices').map((c) =>
      asRecord(c, 'cluster'),
    );
    const matchingCluster = clusters.find((c) => {
      const uids = asArray(c.user_ids, 'user_ids').map(String);
      return uids.includes(pair.authA.user.id) && uids.includes(pair.authB.user.id);
    });
    expect(matchingCluster).toBeDefined();
    expect(typeof matchingCluster?.fingerprint_hash).toBe('string');

    const flagged = asArray(graph.data.flagged_pairs, 'flagged_pairs').map((e) =>
      asRecord(e, 'edge'),
    );
    const pairEdge = flagged.find((e) => {
      const pairIds = [String(e.user_a), String(e.user_b)];
      return pairIds.includes(pair.authA.user.id) && pairIds.includes(pair.authB.user.id);
    });
    expect(pairEdge).toBeDefined();
    expect(asArray(pairEdge?.reasons, 'reasons')).toContain('shared_device_push_key');
  });

  test('Repeat completed swaps between same pair surface repeat_swap_pair and same_pair_cap_blocked anomaly', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);

    const first = await seedSwapDispute(api, 'f36-repeat', {
      travelDate: futureDateIso(31),
      seatA: '4',
      seatB: '6',
      completeFirst: true,
    });

    // Second journey & completed swap with the same two users
    const d2 = futureDateIso(32);
    const vA2 = await api.verifyTrainSms(
      first.authA.access,
      `IRCTC PNR:7360000101,TRN:12951,DOJ:${d2},CLS:3A,B3 9 LB,NDLS-MMCT`,
    );
    const vB2 = await api.verifyTrainSms(
      first.authB.access,
      `IRCTC PNR:7360000102,TRN:12951,DOJ:${d2},CLS:3A,B3 11 UB,NDLS-MMCT`,
    );
    expect(vA2.status).toBe(200);
    expect(vB2.status).toBe(200);

    const hubA2 = await api.getJourney(
      first.authA.access,
      getString(asRecord(vA2.data.journey, 'jA2'), 'id'),
    );
    const hubB2 = await api.getJourney(
      first.authB.access,
      getString(asRecord(vB2.data.journey, 'jB2'), 'id'),
    );
    const pA2 = getString(asRecord(hubA2.data.party, 'pA2'), 'id');
    const pB2 = getString(asRecord(hubB2.data.party, 'pB2'), 'id');

    await api.setGoal(first.authA.access, pA2, {
      goal_type: 'lower',
      movers: [getString(asRecord(asArray(hubA2.data.seat_holders, 'hA2')[0], 'h0'), 'id')],
      preferred_seats: [],
      constraints: {},
    });
    await api.setGoal(first.authB.access, pB2, {
      goal_type: 'open_to_help',
      movers: [getString(asRecord(asArray(hubB2.data.seat_holders, 'hB2')[0], 'h0'), 'id')],
      preferred_seats: [],
      constraints: {},
      standing_offer: { give_to: 'anyone' },
    });

    let cardId2 = '';
    await expect(async () => {
      const m = await api.getMatches(first.authA.access, pA2, 'pair');
      expect(m.data.items.length).toBeGreaterThanOrEqual(1);
      cardId2 = m.data.items[0]?.card_id ?? '';
      expect(cardId2.length).toBeGreaterThan(0);
    }).toPass({ timeout: 12_000 });

    const swap2 = await api.createSwap<{ id: string; version: number }>(first.authA.access, cardId2);
    const accA2 = await api.acceptSwap<{ version: number }>(
      first.authA.access,
      swap2.data.id,
      swap2.data.version,
    );
    await api.acceptSwap(first.authB.access, swap2.data.id, accA2.data.version);
    await api.confirmCompletion(first.authA.access, swap2.data.id, 'yes');
    await api.confirmCompletion(first.authB.access, swap2.data.id, 'yes');

    const graph = await api.getAdminFraudGraph(adminToken);
    expect(graph.status).toBe(200);
    const flagged = asArray(graph.data.flagged_pairs, 'flagged').map((e) => asRecord(e, 'e'));
    const edge = flagged.find((e) => {
      const ids = [String(e.user_a), String(e.user_b)];
      return ids.includes(first.authA.user.id) && ids.includes(first.authB.user.id);
    });
    expect(edge).toBeDefined();
    expect(Number(edge?.swap_count)).toBeGreaterThanOrEqual(2);
    expect(asArray(edge?.reasons, 'reasons')).toContain('repeat_swap_pair');

    const anomalies = asArray(graph.data.anomalies, 'anomalies').map((a) => asRecord(a, 'a'));
    expect(anomalies.some((a) => a.action === 'karma.same_pair_cap_blocked')).toBe(true);
  });

  test('Fraud nodes summarize karma_credited and karma_reversed accurately', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);

    const disputed = await seedSwapDispute(api, 'f36-nodes', {
      travelDate: futureDateIso(33),
      seatA: '12',
      seatB: '14',
      completeFirst: true,
    });
    const ov = await api.overrideAdminDispute(adminToken, disputed.swapId, {
      action: 'reverse_karma',
      note: 'Fraud reversal node verification',
    });
    expect(ov.status).toBe(200);

    const graph = await api.getAdminFraudGraph(adminToken);
    expect(graph.status).toBe(200);
    const nodes = asArray(graph.data.nodes, 'nodes').map((n) => asRecord(n, 'node'));
    const nodeA = nodes.find((n) => n.user_id === disputed.authA.user.id);
    expect(nodeA).toBeDefined();
    expect(Number(nodeA?.karma_credited)).toBeGreaterThan(0);
    expect(Number(nodeA?.karma_reversed)).toBeGreaterThan(0);
  });
});
