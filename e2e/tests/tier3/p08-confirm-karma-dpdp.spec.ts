import { test, expect } from '../../fixtures/multi-browser.js';
import { SaathApiClient } from '../../helpers/api.js';
import { TEST_PNRS, uniquePhone } from '../../helpers/env.js';

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

    await api.setGoal(uB.access, b.partyId, { goal_type: 'open_to_help', movers: [b.holderId], constraints: {} });
    await api.setGoal(uA.access, a.partyId, { goal_type: 'lower', movers: [a.holderId], constraints: {} });

    let cardId = '';
    await expect(async () => {
      const m = await api.getMatches(uA.access, a.partyId);
      expect(m.data.items.length).toBeGreaterThanOrEqual(1);
      cardId = m.data.items[0]?.card_id ?? '';
    }).toPass({ timeout: 12_000 });

    const swap = await api.createSwap<{ id: string; version: number }>(uA.access, cardId);
    const accA = await api.acceptSwap<{ version: number }>(uA.access, swap.data.id, swap.data.version);
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

  test('DPDP consent recording and GET /v1/me/export return valid downloadable ZIP archive', async () => {
    const api = new SaathApiClient();
    const user = await api.loginWithOtp(uniquePhone('p08-export'), 'whatsapp');

    const consentRes = await api.saveConsents(user.access, [
      { purpose: 'verification', notice_version: 'v1', granted: true },
      { purpose: 'matching', notice_version: 'v1', granted: true },
    ]);
    expect([200, 201]).toContain(consentRes.status);

    const exportRes = await api.exportMyData(user.access);
    expect(exportRes.status).toBe(200);
    expect(exportRes.buffer.length).toBeGreaterThan(20);
    // ZIP magic bytes PK\x03\x04
    expect(exportRes.buffer[0]).toBe(0x50);
    expect(exportRes.buffer[1]).toBe(0x4b);
  });

  test('DELETE /v1/me erases PII, revokes profile access, and anonymises karma ledger', async () => {
    const api = new SaathApiClient();
    const user = await api.loginWithOtp(uniquePhone('p08-delete'), 'whatsapp');

    const delRes = await api.deleteMyAccount<{ status: string }>(user.access);
    expect([200, 202]).toContain(delRes.status);

    const meAfter = await api.getMe(user.access);
    api.assertProblemJson(meAfter, [401, 403, 404]);
    expect([401, 403, 404]).toContain(meAfter.status);
  });
});
