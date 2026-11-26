import { test, expect } from '../../fixtures/multi-browser.js';
import { SaathApiClient } from '../../helpers/api.js';
import { TEST_PNRS, uniquePhone } from '../../helpers/env.js';
import { assertNoPiiLeak } from '../../helpers/pii.js';
import { parseDpdpExportZip } from '../../helpers/zip.js';

function extractIds(payload: Record<string, unknown>): {
  partyId: string;
  holderId: string;
} {
  const party = payload.party as { id?: string } | undefined;
  const holders = payload.seat_holders as Array<{ id: string }> | undefined;
  if (!party?.id || !holders?.[0]?.id) {
    throw new Error(`Missing IDs in payload: ${JSON.stringify(payload)}`);
  }
  return { partyId: party.id, holderId: holders[0].id };
}

test.describe('@tier3 P08: Post-Journey Confirm -> Karma Ledger -> DPDP Export & Erasure', () => {
  test('Mutual post-journey confirmation credits karma ledger and increments reliability counters', async () => {
    const api = new SaathApiClient();
    const uA = await api.loginWithOtp(uniquePhone('p08-a'), 'whatsapp');
    const uB = await api.loginWithOtp(uniquePhone('p08-b'), 'whatsapp');

    const vA = await api.verifyTrainPnr(uA.access, TEST_PNRS.cycleA);
    const vB = await api.verifyTrainPnr(uB.access, TEST_PNRS.cycleB);
    const a = extractIds(vA.data);
    const b = extractIds(vB.data);

    await api.setGoal(uB.access, b.partyId, {
      goal_type: 'open_to_help',
      movers: [b.holderId],
      constraints: {},
    });
    await api.setGoal(uA.access, a.partyId, {
      goal_type: 'lower',
      movers: [a.holderId],
      constraints: {},
    });

    let cardId = '';
    await expect(async () => {
      const m = await api.getMatches(uA.access, a.partyId);
      expect(m.data.items.length).toBeGreaterThanOrEqual(1);
      cardId = m.data.items[0]?.card_id ?? '';
    }).toPass({ timeout: 12_000 });

    const swap = await api.createSwap<{ id: string; version: number }>(uA.access, cardId);
    const accA = await api.acceptSwap<{ version: number }>(
      uA.access,
      swap.data.id,
      swap.data.version,
    );
    await api.acceptSwap(uB.access, swap.data.id, accA.data.version);

    const confA = await api.confirmCompletion(uA.access, swap.data.id, 'yes');
    const confB = await api.confirmCompletion<{ status: string }>(uB.access, swap.data.id, 'yes');
    expect(confA.status).toBe(200);
    expect(confB.status).toBe(200);
    expect(confB.data.status).toBe('completed');

    const karmaB = await api.getKarma<{ balance: number; history: unknown[]; badges: string[] }>(
      uB.access,
    );
    expect(karmaB.status).toBe(200);
    expect(karmaB.data.balance).toBeGreaterThan(0);

    const meB = await api.getMe<{ reliability_completed: number }>(uB.access);
    expect(meB.data.reliability_completed).toBeGreaterThanOrEqual(1);
  });

  test('DPDP consent recording, GET /v1/me/consents, and GET /v1/me/export return valid 8-file ZIP archive', async () => {
    const api = new SaathApiClient();
    const phone = uniquePhone('p08-export');
    const user = await api.loginWithOtp(phone, 'whatsapp');
    await api.verifyTrainPnr(user.access, TEST_PNRS.rajdhani3A);

    const consentRes = await api.saveConsents(user.access, [
      { purpose: 'verification', notice_version: '1.0', granted: true },
      { purpose: 'matching', notice_version: '1.0', granted: true },
    ]);
    expect([200, 201]).toContain(consentRes.status);

    const fetchedConsents = await api.getConsents<{
      consents?: Array<{ purpose: string; granted: boolean }>;
    }>(user.access);
    expect(fetchedConsents.status).toBe(200);
    expect(
      (fetchedConsents.data.consents ?? []).some(
        (c) => c.purpose === 'verification' && c.granted === true,
      ),
    ).toBe(true);

    const exportRes = await api.exportMyData(user.access);
    expect(exportRes.status).toBe(200);
    expect(exportRes.headers.get('content-disposition') ?? '').toContain('saath-data-export.zip');
    expect(exportRes.buffer[0]).toBe(0x50);
    expect(exportRes.buffer[1]).toBe(0x4b);

    const bundle = parseDpdpExportZip(exportRes.buffer);
    expect(Object.keys(bundle)).toHaveLength(8);
    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain(TEST_PNRS.rajdhani3A);
    expect(serialized).not.toContain(phone);
  });

  test('DELETE /v1/me revokes refresh/access tokens and anonymises karma ledger after completed swap', async () => {
    const api = new SaathApiClient();
    const phoneA = uniquePhone('p08-del-a');
    const phoneB = uniquePhone('p08-del-b');
    const uA = await api.loginWithOtp(phoneA, 'whatsapp');
    const uB = await api.loginWithOtp(phoneB, 'whatsapp');

    const aliasB = 'P08EphemeralUser';
    await api.patchMe(uB.access, {
      display_alias: aliasB,
      leaderboard_opt_in: true,
    });

    const vA = await api.verifyTrainPnr(uA.access, TEST_PNRS.cycleA);
    const vB = await api.verifyTrainPnr(uB.access, TEST_PNRS.cycleB);
    const a = extractIds(vA.data);
    const b = extractIds(vB.data);

    await api.setGoal(uB.access, b.partyId, {
      goal_type: 'open_to_help',
      movers: [b.holderId],
      constraints: {},
    });
    await api.setGoal(uA.access, a.partyId, {
      goal_type: 'lower',
      movers: [a.holderId],
      constraints: {},
    });

    let cardId = '';
    await expect(async () => {
      const m = await api.getMatches(uA.access, a.partyId);
      expect(m.data.items.length).toBeGreaterThanOrEqual(1);
      cardId = m.data.items[0]?.card_id ?? '';
    }).toPass({ timeout: 12_000 });

    const swap = await api.createSwap<{ id: string; version: number }>(uA.access, cardId);
    const accA = await api.acceptSwap<{ version: number }>(
      uA.access,
      swap.data.id,
      swap.data.version,
    );
    await api.acceptSwap(uB.access, swap.data.id, accA.data.version);
    await api.confirmCompletion(uA.access, swap.data.id, 'yes');
    await api.confirmCompletion(uB.access, swap.data.id, 'yes');

    const karmaBefore = await api.getKarma<{ balance: number }>(uB.access);
    expect(karmaBefore.data.balance).toBeGreaterThan(0);

    const delRes = await api.deleteMyAccount<{ status: string; scheduled_within_hours?: number }>(
      uB.access,
    );
    expect([200, 202]).toContain(delRes.status);
    if (delRes.data.scheduled_within_hours !== undefined) {
      expect(delRes.data.scheduled_within_hours).toBe(24);
    }

    const meAfter = await api.getMe(uB.access);
    api.assertProblemJson(meAfter, [401, 403, 404]);

    const refreshAfter = await api.refreshTokens(uB.refresh);
    api.assertProblemJson(refreshAfter, [401, 403]);

    const karmaAAfter = await api.getKarma<{ leaderboard?: unknown[] }>(uA.access);
    expect(karmaAAfter.status).toBe(200);
    expect(JSON.stringify(karmaAAfter.data.leaderboard ?? [])).not.toContain(aliasB);

    const partnerSwap = await api.getSwap(uA.access, swap.data.id);
    expect(partnerSwap.status).toBe(200);
    expect(partnerSwap.data.status).toBe('completed');
    assertNoPiiLeak(partnerSwap.data, 'p08-partner-swap-after-delete', [phoneB, aliasB]);
  });
});
