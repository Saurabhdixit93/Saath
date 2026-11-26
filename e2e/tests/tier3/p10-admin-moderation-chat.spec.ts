import { test, expect } from '../../fixtures/multi-browser.js';
import { SaathApiClient } from '../../helpers/api.js';
import { E2E_ENV, futureDateIso, uniquePhone, uniquePnr } from '../../helpers/env.js';

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Expected array for ${label}`);
  }
  return value;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Expected object for ${label}`);
  }
  return value as Record<string, unknown>;
}

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
  test('3 distinct reporter accounts auto-restrict offending sender and admin moderation hide writes audit_log', async () => {
    const api = new SaathApiClient();
    const travelDate = futureDateIso(22);
    const offender = await api.loginWithOtp(uniquePhone('p10-off'), 'whatsapp');

    const vO = await api.verifyTrainSms(
      offender.access,
      `IRCTC PNR:${uniquePnr('p10-offender')},TRN:12951,DOJ:${travelDate},CLS:3A,B3 1 LB,NDLS-MMCT`,
    );
    expect(vO.ok).toBe(true);
    const o = extractIds(vO.data);
    await api.setGoal(offender.access, o.partyId, {
      goal_type: 'open_to_help',
      movers: [o.holderId],
      preferred_seats: [],
      constraints: { women_only: false, no_middle: false, same_coach_only: false, verified_only: false },
      standing_offer: { give_to: 'anyone' },
    });

    const reporters = [
      { seed: 'p10-rep-1', seat: '3', reason: 'abuse' },
      { seed: 'p10-rep-2', seat: '6', reason: 'scam' },
      { seed: 'p10-rep-3', seat: '11', reason: 'harassment' },
    ] as const;

    let firstReportId = '';
    let lastConversationId = '';

    for (const spec of reporters) {
      const repUser = await api.loginWithOtp(uniquePhone(spec.seed), 'whatsapp');
      const vR = await api.verifyTrainSms(
        repUser.access,
        `IRCTC PNR:${uniquePnr(spec.seed)},TRN:12951,DOJ:${travelDate},CLS:3A,B3 ${spec.seat} UB,NDLS-MMCT`,
      );
      expect(vR.ok).toBe(true);
      const r = extractIds(vR.data);

      await api.setGoal(repUser.access, r.partyId, {
        goal_type: 'lower',
        movers: [r.holderId],
        preferred_seats: [],
        constraints: { women_only: false, no_middle: false, same_coach_only: false, verified_only: false },
      });

      let cardId = '';
      await expect(async () => {
        const m = await api.getMatches(repUser.access, r.partyId, 'pair');
        expect(m.status).toBe(200);
        expect(m.data.items.length).toBeGreaterThanOrEqual(1);
        cardId = m.data.items[0]?.card_id ?? '';
        expect(cardId.length).toBeGreaterThan(0);
      }).toPass({ timeout: 12_000, intervals: [500, 1000, 1500] });

      const convo = await api.createConversation<{ id: string }>(repUser.access, cardId);
      expect([200, 201]).toContain(convo.status);
      lastConversationId = convo.data.id;

      const msg = await api.sendMessage<{ id: string }>(
        offender.access,
        convo.data.id,
        `Spam harassment message (${spec.reason})`,
      );
      expect([200, 201]).toContain(msg.status);

      const rep = await api.reportUser<{ report_id: string; status: string }>(repUser.access, {
        conversation_id: convo.data.id,
        message_id: msg.data.id,
        reason: spec.reason,
      });
      expect([200, 201]).toContain(rep.status);
      expect(typeof rep.data.report_id).toBe('string');
      if (!firstReportId) {
        firstReportId = rep.data.report_id;
      }
    }

    const sendAfterRestrict = await api.sendMessage(
      offender.access,
      lastConversationId,
      'Trying to send after auto-restrict',
    );
    api.assertProblemJson(sendAfterRestrict, [403, 429]);
    expect([403, 429]).toContain(sendAfterRestrict.status);

    // Admin portal moderation queue + hide action + audit_log verification
    const adminSession = await api.createAdminSession(E2E_ENV.adminTestEmail);
    expect([200, 201]).toContain(adminSession.status);
    const adminToken = adminSession.data.access ?? adminSession.data.token ?? '';
    expect(adminToken.length).toBeGreaterThan(0);

    const auditBefore = await api.getAdminAuditLog<{
      total?: number;
      items?: unknown[];
      entries?: unknown[];
    }>(adminToken);
    expect(auditBefore.status).toBe(200);
    const beforeCount =
      typeof auditBefore.data.total === 'number'
        ? auditBefore.data.total
        : asArray(
            auditBefore.data.items ?? auditBefore.data.entries ?? auditBefore.data,
            'audit before',
          ).length;

    const queue = await api.getAdminModerationQueue<{ items?: unknown[] }>(adminToken, {
      status: 'open',
    });
    expect(queue.status).toBe(200);
    const queueItems = asArray(queue.data.items, 'moderation queue items');
    expect(
      queueItems.some((item) => {
        const rec = asRecord(item, 'queue item');
        return rec.id === firstReportId || rec.report_id === firstReportId;
      }),
    ).toBe(true);

    const hideRes = await api.actOnModeration(adminToken, firstReportId, 'hide', 'P10 hide action');
    expect(hideRes.status).toBe(200);

    const auditAfter = await api.getAdminAuditLog<{
      total?: number;
      items?: unknown[];
      entries?: unknown[];
    }>(adminToken, { limit: 20 });
    expect(auditAfter.status).toBe(200);
    const afterItems = asArray(
      auditAfter.data.items ?? auditAfter.data.entries ?? auditAfter.data,
      'audit after',
    );
    const afterCount =
      typeof auditAfter.data.total === 'number' ? auditAfter.data.total : afterItems.length;
    expect(afterCount).toBeGreaterThan(beforeCount);

    const actionsText = afterItems
      .map((entry) => String(asRecord(entry, 'audit entry').action ?? ''))
      .join(' ');
    expect(actionsText).toMatch(/moderation|queue/i);
    expect(actionsText).toMatch(/hide/i);
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
