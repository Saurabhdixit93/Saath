import { test, expect } from '../../fixtures/multi-browser.js';
import { SaathApiClient, type MatchCardDto } from '../../helpers/api.js';
import { TEST_PNRS, uniquePhone } from '../../helpers/env.js';
import { SaathSseClient, SaathWsClient } from '../../helpers/ws-sse.js';

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Expected object for ${label}`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Expected array for ${label}`);
  }
  return value;
}

function getString(obj: Record<string, unknown>, key: string): string {
  const val = obj[key];
  if (typeof val !== 'string' || val.length === 0) {
    throw new Error(`Expected string "${key}"`);
  }
  return val;
}

function getNumber(obj: Record<string, unknown>, key: string): number {
  const val = obj[key];
  if (typeof val !== 'number') {
    throw new Error(`Expected number "${key}"`);
  }
  return val;
}

test.describe('F26: WebSocket /v1/ws & SSE Fallback @tier1', () => {
  test('WebSocket /v1/ws authenticates via first-frame JWT and emits ready', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone(26_001));
    const ws = new SaathWsClient();

    try {
      await expect(ws.connectAndAuth(auth.access)).resolves.toBeUndefined();
      ws.sendPing();
    } finally {
      await ws.close();
    }
  });

  test('WS receives match.updated live when GoalChanged triggers recompute', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone(26_002));
    const verify = await api.verifyTrainPnr(auth.access, TEST_PNRS.cycleA);
    const journeyId = getString(asRecord(verify.data.journey, 'journey'), 'id');
    const hub = await api.getJourney(auth.access, journeyId);
    const partyId = getString(asRecord(hub.data.party, 'party'), 'id');
    const holderId = getString(asRecord(asArray(hub.data.seat_holders, 'sh')[0], 'sh0'), 'id');

    const ws = new SaathWsClient();
    try {
      await ws.connectAndAuth(auth.access);
      const waitMatch = ws.waitForEvent(
        'match.updated',
        (evt) => evt.party_id === partyId,
        15_000,
      );

      await api.setGoal(auth.access, partyId, {
        goal_type: 'lower',
        movers: [holderId],
        preferred_seats: [],
        constraints: {
          women_only: false,
          no_middle: false,
          same_coach_only: false,
          verified_only: false,
        },
      });

      const evt = await waitMatch;
      expect(evt.type).toBe('match.updated');
      expect(evt.party_id).toBe(partyId);
    } finally {
      await ws.close();
    }
  });

  test('WS receives swap.updated live when partner accepts swap proposal', async () => {
    const apiA = new SaathApiClient();
    const apiB = new SaathApiClient();
    const authA = await apiA.loginWithOtp(uniquePhone(26_003));
    const authB = await apiB.loginWithOtp(uniquePhone(26_004));

    const vA = await apiA.verifyTrainPnr(authA.access, TEST_PNRS.cycleA);
    const vB = await apiB.verifyTrainPnr(authB.access, TEST_PNRS.cycleB);
    const hubA = await apiA.getJourney(authA.access, getString(asRecord(vA.data.journey, 'jA'), 'id'));
    const hubB = await apiB.getJourney(authB.access, getString(asRecord(vB.data.journey, 'jB'), 'id'));
    const pA = getString(asRecord(hubA.data.party, 'pA'), 'id');
    const pB = getString(asRecord(hubB.data.party, 'pB'), 'id');

    await apiA.setGoal(authA.access, pA, {
      goal_type: 'lower',
      movers: [getString(asRecord(asArray(hubA.data.seat_holders, 'hA')[0], 'hA0'), 'id')],
      preferred_seats: [],
      constraints: { women_only: false, no_middle: false, same_coach_only: false, verified_only: false },
    });
    await apiB.setGoal(authB.access, pB, {
      goal_type: 'open_to_help',
      movers: [getString(asRecord(asArray(hubB.data.seat_holders, 'hB')[0], 'hB0'), 'id')],
      preferred_seats: [],
      constraints: { women_only: false, no_middle: false, same_coach_only: false, verified_only: false },
      standing_offer: { give_to: 'anyone' },
    });

    let card: MatchCardDto | undefined;
    await expect(async () => {
      const matches = await apiA.getMatches(authA.access, pA, 'pair');
      expect(matches.status).toBe(200);
      expect(matches.data.items.length).toBeGreaterThanOrEqual(1);
      card = matches.data.items[0];
    }).toPass({ timeout: 12_000, intervals: [500, 1000, 1500] });
    if (!card) {
      throw new Error('Expected match card');
    }
    const swapRes = await apiA.createSwap(authA.access, card.card_id);
    const swapId = getString(swapRes.data, 'id');
    const a1 = await apiA.acceptSwap(authA.access, swapId, getNumber(swapRes.data, 'version'));

    const wsA = new SaathWsClient();
    try {
      await wsA.connectAndAuth(authA.access);
      const waitSwap = wsA.waitForEvent(
        'swap.updated',
        (evt) => evt.swap_id === swapId && evt.status === 'confirmed',
        15_000,
      );

      await apiB.acceptSwap(authB.access, swapId, getNumber(a1.data, 'version'));
      const evt = await waitSwap;
      expect(evt.status).toBe('confirmed');
    } finally {
      await wsA.close();
    }
  });

  test('WS receives message.new live on masked chat message', async () => {
    const apiA = new SaathApiClient();
    const apiB = new SaathApiClient();
    const authA = await apiA.loginWithOtp(uniquePhone(26_005));
    const authB = await apiB.loginWithOtp(uniquePhone(26_006));

    const vA = await apiA.verifyTrainPnr(authA.access, TEST_PNRS.cycleA);
    const vB = await apiB.verifyTrainPnr(authB.access, TEST_PNRS.cycleB);
    const hubA = await apiA.getJourney(authA.access, getString(asRecord(vA.data.journey, 'jA'), 'id'));
    const hubB = await apiB.getJourney(authB.access, getString(asRecord(vB.data.journey, 'jB'), 'id'));
    const pA = getString(asRecord(hubA.data.party, 'pA'), 'id');
    const pB = getString(asRecord(hubB.data.party, 'pB'), 'id');

    await apiA.setGoal(authA.access, pA, {
      goal_type: 'lower',
      movers: [getString(asRecord(asArray(hubA.data.seat_holders, 'hA')[0], 'hA0'), 'id')],
      preferred_seats: [],
      constraints: { women_only: false, no_middle: false, same_coach_only: false, verified_only: false },
    });
    await apiB.setGoal(authB.access, pB, {
      goal_type: 'open_to_help',
      movers: [getString(asRecord(asArray(hubB.data.seat_holders, 'hB')[0], 'hB0'), 'id')],
      preferred_seats: [],
      constraints: { women_only: false, no_middle: false, same_coach_only: false, verified_only: false },
      standing_offer: { give_to: 'anyone' },
    });

    let card: MatchCardDto | undefined;
    await expect(async () => {
      const matches = await apiA.getMatches(authA.access, pA, 'pair');
      expect(matches.status).toBe(200);
      expect(matches.data.items.length).toBeGreaterThanOrEqual(1);
      card = matches.data.items[0];
    }).toPass({ timeout: 12_000, intervals: [500, 1000, 1500] });
    if (!card) {
      throw new Error('Expected match card');
    }
    const convo = await apiA.createConversation(authA.access, card.card_id);
    const convoId = getString(convo.data, 'id');

    const wsB = new SaathWsClient();
    try {
      await wsB.connectAndAuth(authB.access);
      const waitMsg = wsB.waitForEvent(
        'message.new',
        (evt) => evt.conversation_id === convoId,
        15_000,
      );

      await apiA.sendMessage(authA.access, convoId, 'Hello, open to swap after Kanpur?');
      const evt = await waitMsg;
      expect(evt.conversation_id).toBe(convoId);
    } finally {
      await wsB.close();
    }
  });

  test('SSE GET /v1/events/stream delivers live match.updated fallback events', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone(26_007));
    const verify = await api.verifyTrainPnr(auth.access, TEST_PNRS.cycleA);
    const journeyId = getString(asRecord(verify.data.journey, 'journey'), 'id');
    const hub = await api.getJourney(auth.access, journeyId);
    const partyId = getString(asRecord(hub.data.party, 'party'), 'id');
    const holderId = getString(asRecord(asArray(hub.data.seat_holders, 'sh')[0], 'sh0'), 'id');

    const sse = new SaathSseClient();
    try {
      await sse.connect(auth.access);
      expect(sse.status).toBe(200);
      const waitMatch = sse.waitForEvent(
        'match.updated',
        (evt) => evt.party_id === partyId,
        15_000,
      );

      await api.setGoal(auth.access, partyId, {
        goal_type: 'upper',
        movers: [holderId],
        preferred_seats: [],
        constraints: { women_only: false, no_middle: false, same_coach_only: false, verified_only: false },
      });

      const evt = await waitMatch;
      expect(evt.type).toBe('match.updated');
    } finally {
      sse.close();
    }
  });
});
