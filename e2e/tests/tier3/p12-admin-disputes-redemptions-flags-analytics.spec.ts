import { test, expect } from '../../fixtures/multi-browser.js';
import {
  asArray,
  asRecord,
  getAdminToken,
  getNumber,
  getString,
  seedSwapDispute,
} from '../../helpers/admin-seed.js';
import { SaathApiClient } from '../../helpers/api.js';
import { futureDateIso } from '../../helpers/env.js';

async function toggleRewardsFlag(
  api: SaathApiClient,
  adminToken: string,
  fn: () => Promise<void>,
): Promise<void> {
  const flagsBefore = await api.getAdminFlags(adminToken);
  const items = asArray(flagsBefore.data.items, 'flags').map((f) => asRecord(f, 'f'));
  const orig = items.find((f) => f.key === 'rewards_catalogue_enabled')?.value ?? false;
  try {
    expect(
      (await api.patchAdminFlag(adminToken, 'rewards_catalogue_enabled', true, 'P12 enable')).status,
    ).toBe(200);
    await fn();
  } finally {
    expect(
      (await api.patchAdminFlag(adminToken, 'rewards_catalogue_enabled', orig, 'P12 restore')).status,
    ).toBe(200);
  }
}

async function exerciseOptionalRewardRedemption(
  api: SaathApiClient,
  adminToken: string,
  userToken: string,
): Promise<void> {
  const cat = await api.getRewardsCatalogue<{
    enabled: boolean;
    items: Array<{ code: string }>;
  }>(userToken);
  expect(cat.status).toBe(200);
  expect(cat.data.enabled).toBe(true);
  const first = cat.data.items[0];
  if (first) {
    const redeemed = await api.redeemReward<{ id: string }>(userToken, first.code);
    expect([200, 201]).toContain(redeemed.status);
    const approved = await api.reviewAdminRedemption(adminToken, redeemed.data.id, {
      action: 'approve',
      note: 'P12 approved',
    });
    expect(approved.status).toBe(200);
    expect(approved.data.status).toBe('approved');
  }
}

