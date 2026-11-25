import { test, expect, injectAuthSession } from '../../fixtures/multi-browser.js';
import { type MatchCardDto } from '../../helpers/api.js';
import { TEST_PNRS, uniquePhone } from '../../helpers/env.js';
import { SaathSseClient } from '../../helpers/ws-sse.js';

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

test.describe('S04: Chart Change Auto-Invalidation via SSE Fallback @tier4', () => {
  test('Browser with WebSocket blocked receives live journey.chart & swap.updated over SSE without reload, old /v/[code] revoked, and re-match appears', async ({
    createIsolatedPassenger,
  }) => {
    const userA = await createIsolatedPassenger('sse-userA');
    const userB = await createIsolatedPassenger('userB');
    const userC = await createIsolatedPassenger('userC');

    const authA = await userA.api.loginWithOtp(uniquePhone(404_001));
    const authB = await userB.api.loginWithOtp(uniquePhone(404_002));
    const authC = await userC.api.loginWithOtp(uniquePhone(404_003));

    const vA = await userA.api.verifyTrainPnr(authA.access, TEST_PNRS.cycleA);
    const vB = await userB.api.verifyTrainPnr(authB.access, TEST_PNRS.cycleB);
    const jAId = getString(asRecord(vA.data.journey, 'jA'), 'id');
    const jBId = getString(asRecord(vB.data.journey, 'jB'), 'id');

    const hubA = await userA.api.getJourney(authA.access, jAId);
    const hubB = await userB.api.getJourney(authB.access, jBId);
    const pAId = getString(asRecord(hubA.data.party, 'pA'), 'id');
    const pBId = getString(asRecord(hubB.data.party, 'pB'), 'id');

    await userA.api.setGoal(authA.access, pAId, {
      goal_type: 'lower',
      movers: [getString(asRecord(asArray(hubA.data.seat_holders, 'hA')[0], 'hA0'), 'id')],
      preferred_seats: [],
      constraints: { women_only: false, no_middle: false, same_coach_only: false, verified_only: false },
    });
    await userB.api.setGoal(authB.access, pBId, {
      goal_type: 'open_to_help',
      movers: [getString(asRecord(asArray(hubB.data.seat_holders, 'hB')[0], 'hB0'), 'id')],
      preferred_seats: [],
      constraints: { women_only: false, no_middle: false, same_coach_only: false, verified_only: false },
      standing_offer: { give_to: 'anyone' },
    });

    let card1: MatchCardDto | undefined;
    let initialMatchVersion = 0;
    await expect(async () => {
      const matches1 = await userA.api.getMatches(authA.access, pAId, 'pair');
      expect(matches1.status).toBe(200);
      expect(matches1.data.items.length).toBeGreaterThanOrEqual(1);
      card1 = matches1.data.items[0];
      initialMatchVersion = matches1.data.match_version;
    }).toPass({ timeout: 12_000, intervals: [500, 1000, 1500] });
    if (!card1) {
      throw new Error('Expected initial pair match');
    }
    const swapRes = await userA.api.createSwap(authA.access, card1.card_id);
    const swapId = getString(swapRes.data, 'id');
    const a1 = await userA.api.acceptSwap(authA.access, swapId, Number(swapRes.data.version ?? 0));
    await userB.api.acceptSwap(authB.access, swapId, Number(a1.data.version ?? 1));

    const swapCard = await userA.api.getSwapCard(authA.access, swapId, 'json');
    const oldCode = getString(swapCard.data, 'public_code');

    // Block WebSocket in Browser A so SSE fallback handles realtime updates
    await userA.page.routeWebSocket('**/v1/ws*', (ws) => {
      ws.close();
    });
    const browserSseConnectPromise = userA.page.waitForResponse(
      (res) => res.url().includes('/v1/events/stream') && res.status() === 200,
      { timeout: 15_000 },
    );
    await injectAuthSession(userA.page, authA);
    await userA.page.goto(`/journeys/${jAId}`, { waitUntil: 'domcontentloaded' });
    await browserSseConnectPromise;

    // Also add supply userC for post-invalidation re-match
    const vC = await userC.api.verifyTrainPnr(authC.access, TEST_PNRS.cycleC);
    const hubC = await userC.api.getJourney(
      authC.access,
      getString(asRecord(vC.data.journey, 'jC'), 'id'),
    );
    await userC.api.setGoal(authC.access, getString(asRecord(hubC.data.party, 'pC'), 'id'), {
      goal_type: 'open_to_help',
      movers: [getString(asRecord(asArray(hubC.data.seat_holders, 'hC')[0], 'hC0'), 'id')],
      preferred_seats: [],
      constraints: { women_only: false, no_middle: false, same_coach_only: false, verified_only: false },
      standing_offer: { give_to: 'anyone' },
    });

    const sseA = new SaathSseClient();
    try {
      await sseA.connect(authA.access);
      const waitChartSse = sseA.waitForEvent(
        'journey.chart',
        (e) => e.journey_id === jAId,
        15_000,
      );
      const waitSwapInvSse = sseA.waitForEvent(
        'swap.updated',
        (e) => e.swap_id === swapId && e.status === 'invalidated',
        15_000,
      );

      // Trigger chart-prep berth change
      const rev = await userA.api.request('POST', `/v1/journeys/${jAId}/reverify`, {
        token: authA.access,
        headers: { 'X-Simulate-Chart-Change': 'true' },
      });
      expect(rev.status).toBe(200);

      await Promise.all([waitChartSse, waitSwapInvSse]);

      // UI reflects chart change without reload
      await expect(
        userA.page.getByText(/Chart prepared|invalidated|berth changed/i).first(),
      ).toBeVisible();

      // Old Swap Card /v/[code] is revoked
      const oldPub = await userA.api.verifyPublicSwapCard(oldCode);
      expect(oldPub.data.valid).toBe(false);
      expect(oldPub.data.revoked).toBe(true);

      await userB.page.goto(`/v/${oldCode}`, { waitUntil: 'domcontentloaded' });
      await expect(userB.page.getByText(/Revoked|Invalidated/i).first()).toBeVisible();

      // Re-match produces updated candidates
      await expect(async () => {
        const matches2 = await userA.api.getMatches(authA.access, pAId);
        expect(matches2.status).toBe(200);
        expect(matches2.data.match_version).toBeGreaterThan(initialMatchVersion);
      }).toPass({ timeout: 12_000, intervals: [500, 1000, 1500] });
    } finally {
      sseA.close();
    }
  });
});
