import { test, expect } from '../../fixtures/multi-browser.js';
import {
  asArray,
  asRecord,
  getAdminToken,
  seedSwapDispute,
} from '../../helpers/admin-seed.js';
import { SaathApiClient } from '../../helpers/api.js';
import { futureDateIso } from '../../helpers/env.js';

async function toggleFlagWithRestore(
  api: SaathApiClient,
  adminToken: string,
  key: string,
  fn: (originalValue: unknown) => Promise<void>,
): Promise<void> {
  const before = await api.getAdminFlags(adminToken);
  expect(before.status).toBe(200);
  const items = asArray(before.data.items, 'flags').map((f) => asRecord(f, 'flag'));
  const target = items.find((f) => f.key === key);
  const originalValue = target ? target.value : false;
  try {
    await fn(originalValue);
  } finally {
    const restore = await api.patchAdminFlag(
      adminToken,
      key,
      originalValue,
      'Restore flag after E2E test',
    );
    expect(restore.status).toBe(200);
  }
}

async function verifyCatalogueAndOptionalRedemptionReview(
  api: SaathApiClient,
  adminToken: string,
  userToken: string,
): Promise<void> {
  const catalogue = await api.getRewardsCatalogue<{
    enabled: boolean;
    items: Array<{ code: string; cost_points: number }>;
  }>(userToken);
  expect(catalogue.status).toBe(200);
  expect(catalogue.data.enabled).toBe(true);
  expect(Array.isArray(catalogue.data.items)).toBe(true);

  const firstItem = catalogue.data.items[0];
  if (firstItem) {
    const redeemRes = await api.redeemReward<{ id: string; status: string }>(
      userToken,
      firstItem.code,
    );
    expect([200, 201]).toContain(redeemRes.status);
    const reviewRes = await api.reviewAdminRedemption(adminToken, redeemRes.data.id, {
      action: 'approve',
      note: 'E2E redemption approval',
    });
    expect(reviewRes.status).toBe(200);
    expect(reviewRes.data.status).toBe('approved');
  }
}

test.describe('@tier1 F37 (Feature 7): Feature Flags & Dispute/Redemption Overrides', () => {
  test('GET/PATCH /v1/admin/flags updates, persists, restores in finally, and writes audit_log', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);

    await toggleFlagWithRestore(api, adminToken, 'rewards_catalogue_enabled', async (orig) => {
      const toggled = !Boolean(orig);
      const patched = await api.patchAdminFlag(
        adminToken,
        'rewards_catalogue_enabled',
        toggled,
        'F37 toggle test',
      );
      expect(patched.status).toBe(200);
      expect(Boolean(patched.data.value)).toBe(toggled);

      const list = await api.getAdminFlags(adminToken);
      const found = asArray(list.data.items, 'items')
        .map((i) => asRecord(i, 'item'))
        .find((i) => i.key === 'rewards_catalogue_enabled');
      expect(Boolean(found?.value)).toBe(toggled);
    });

    const audit = await api.getAdminAuditLog<{ total: number }>(adminToken, {
      action: 'admin.flag_updated',
      resource: 'feature_flag:rewards_catalogue_enabled',
    });
    expect(audit.status).toBe(200);
    expect(audit.data.total).toBeGreaterThanOrEqual(1);
  });

  test('GET /v1/admin/disputes lists deterministic swap_dispute under status=open and status=all', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);
    const seeded = await seedSwapDispute(api, 'f37-list', {
      travelDate: futureDateIso(25),
      seatA: '1',
      seatB: '3',
    });

    const openList = await api.getAdminDisputes(adminToken, { status: 'open', limit: 50 });
    expect(openList.status).toBe(200);
    const openItems = asArray(openList.data.items, 'open disputes').map((d) => asRecord(d, 'd'));
    const found = openItems.find((d) => d.dispute_id === seeded.swapId);
    expect(found).toBeDefined();
    expect(found?.dispute_type).toBe('swap_dispute');
    expect(asArray(found?.participants, 'participants').length).toBeGreaterThanOrEqual(2);

    const allList = await api.getAdminDisputes(adminToken, { status: 'all', limit: 50 });
    expect(allList.status).toBe(200);
    expect(Number(allList.data.total)).toBeGreaterThanOrEqual(1);
  });

  test('POST /v1/admin/disputes/{id}/override with action=complete resolves dispute and credits karma', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);
    const seeded = await seedSwapDispute(api, 'f37-complete', {
      travelDate: futureDateIso(25),
      seatA: '4',
      seatB: '6',
    });

    const res = await api.overrideAdminDispute<{
      dispute_id: string;
      status: string;
      karma_credited_users: string[];
    }>(adminToken, seeded.swapId, {
      action: 'complete',
      note: 'Admin verified completion',
    });
    expect(res.status).toBe(200);
    expect(res.data.status).toBe('completed');
    expect(res.data.karma_credited_users.length).toBeGreaterThanOrEqual(2);

    const karmaA = await api.getKarma<{ balance: number }>(seeded.authA.access);
    expect(karmaA.status).toBe(200);
    expect(karmaA.data.balance).toBeGreaterThan(0);

    const resolved = await api.getAdminDisputes(adminToken, { status: 'resolved', limit: 50 });
    const resolvedItems = asArray(resolved.data.items, 'resolved').map((d) => asRecord(d, 'd'));
    expect(resolvedItems.some((d) => d.dispute_id === seeded.swapId)).toBe(true);
  });

  test('POST /v1/admin/disputes/{id}/override with action=not_completed reverses karma and revokes Swap Card', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);
    const seeded = await seedSwapDispute(api, 'f37-reverse', {
      travelDate: futureDateIso(25),
      seatA: '9',
      seatB: '11',
      completeFirst: true,
    });

    const res = await api.overrideAdminDispute<{
      status: string;
      karma_reversed_users: string[];
    }>(adminToken, seeded.swapId, {
      action: 'not_completed',
      note: 'Did not swap on board',
    });
    expect(res.status).toBe(200);
    expect(res.data.status).toBe('not_completed');
    expect(res.data.karma_reversed_users.length).toBeGreaterThanOrEqual(2);

    const karmaAfter = await api.getKarma<{ balance: number }>(seeded.authA.access);
    expect(karmaAfter.data.balance).toBe(0);

    const pubCard = await api.verifyPublicSwapCard(seeded.publicCode);
    expect(pubCard.status).toBe(200);
    expect(pubCard.data.revoked).toBe(true);
  });

  test('GET /v1/admin/redemptions & rewards catalogue toggle obey feature flag and review schema', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);
    const seeded = await seedSwapDispute(api, 'f37-redeem', {
      travelDate: futureDateIso(25),
      seatA: '12',
      seatB: '14',
      completeFirst: true,
    });

    await toggleFlagWithRestore(api, adminToken, 'rewards_catalogue_enabled', async () => {
      const patch = await api.patchAdminFlag(
        adminToken,
        'rewards_catalogue_enabled',
        true,
        'Enable rewards catalogue for F37 check',
      );
      expect(patch.status).toBe(200);
      await verifyCatalogueAndOptionalRedemptionReview(api, adminToken, seeded.authA.access);
    });

    const redemptions = await api.getAdminRedemptions(adminToken, { status: 'all', limit: 20 });
    expect(redemptions.status).toBe(200);
    expect(Array.isArray(redemptions.data.items)).toBe(true);
    expect(typeof redemptions.data.total).toBe('number');
  });
});