test.describe('@tier3 P12: Admin Disputes -> Redemptions -> Flags -> Analytics -> Fraud Graph -> Audit Log', () => {
  test('Post-journey conflict -> admin override not_completed (reverses karma + revokes card) & complete (credits karma)', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);

    // Case 1: completed swap overridden to not_completed
    const completedDispute = await seedSwapDispute(api, 'p12-rev', {
      travelDate: futureDateIso(37),
      seatA: '1',
      seatB: '3',
      completeFirst: true,
    });
    const revRes = await api.overrideAdminDispute<{
      status: string;
      karma_reversed_users: string[];
    }>(adminToken, completedDispute.swapId, {
      action: 'not_completed',
      note: 'P12 reversal override',
    });
    expect(revRes.status).toBe(200);
    expect(revRes.data.status).toBe('not_completed');
    expect(revRes.data.karma_reversed_users.length).toBeGreaterThanOrEqual(2);

    const cardAfterRev = await api.verifyPublicSwapCard(completedDispute.publicCode);
    expect(cardAfterRev.data.revoked).toBe(true);

    // Case 2: conflicting confirmation overridden to complete
    const openDispute = await seedSwapDispute(api, 'p12-comp', {
      travelDate: futureDateIso(37),
      seatA: '4',
      seatB: '6',
    });
    const listOpen = await api.getAdminDisputes(adminToken, { status: 'open', limit: 50 });
    expect(
      asArray(listOpen.data.items, 'open').some(
        (d) => asRecord(d, 'd').dispute_id === openDispute.swapId,
      ),
    ).toBe(true);

    const compRes = await api.overrideAdminDispute<{
      status: string;
      karma_credited_users: string[];
    }>(adminToken, openDispute.swapId, {
      action: 'complete',
      note: 'P12 completion override',
    });
    expect(compRes.status).toBe(200);
    expect(compRes.data.status).toBe('completed');
    expect(compRes.data.karma_credited_users.length).toBeGreaterThanOrEqual(2);

    const audit = await api.getAdminAuditLog<{ total: number }>(adminToken, {
      action: 'admin.dispute_override',
      resource: `swap:${openDispute.swapId}`,
    });
    expect(audit.data.total).toBeGreaterThanOrEqual(1);
  });

  test('Feature flag toggle + rewards catalogue + admin redemption review + audit_log', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);
    const completed = await seedSwapDispute(api, 'p12-redemption', {
      travelDate: futureDateIso(38),
      seatA: '9',
      seatB: '11',
      completeFirst: true,
    });

    await toggleRewardsFlag(api, adminToken, async () => {
      await exerciseOptionalRewardRedemption(api, adminToken, completed.authA.access);
    });

    const redemptions = await api.getAdminRedemptions(adminToken, { status: 'all' });
    expect(redemptions.status).toBe(200);
    expect(Array.isArray(redemptions.data.items)).toBe(true);

    const flagAudit = await api.getAdminAuditLog<{ total: number }>(adminToken, {
      action: 'admin.flag_updated',
      resource: 'feature_flag:rewards_catalogue_enabled',
    });
    expect(flagAudit.data.total).toBeGreaterThanOrEqual(1);
  });

  test('Same-pair swaps + funnel analytics + provider health + fraud graph + audit_log integration', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);

    const s1 = await seedSwapDispute(api, 'p12-graph', {
      travelDate: futureDateIso(39),
      seatA: '12',
      seatB: '14',
      completeFirst: true,
    });
    const d2 = futureDateIso(40);
    const vA2 = await api.verifyTrainSms(
      s1.authA.access,
      `IRCTC PNR:7312000201,TRN:12951,DOJ:${d2},CLS:3A,B3 17 LB,NDLS-MMCT`,
    );
    const vB2 = await api.verifyTrainSms(
      s1.authB.access,
      `IRCTC PNR:7312000202,TRN:12951,DOJ:${d2},CLS:3A,B3 19 UB,NDLS-MMCT`,
    );
    const hubA2 = await api.getJourney(s1.authA.access, getString(asRecord(vA2.data.journey, 'jA2'), 'id'));
    const hubB2 = await api.getJourney(s1.authB.access, getString(asRecord(vB2.data.journey, 'jB2'), 'id'));
    const pA2 = getString(asRecord(hubA2.data.party, 'pA2'), 'id');
    const pB2 = getString(asRecord(hubB2.data.party, 'pB2'), 'id');

    await api.setGoal(s1.authA.access, pA2, {
      goal_type: 'lower',
      movers: [getString(asRecord(asArray(hubA2.data.seat_holders, 'hA2')[0], 'h0'), 'id')],
      constraints: {},
    });
    await api.setGoal(s1.authB.access, pB2, {
      goal_type: 'open_to_help',
      movers: [getString(asRecord(asArray(hubB2.data.seat_holders, 'hB2')[0], 'h0'), 'id')],
      constraints: {},
      standing_offer: { give_to: 'anyone' },
    });

    let cardId = '';
    await expect(async () => {
      const m = await api.getMatches(s1.authA.access, pA2, 'pair');
      expect(m.data.items.length).toBeGreaterThanOrEqual(1);
      cardId = m.data.items[0]?.card_id ?? '';
      expect(cardId.length).toBeGreaterThan(0);
    }).toPass({ timeout: 12_000 });

    const swap2 = await api.createSwap(s1.authA.access, cardId);
    const swap2Id = getString(swap2.data, 'id');
    const accA = await api.acceptSwap(s1.authA.access, swap2Id, getNumber(swap2.data, 'version'));
    await api.acceptSwap(s1.authB.access, swap2Id, getNumber(accA.data, 'version'));
    await api.confirmCompletion(s1.authA.access, swap2Id, 'yes');
    await api.confirmCompletion(s1.authB.access, swap2Id, 'yes');

    const funnel = await api.getAdminFunnel(adminToken, { route: '12951' });
    expect(funnel.status).toBe(200);
    expect(Number(funnel.data.swap_completed)).toBeGreaterThanOrEqual(2);

    const health = await api.getAdminProvidersHealth(adminToken);
    expect(health.status).toBe(200);
    expect(asArray(health.data.providers, 'providers').length).toBeGreaterThanOrEqual(1);

    const graph = await api.getAdminFraudGraph(adminToken);
    expect(graph.status).toBe(200);
    const flagged = asArray(graph.data.flagged_pairs, 'flagged').map((e) => asRecord(e, 'e'));
    expect(
      flagged.some((e) => {
        const ids = [String(e.user_a), String(e.user_b)];
        return ids.includes(s1.authA.user.id) && ids.includes(s1.authB.user.id);
      }),
    ).toBe(true);

    const audit = await api.getAdminAuditLog<{ total: number }>(adminToken, {
      action: 'admin.fraud_graph_viewed',
    });
    expect(audit.data.total).toBeGreaterThanOrEqual(1);
  });
});
