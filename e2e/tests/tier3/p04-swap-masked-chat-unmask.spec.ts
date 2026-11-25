import { test, expect } from '../../fixtures/multi-browser.js';
import { SaathApiClient } from '../../helpers/api.js';
import { buildBcbpString } from '../../helpers/bcbp.js';
import { futureDateIso, uniquePhone } from '../../helpers/env.js';
import { assertNoPiiLeak } from '../../helpers/pii.js';
import { SaathWsClient } from '../../helpers/ws-sse.js';

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

test.describe('@tier3 P04: Flight BCBP -> Masked Chat Redaction -> Mutual Accept Unmask', () => {
  test('Pre-accept chat masks aliases and redacts obfuscated phone/UPI until mutual accept', async () => {
    const api = new SaathApiClient();
    const travelDate = futureDateIso(18);
    const uA = await api.loginWithOtp(uniquePhone('p04-a'), 'whatsapp');
    const uB = await api.loginWithOtp(uniquePhone('p04-b'), 'whatsapp');

    const vA = await api.verifyFlightBcbp(
      uA.access,
      buildBcbpString({
        pnr: 'P4FL1A',
        from: 'DEL',
        to: 'BOM',
        carrier: '6E',
        flightNo: '2134',
        julianDate: travelDate,
        seatNo: '14B',
      }),
    );
    const vB = await api.verifyFlightBcbp(
      uB.access,
      buildBcbpString({
        pnr: 'P4FL2B',
        from: 'DEL',
        to: 'BOM',
        carrier: '6E',
        flightNo: '2134',
        julianDate: travelDate,
        seatNo: '14A',
      }),
    );
    const a = extractIds(vA.data);
    const b = extractIds(vB.data);

    await api.setGoal(uB.access, b.partyId, { goal_type: 'aisle', movers: [b.holderId], constraints: {} });
    await api.setGoal(uA.access, a.partyId, { goal_type: 'window', movers: [a.holderId], constraints: {} });

    let cardId = '';
    await expect(async () => {
      const m = await api.getMatches(uA.access, a.partyId);
      expect(m.data.items.length).toBeGreaterThanOrEqual(1);
      cardId = m.data.items[0]?.card_id ?? '';
    }).toPass({ timeout: 12_000 });

    const convoRes = await api.createConversation<{ id: string; unmasked: boolean }>(
      uA.access,
      cardId,
    );
    expect([200, 201]).toContain(convoRes.status);
    expect(convoRes.data.unmasked).toBe(false);

    const redactedMsg = await api.sendMessage<{ body: string; moderation: string }>(
      uA.access,
      convoRes.data.id,
      'Call me at 98765 43210 or paytm neha@okicici',
    );
    expect([200, 201]).toContain(redactedMsg.status);
    expect(redactedMsg.data.moderation).toBe('redacted');
    expect(redactedMsg.data.body).toContain('•••');
    expect(redactedMsg.data.body).not.toContain('98765');
    expect(redactedMsg.data.body).not.toContain('neha@okicici');

    const msgsPre = await api.getMessages(uB.access, convoRes.data.id);
    assertNoPiiLeak(msgsPre.data, 'p04-pre-accept-chat', ['9876543210', 'neha@okicici']);

    const swap = await api.createSwap<{ id: string; version: number }>(uA.access, cardId);
    const accA = await api.acceptSwap<{ version: number }>(uA.access, swap.data.id, swap.data.version);
    const accB = await api.acceptSwap<{ status: string }>(uB.access, swap.data.id, accA.data.version);
    expect(accB.data.status).toBe('confirmed');

    const convosAfter = await api.listConversations(uA.access);
    const updatedConvo = convosAfter.data.items.find((c) => c.id === convoRes.data.id);
    expect(updatedConvo?.unmasked).toBe(true);
  });

  test('Mutual accept delivers live swap.updated event over WS and reveals Swap Card', async () => {
    const api = new SaathApiClient();
    const travelDate = futureDateIso(19);
    const uA = await api.loginWithOtp(uniquePhone('p04-ws-a'), 'whatsapp');
    const uB = await api.loginWithOtp(uniquePhone('p04-ws-b'), 'whatsapp');

    const vA = await api.verifyFlightBcbp(
      uA.access,
      buildBcbpString({
        pnr: 'P4WS1A',
        from: 'DEL',
        to: 'BOM',
        carrier: '6E',
        flightNo: '2134',
        julianDate: travelDate,
        seatNo: '15B',
      }),
    );
    const vB = await api.verifyFlightBcbp(
      uB.access,
      buildBcbpString({
        pnr: 'P4WS2B',
        from: 'DEL',
        to: 'BOM',
        carrier: '6E',
        flightNo: '2134',
        julianDate: travelDate,
        seatNo: '15A',
      }),
    );
    const a = extractIds(vA.data);
    const b = extractIds(vB.data);

    await api.setGoal(uB.access, b.partyId, { goal_type: 'open_to_help', movers: [b.holderId], constraints: {} });
    await api.setGoal(uA.access, a.partyId, { goal_type: 'window', movers: [a.holderId], constraints: {} });

    let cardId = '';
    await expect(async () => {
      const m = await api.getMatches(uA.access, a.partyId);
      expect(m.data.items.length).toBeGreaterThanOrEqual(1);
      cardId = m.data.items[0]?.card_id ?? '';
    }).toPass({ timeout: 12_000 });

    const wsA = new SaathWsClient();
    await wsA.connectAndAuth(uA.access);

    try {
      const swap = await api.createSwap<{ id: string; version: number }>(uA.access, cardId);
      const accA = await api.acceptSwap<{ version: number }>(uA.access, swap.data.id, swap.data.version);
      await api.acceptSwap(uB.access, swap.data.id, accA.data.version);

      const wsEvt = await wsA.waitForEvent(
        'swap.updated',
        (e) => e.swap_id === swap.data.id && e.status === 'confirmed',
        15_000,
      );
      expect(wsEvt.status).toBe('confirmed');

      const card = await api.getSwapCard(uA.access, swap.data.id, 'json');
      expect(card.status).toBe(200);
      expect(card.data.public_code).toBeTruthy();
    } finally {
      await wsA.close();
    }
  });

  test('Post-accept unmasked conversation allows normal coordination messages without redaction', async () => {
    const api = new SaathApiClient();
    const travelDate = futureDateIso(20);
    const uA = await api.loginWithOtp(uniquePhone('p04-unm-a'), 'whatsapp');
    const uB = await api.loginWithOtp(uniquePhone('p04-unm-b'), 'whatsapp');

    const vA = await api.verifyFlightBcbp(
      uA.access,
      buildBcbpString({
        pnr: 'P4UM1A',
        from: 'DEL',
        to: 'BOM',
        carrier: '6E',
        flightNo: '2134',
        julianDate: travelDate,
        seatNo: '16B',
      }),
    );
    const vB = await api.verifyFlightBcbp(
      uB.access,
      buildBcbpString({
        pnr: 'P4UM2B',
        from: 'DEL',
        to: 'BOM',
        carrier: '6E',
        flightNo: '2134',
        julianDate: travelDate,
        seatNo: '16A',
      }),
    );
    const a = extractIds(vA.data);
    const b = extractIds(vB.data);

    await api.setGoal(uB.access, b.partyId, { goal_type: 'open_to_help', movers: [b.holderId], constraints: {} });
    await api.setGoal(uA.access, a.partyId, { goal_type: 'window', movers: [a.holderId], constraints: {} });

    let cardId = '';
    await expect(async () => {
      const m = await api.getMatches(uA.access, a.partyId);
      expect(m.data.items.length).toBeGreaterThanOrEqual(1);
      cardId = m.data.items[0]?.card_id ?? '';
    }).toPass({ timeout: 12_000 });

    const convo = await api.createConversation<{ id: string }>(uA.access, cardId);
    const swap = await api.createSwap<{ id: string; version: number }>(uA.access, cardId);
    const accA = await api.acceptSwap<{ version: number }>(uA.access, swap.data.id, swap.data.version);
    await api.acceptSwap(uB.access, swap.data.id, accA.data.version);

    const postMsg = await api.sendMessage<{ body: string; moderation: string }>(
      uA.access,
      convo.data.id,
      'See you near gate 14A at boarding! Reach me on 9876543210.',
    );
    expect([200, 201]).toContain(postMsg.status);
    expect(postMsg.data.moderation).toBe('ok');
    expect(postMsg.data.body).toContain('9876543210');
  });
});
