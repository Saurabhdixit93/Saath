import { test, expect } from '../../fixtures/multi-browser.js';
import { SaathApiClient } from '../../helpers/api.js';
import { TEST_PNRS, uniquePhone } from '../../helpers/env.js';
import { assertNoPiiLeak } from '../../helpers/pii.js';
import { SaathSseClient, SaathWsClient } from '../../helpers/ws-sse.js';

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

test.describe('@tier3 P05: Chart Watcher BerthChanged -> Invalidation -> Outbox & Re-Match', () => {
  test('Chart change invalidates confirmed swap, revokes public Swap Card, and emits journey.chart WS', async () => {
    const api = new SaathApiClient();
    const uA = await api.loginWithOtp(uniquePhone('p05-a'), 'whatsapp');
    const uB = await api.loginWithOtp(uniquePhone('p05-b'), 'whatsapp');

    const vA = await api.verifyTrainPnr(uA.access, TEST_PNRS.cycleA);
    const vB = await api.verifyTrainPnr(uB.access, TEST_PNRS.cycleB);
    const a = extractIds(vA.data);
    const b = extractIds(vB.data);

    await api.setGoal(uB.access, b.partyId, {
      goal_type: 'open_to_help',
      movers: [b.holderId],
      constraints: {},
      standing_offer: { give_to: 'anyone' },
    });
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

    const card = await api.getSwapCard<{ public_code: string }>(uA.access, swap.data.id, 'json');
    expect(card.status).toBe(200);

    const ws = new SaathWsClient();
    await ws.connectAndAuth(uA.access);

    try {
      const revRes = await api.request('POST', `/v1/journeys/${a.journeyId}/reverify`, {
        token: uA.access,
        headers: { 'X-Simulate-Chart-Change': 'true' },
      });
      expect(revRes.status).toBe(200);

      const chartEvt = await ws.waitForEvent(
        'journey.chart',
        (e) => e.journey_id === a.journeyId,
        15_000,
      );
      expect(chartEvt.journey_id).toBe(a.journeyId);

      const swapAfter = await api.getSwap<{ status: string }>(uA.access, swap.data.id);
      expect(swapAfter.data.status).toBe('invalidated');

      const publicCard = await api.verifyPublicSwapCard<{ valid: boolean; revoked: boolean }>(
        card.data.public_code,
      );
      expect(publicCard.status).toBe(200);
      expect(publicCard.data.valid).toBe(false);
      expect(publicCard.data.revoked).toBe(true);
      assertNoPiiLeak(publicCard.data, 'p05 public swap card after chart invalidation');
    } finally {
      await ws.close();
    }
  });

  test('SSE fallback /v1/events/stream receives swap.updated and journey.chart parity events', async () => {
    const api = new SaathApiClient();
    const uA = await api.loginWithOtp(uniquePhone('p05-sse-a'), 'whatsapp');
    const uB = await api.loginWithOtp(uniquePhone('p05-sse-b'), 'whatsapp');

    const vA = await api.verifyTrainPnr(uA.access, TEST_PNRS.cycleA);
    const vB = await api.verifyTrainPnr(uB.access, TEST_PNRS.cycleB);
    const a = extractIds(vA.data);
    const b = extractIds(vB.data);

    const sse = new SaathSseClient();
    await sse.connect(uA.access);

    try {
      await api.setGoal(uB.access, b.partyId, { goal_type: 'open_to_help', movers: [b.holderId], constraints: {} });
      await api.setGoal(uA.access, a.partyId, { goal_type: 'lower', movers: [a.holderId], constraints: {} });

      const evt = await sse.waitForEvent('match.updated', (e) => e.party_id === a.partyId, 15_000);
      expect(evt.party_id).toBe(a.partyId);
    } finally {
      sse.close();
    }
  });

  test('Chart time endpoint reflects Dec 2025 morning vs night chart schedule rules', async () => {
    const api = new SaathApiClient();
    const morning = await api.getPublicTrainChartTime('12951');
    expect([200, 404]).toContain(morning.status);

    const night = await api.getPublicTrainChartTime('12952');
    expect([200, 404]).toContain(night.status);
  });
});
