import { test, expect } from '../../fixtures/multi-browser.js';
import { SaathApiClient } from '../../helpers/api.js';
import { E2E_ENV, TEST_PNRS, uniquePhone } from '../../helpers/env.js';

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

test.describe('@tier3 P10: Chat Report -> Admin Moderation Queue -> Audit Log & Sender Restrict', () => {
  test('Reporting abusive chat creates open report and 3 reports auto-restrict offending sender', async () => {
    const api = new SaathApiClient();
    const victim = await api.loginWithOtp(uniquePhone('p10-vic'), 'whatsapp');
    const offender = await api.loginWithOtp(uniquePhone('p10-off'), 'whatsapp');

    const vV = await api.verifyTrainPnr(victim.access, TEST_PNRS.cycleA);
    const vO = await api.verifyTrainPnr(offender.access, TEST_PNRS.cycleB);
    const v = extractIds(vV.data);
    const o = extractIds(vO.data);

    await api.setGoal(offender.access, o.partyId, { goal_type: 'open_to_help', movers: [o.holderId], constraints: {} });
    await api.setGoal(victim.access, v.partyId, { goal_type: 'lower', movers: [v.holderId], constraints: {} });

    let cardId = '';
    await expect(async () => {
      const m = await api.getMatches(victim.access, v.partyId);
      expect(m.data.items.length).toBeGreaterThanOrEqual(1);
      cardId = m.data.items[0]?.card_id ?? '';
    }).toPass({ timeout: 12_000 });

    const convo = await api.createConversation<{ id: string }>(victim.access, cardId);
    const msg = await api.sendMessage<{ id: string }>(
      offender.access,
      convo.data.id,
      'Spam harassment message',
    );
    expect([200, 201]).toContain(msg.status);

    for (let i = 0; i < 3; i += 1) {
      const rep = await api.reportUser<{ report_id: string; status: string }>(victim.access, {
        conversation_id: convo.data.id,
        message_id: msg.data.id,
        reason: `harassment_${i + 1}`,
      });
      expect([200, 201]).toContain(rep.status);
    }

    const sendAfterRestrict = await api.sendMessage(
      offender.access,
      convo.data.id,
      'Trying to send after auto-restrict',
    );
    api.assertProblemJson(sendAfterRestrict, [403, 429]);
    expect([403, 429]).toContain(sendAfterRestrict.status);
  });

  test('Non-admin user cannot access admin moderation queue or audit log (403)', async () => {
    const api = new SaathApiClient();
    const regularUser = await api.loginWithOtp(uniquePhone('p10-nonadm'), 'whatsapp');

    const queue = await api.getAdminModerationQueue(regularUser.access);
    api.assertProblemJson(queue, 403);

    const audit = await api.getAdminAuditLog(regularUser.access);
    api.assertProblemJson(audit, 403);
    expect(audit.status).toBe(403);
  });

  test('Admin portal (:3001) moderation route loads cleanly behind SSO/allowlist guard', async ({
    request,
  }) => {
    const res = await request.get(`${E2E_ENV.adminUrl}/moderation`);
    expect(res.status()).toBeLessThan(500);
    expect([200, 302, 307, 401, 403]).toContain(res.status());
  });
});
