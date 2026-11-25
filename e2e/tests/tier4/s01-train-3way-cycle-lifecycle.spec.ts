import { test, expect, injectAuthSession } from '../../fixtures/multi-browser.js';
import { TEST_PNRS, uniquePhone } from '../../helpers/env.js';
import { assertLocale } from '../../helpers/a11y.js';
import { assertNoPiiLeak } from '../../helpers/pii.js';
import { SaathWsClient } from '../../helpers/ws-sse.js';

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
    throw new Error(`Expected string "${key}" in ${JSON.stringify(obj)}`);
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

test.describe('S01: 3-Browser Train 3-Way Cycle Swap Full Lifecycle @tier4', () => {
  test('3 independent browsers complete PNR verify -> goal -> live WS match -> masked chat -> 3-way accept -> Swap Card + /v/[code] -> confirm -> Karma', async ({
    threePassengers,
    createIsolatedPassenger,
  }) => {
    const { userA, userB, userC } = threePassengers;

    const authA = await userA.api.loginWithOtp(uniquePhone(401_001));
    const authB = await userB.api.loginWithOtp(uniquePhone(401_002));
    const authC = await userC.api.loginWithOtp(uniquePhone(401_003));

    const wsA = new SaathWsClient();
    const wsB = new SaathWsClient();
    const wsC = new SaathWsClient();

    try {
      await Promise.all([
        wsA.connectAndAuth(authA.access),
        wsB.connectAndAuth(authB.access),
        wsC.connectAndAuth(authC.access),
      ]);

      const [vA, vB, vC] = await Promise.all([
        userA.api.verifyTrainPnr(authA.access, TEST_PNRS.cycleA),
        userB.api.verifyTrainPnr(authB.access, TEST_PNRS.cycleB),
        userC.api.verifyTrainPnr(authC.access, TEST_PNRS.cycleC),
      ]);
      expect(vA.status).toBe(200);
      expect(vB.status).toBe(200);
      expect(vC.status).toBe(200);

      const jAId = getString(asRecord(vA.data.journey, 'jA'), 'id');
      const jBId = getString(asRecord(vB.data.journey, 'jB'), 'id');
      const jCId = getString(asRecord(vC.data.journey, 'jC'), 'id');

      const [hubA, hubB, hubC] = await Promise.all([
        userA.api.getJourney(authA.access, jAId),
        userB.api.getJourney(authB.access, jBId),
        userC.api.getJourney(authC.access, jCId),
      ]);

      const pAId = getString(asRecord(hubA.data.party, 'pA'), 'id');
      const pBId = getString(asRecord(hubB.data.party, 'pB'), 'id');
      const pCId = getString(asRecord(hubC.data.party, 'pC'), 'id');

      const hAId = getString(asRecord(asArray(hubA.data.seat_holders, 'hA')[0], 'hA0'), 'id');
      const hB0 = asRecord(asArray(hubB.data.seat_holders, 'hB')[0], 'hB0');
      const hBId = getString(hB0, 'id');
      const hBSeatPref =
        typeof hB0.coach === 'string' && typeof hB0.seat_no === 'string'
          ? [hB0.seat_no.includes('-') ? hB0.seat_no : `${hB0.coach}-${hB0.seat_no}`]
          : [];
      const hCId = getString(asRecord(asArray(hubC.data.seat_holders, 'hC')[0], 'hC0'), 'id');

      await Promise.all([
        injectAuthSession(userA.page, authA),
        injectAuthSession(userB.page, authB),
        injectAuthSession(userC.page, authC),
      ]);

      await Promise.all([
        userA.page.goto(`/journeys/${jAId}/matches`, { waitUntil: 'domcontentloaded' }),
        userB.page.goto(`/journeys/${jBId}/matches`, { waitUntil: 'domcontentloaded' }),
        userC.page.goto(`/journeys/${jCId}/matches`, { waitUntil: 'domcontentloaded' }),
      ]);

      const waitMatchA = wsA.waitForEvent('match.updated', (e) => e.party_id === pAId, 15_000);

      await userB.api.setGoal(authB.access, pBId, {
        goal_type: 'upper',
        movers: [hBId],
        preferred_seats: [],
        constraints: { women_only: false, no_middle: false, same_coach_only: false, verified_only: false },
      });
      await userC.api.setGoal(authC.access, pCId, {
        goal_type: 'specific_seats',
        movers: [hCId],
        preferred_seats: hBSeatPref,
        constraints: { women_only: false, no_middle: false, same_coach_only: false, verified_only: false },
      });
      await userA.api.setGoal(authA.access, pAId, {
        goal_type: 'lower',
        movers: [hAId],
        preferred_seats: [],
        constraints: { women_only: false, no_middle: false, same_coach_only: false, verified_only: false },
      });

      const matchEvtA = await waitMatchA;
      expect(matchEvtA.party_id).toBe(pAId);

      const matchesA = await userA.api.getMatches(authA.access, pAId);
      expect(matchesA.status).toBe(200);
      assertNoPiiLeak(matchesA.data, 's01-matches-pre-accept', [
        TEST_PNRS.cycleA,
        TEST_PNRS.cycleB,
        TEST_PNRS.cycleC,
      ]);

      const coachMapA = await userA.api.getCoachMap(authA.access, jAId, 'B3');
      expect(coachMapA.status).toBe(200);
      assertNoPiiLeak(coachMapA.data, 's01-coach-map', [], { allowLayoutSeatNo: true });

      const cycleCard =
        matchesA.data.items.find((c) => c.kind === 'cycle3') ?? matchesA.data.items[0];
      if (!cycleCard) {
        throw new Error('Expected cycle3 or pair match card in s01');
      }

      // Masked chat + live message.new + redaction check
      const convo = await userA.api.createConversation(authA.access, cycleCard.card_id);
      const convoId = getString(convo.data, 'id');
      expect(convo.data.unmasked).toBe(false);

      const waitMsgB = wsB.waitForEvent(
        'message.new',
        (e) => e.conversation_id === convoId,
        15_000,
      );
      const redactedMsg = await userA.api.sendMessage(
        authA.access,
        convoId,
        'Ping me on 9876543210 or ravi@okicici to coordinate',
      );
      expect(redactedMsg.data.moderation).toBe('redacted');
      expect(String(redactedMsg.data.body)).toContain('•••');
      await waitMsgB;

      // 3-way proposal & accept sequence with live swap.updated WS
      const swapRes = await userA.api.createSwap(authA.access, cycleCard.card_id);
      const swapId = getString(swapRes.data, 'id');
      let version = getNumber(swapRes.data, 'version');

      const waitConfirmedA = wsA.waitForEvent(
        'swap.updated',
        (e) => e.swap_id === swapId && e.status === 'confirmed',
        15_000,
      );

      const accA = await userA.api.acceptSwap(authA.access, swapId, version);
      version = getNumber(accA.data, 'version');
      const accB = await userB.api.acceptSwap(authB.access, swapId, version);
      version = getNumber(accB.data, 'version');
      const accC = await userC.api.acceptSwap(authC.access, swapId, version);
      expect(accC.data.status).toBe('confirmed');

      await waitConfirmedA;

      // Swap Card + Hindi toggle + Public /v/[code] verify (no PII)
      const cardJson = await userA.api.getSwapCard(authA.access, swapId, 'json');
      const publicCode = getString(cardJson.data, 'public_code');

      await userA.page.goto(`/swaps/${swapId}/card`, { waitUntil: 'domcontentloaded' });
      await expect(userA.page.getByText(/SAATH SWAP CARD/i)).toBeVisible();
      await expect(userA.page.getByText(new RegExp(publicCode))).toBeVisible();

      await userA.page.getByRole('button', { name: /हिंदी|हिं|Hindi/i }).click();
      await assertLocale(userA.page, 'hi', { latinDigitTexts: [publicCode.slice(-4)] });

      const verifier = await createIsolatedPassenger('public-tte-verifier');
      const pubRes = await verifier.api.verifyPublicSwapCard(publicCode);
      expect(pubRes.data.valid).toBe(true);
      expect(pubRes.data.revoked).toBe(false);
      assertNoPiiLeak(pubRes.data, 's01-public-swap-card', [
        TEST_PNRS.cycleA,
        TEST_PNRS.cycleB,
        TEST_PNRS.cycleC,
      ]);

      await verifier.page.goto(`/v/${publicCode}`, { waitUntil: 'domcontentloaded' });
      await expect(verifier.page.getByText(/Valid/i)).toBeVisible();

      // Post-journey confirm -> Karma credited
      await userA.api.confirmCompletion(authA.access, swapId, 'yes');
      await userB.api.confirmCompletion(authB.access, swapId, 'yes');
      const confC = await userC.api.confirmCompletion(authC.access, swapId, 'yes');
      expect(confC.data.status).toBe('completed');

      const karmaA = await userA.api.getKarma(authA.access);
      expect(Number(karmaA.data.balance)).toBeGreaterThanOrEqual(50);

      await userA.page.goto('/karma', { waitUntil: 'domcontentloaded' });
      await expect(userA.page.getByText(/first_swap|First Swap|Karma/i).first()).toBeVisible();
    } finally {
      await Promise.all([wsA.close(), wsB.close(), wsC.close()]);
    }
  });
});
