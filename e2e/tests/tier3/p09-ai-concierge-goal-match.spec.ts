import { test, expect } from '../../fixtures/multi-browser.js';
import { SaathApiClient } from '../../helpers/api.js';
import { TEST_PNRS, uniquePhone } from '../../helpers/env.js';

function extractIds(payload: Record<string, unknown>): {
  journeyId: string;
  partyId: string;
  holderId: string;
} {
  const journey = payload.journey as { id?: string } | undefined;
  const party = payload.party as { id?: string } | undefined;
  const holders = payload.seat_holders as Array<{ id: string }> | undefined;
  if (!journey?.id || !party?.id || !holders?.[0]?.id) {
    throw new Error(`Missing IDs in payload: ${JSON.stringify(payload)}`);
  }
  return { journeyId: journey.id, partyId: party.id, holderId: holders[0].id };
}

test.describe('@tier3 P09: AI Concierge Goal Proposal -> User Confirm -> Match Recompute', () => {
  test('AI Concierge SSE proposes structured goal without auto-submitting until user confirms', async () => {
    const api = new SaathApiClient();
    const user = await api.loginWithOtp(uniquePhone('p09-ai-goal'), 'whatsapp');
    const v = await api.verifyTrainPnr(user.access, TEST_PNRS.cycleA);
    const { journeyId, partyId, holderId } = extractIds(v.data);

    const sseRes = await api.conciergeStream(
      user.access,
      journeyId,
      'My senior mother needs a lower berth in the same coach please',
    );
    expect(sseRes.status).toBe(200);
    expect(sseRes.events.length).toBeGreaterThanOrEqual(1);

    // Must not auto-mutate goal before user explicit confirmation
    const hubBefore = await api.getJourney<{ goal?: unknown }>(user.access, journeyId);
    expect(hubBefore.data.goal ?? null).toBeNull();

    // User explicitly submits confirmed goal -> triggers matching recompute
    const setRes = await api.setGoal<{ goal?: { goal_type: string }; match_version: number }>(
      user.access,
      partyId,
      {
        goal_type: 'lower',
        movers: [holderId],
        constraints: { same_coach_only: true },
      },
    );
    expect([200, 201]).toContain(setRes.status);
    expect(setRes.data.goal?.goal_type).toBe('lower');
  });

  test('AI Concierge response never echoes raw PNR or user phone number', async () => {
    const api = new SaathApiClient();
    const phone = uniquePhone('p09-nopii');
    const user = await api.loginWithOtp(phone, 'whatsapp');
    const v = await api.verifyTrainPnr(user.access, TEST_PNRS.rajdhani3A);
    const { journeyId } = extractIds(v.data);

    const sseRes = await api.conciergeStream(
      user.access,
      journeyId,
      'Explain my swap options safely',
    );
    expect(sseRes.status).toBe(200);
    expect(sseRes.rawText).not.toContain(TEST_PNRS.rajdhani3A);
    expect(sseRes.rawText).not.toContain(phone);
  });

  test('AI draft-request generates <=300 char polite outreach message in en and hi for matched card', async () => {
    const api = new SaathApiClient();
    const uA = await api.loginWithOtp(uniquePhone('p09-dr-a'), 'whatsapp');
    const uB = await api.loginWithOtp(uniquePhone('p09-dr-b'), 'whatsapp');
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

    const draftEn = await api.draftRequest(uA.access, cardId, { tone: 'polite', lang: 'en' });
    expect(draftEn.status).toBe(200);
    expect(draftEn.data.text.length).toBeGreaterThan(5);
    expect(draftEn.data.text.length).toBeLessThanOrEqual(300);

    const draftHi = await api.draftRequest(uA.access, cardId, { tone: 'polite', lang: 'hi' });
    expect(draftHi.status).toBe(200);
    expect(draftHi.data.text.length).toBeGreaterThan(5);
    expect(draftHi.data.text.length).toBeLessThanOrEqual(300);
  });
});
