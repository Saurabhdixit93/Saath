import { test, expect } from '../../fixtures/multi-browser.js';
import {
  getAdminToken,
  seedMatchedPairWithChat,
  seedSwapDispute,
} from '../../helpers/admin-seed.js';
import { SaathApiClient } from '../../helpers/api.js';
import { futureDateIso, TEST_PNRS, uniquePhone } from '../../helpers/env.js';
import { assertNoPiiLeak } from '../../helpers/pii.js';

test.describe('@tier1 F42 (Feature 12): Right to Erasure (DELETE /v1/me) & 24h Sweep', () => {
  test('DELETE /v1/me returns erasure_scheduled within 24h without leaking user PII', async () => {
    const api = new SaathApiClient();
    const phone = uniquePhone('f42-del');
    const auth = await api.loginWithOtp(phone);
    await api.verifyTrainPnr(auth.access, TEST_PNRS.rajdhani3A);

    const del = await api.deleteMyAccount<{ status: string; scheduled_within_hours?: number }>(
      auth.access,
    );
    expect([200, 202]).toContain(del.status);
    expect(String(del.data.status)).toMatch(/erasure_scheduled|deleted/i);
    expect(del.data.scheduled_within_hours).toBe(24);
    assertNoPiiLeak(del.data, 'f42-delete-response', [phone]);
  });

  test('DELETE /v1/me immediately revokes refresh tokens and denies access JWT on protected endpoints', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone('f42-revoke'));

    const del = await api.deleteMyAccount(auth.access);
    expect([200, 202]).toContain(del.status);

    api.assertProblemJson(await api.refreshTokens(auth.refresh), [401, 403]);
    api.assertProblemJson(await api.getMe(auth.access), [401, 403, 404]);
    api.assertProblemJson(await api.getJourneys(auth.access), [401, 403, 404]);
    api.assertProblemJson(await api.getConsents(auth.access), [401, 403, 404]);
    expect([401, 403, 404]).toContain((await api.exportMyData(auth.access)).status);
  });

  test('DELETE /v1/me anonymises karma_ledger and removes user from leaderboard while preserving partner swap', async () => {
    const api = new SaathApiClient();
    const seeded = await seedSwapDispute(api, 'f42-karma-anon', {
      travelDate: futureDateIso(28),
      seatA: '1',
      seatB: '3',
      completeFirst: true,
    });
    const aliasB = 'ErasedF42User';
    await api.patchMe(seeded.authB.access, {
      display_alias: aliasB,
      leaderboard_opt_in: true,
    });

    const del = await api.deleteMyAccount(seeded.authB.access);
    expect([200, 202]).toContain(del.status);

    const karmaA = await api.getKarma<{ leaderboard?: unknown[] }>(seeded.authA.access);
    expect(karmaA.status).toBe(200);
    expect(JSON.stringify(karmaA.data.leaderboard ?? [])).not.toContain(aliasB);

    const partnerSwap = await api.getSwap(seeded.authA.access, seeded.swapId);
    expect(partnerSwap.status).toBe(200);
    expect(partnerSwap.data.status).toBe('completed');
    assertNoPiiLeak(partnerSwap.data, 'f42-partner-swap', [aliasB]);
  });

  test('DELETE /v1/me during an active pending swap releases locks without blocking partner', async () => {
    const api = new SaathApiClient();
    const seeded = await seedMatchedPairWithChat(api, 'f42-pending-swap', {
      travelDate: futureDateIso(28),
      seatA: '4',
      seatB: '6',
      createSwap: true,
    });

    const del = await api.deleteMyAccount(seeded.authB.access);
    expect([200, 202]).toContain(del.status);

    const partnerSwaps = await api.getSwaps(seeded.authA.access, 'all');
    expect(partnerSwaps.status).toBe(200);
    const swapRes = await api.getSwap(seeded.authA.access, String(seeded.swapId));
    expect(swapRes.status).toBe(200);
    expect(['cancelled', 'invalidated', 'expired', 'declined']).toContain(
      String(swapRes.data.status),
    );
  });

  test('DELETE /v1/me writes an erasure audit_log entry without raw PII', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);
    const phone = uniquePhone('f42-audit');
    const auth = await api.loginWithOtp(phone);

    const before = await api.getAdminAuditLog<{ total: number }>(adminToken);
    const del = await api.deleteMyAccount(auth.access);
    expect([200, 202]).toContain(del.status);

    const after = await api.getAdminAuditLog<{
      total: number;
      items: Array<Record<string, unknown>>;
    }>(adminToken, { limit: 15 });
    expect(after.data.total).toBeGreaterThan(before.data.total);
    const serialized = JSON.stringify(after.data.items);
    expect(serialized).toMatch(/eras|delete|dpdp/i);
    expect(serialized).not.toContain(phone);
  });
});
