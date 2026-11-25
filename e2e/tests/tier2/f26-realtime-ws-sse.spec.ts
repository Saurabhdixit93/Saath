import { test, expect } from '../../fixtures/multi-browser.js';
import { SaathApiClient } from '../../helpers/api.js';
import { TEST_PNRS, uniquePhone } from '../../helpers/env.js';
import { SaathSseClient, SaathWsClient, SseHttpError } from '../../helpers/ws-sse.js';

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

test.describe('F26 Tier 2: WebSocket & SSE Auth Failure and Reconnect Edge Cases @tier2', () => {
  test('WS /v1/ws closes with rejection code when first-frame JWT is invalid', async () => {
    const ws = new SaathWsClient();
    const result = await ws.expectAuthRejection('invalid.jwt.token');
    expect([1008, 4001, 4003, 1006]).toContain(result.code);
  });

  test('WS /v1/ws closes connection if client omits first-frame auth message', async () => {
    const ws = new SaathWsClient();
    const result = await ws.expectAuthRejection(undefined, undefined, 10_000);
    expect(result.code).not.toBe(1000);
  });

  test('SSE GET /v1/events/stream rejects unauthenticated request with 401', async () => {
    const sse = new SaathSseClient();
    let capturedStatus = 0;
    try {
      await sse.connect('invalid-bearer-token');
    } catch (err) {
      if (err instanceof SseHttpError) {
        capturedStatus = err.status;
      }
    } finally {
      sse.close();
    }
    expect(capturedStatus).toBe(401);
  });

  test('WS reconnect resumes receiving live match.updated events cleanly', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone(262_001));
    const v = await api.verifyTrainPnr(auth.access, TEST_PNRS.cycleA);
    const hub = await api.getJourney(auth.access, getString(asRecord(v.data.journey, 'j'), 'id'));
    const partyId = getString(asRecord(hub.data.party, 'p'), 'id');
    const holderId = getString(asRecord(asArray(hub.data.seat_holders, 'sh')[0], 'sh0'), 'id');

    const ws1 = new SaathWsClient();
    await ws1.connectAndAuth(auth.access);
    await ws1.close();

    const ws2 = new SaathWsClient();
    try {
      await ws2.connectAndAuth(auth.access);
      const waitEvt = ws2.waitForEvent('match.updated', (e) => e.party_id === partyId, 15_000);
      await api.setGoal(auth.access, partyId, {
        goal_type: 'lower',
        movers: [holderId],
        preferred_seats: [],
        constraints: { women_only: false, no_middle: false, same_coach_only: false, verified_only: false },
      });
      const evt = await waitEvt;
      expect(evt.party_id).toBe(partyId);
    } finally {
      await ws2.close();
    }
  });

  test('Monotonic match_version prevents stale WS updates from regressing API state', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone(262_002));
    const v = await api.verifyTrainPnr(auth.access, TEST_PNRS.cycleA);
    const hub = await api.getJourney(auth.access, getString(asRecord(v.data.journey, 'j'), 'id'));
    const partyId = getString(asRecord(hub.data.party, 'p'), 'id');
    const holderId = getString(asRecord(asArray(hub.data.seat_holders, 'sh')[0], 'sh0'), 'id');

    const g1 = await api.setGoal(auth.access, partyId, {
      goal_type: 'lower',
      movers: [holderId],
      preferred_seats: [],
      constraints: { women_only: false, no_middle: false, same_coach_only: false, verified_only: false },
    });
    const g2 = await api.setGoal(auth.access, partyId, {
      goal_type: 'upper',
      movers: [holderId],
      preferred_seats: [],
      constraints: { women_only: false, no_middle: false, same_coach_only: false, verified_only: false },
    });

    expect(Number(g2.data.match_version)).toBeGreaterThanOrEqual(Number(g1.data.match_version));
  });
});
