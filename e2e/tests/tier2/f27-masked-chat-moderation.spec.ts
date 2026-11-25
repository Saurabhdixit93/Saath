import { test, expect } from '../../fixtures/multi-browser.js';
import { SaathApiClient, type MatchCardDto } from '../../helpers/api.js';
import { TEST_PNRS, futureDateIso, uniquePhone, uniquePnr } from '../../helpers/env.js';

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

async function setupMaskedPairChat(seedBase: number): Promise<{
  apiA: SaathApiClient;
  apiB: SaathApiClient;
  tokenA: string;
  tokenB: string;
  conversationId: string;
  partnerAlias: string;
  cardId: string;
}> {
  const apiA = new SaathApiClient();
  const apiB = new SaathApiClient();
  const authA = await apiA.loginWithOtp(uniquePhone(seedBase + 1));
  const authB = await apiB.loginWithOtp(uniquePhone(seedBase + 2));

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
  return {
    apiA,
    apiB,
    tokenA: authA.access,
    tokenB: authB.access,
    conversationId: getString(convo.data, 'id'),
    partnerAlias: getString(convo.data, 'partner_alias'),
    cardId: card.card_id,
  };
}

test.describe('F27 Tier 2: Pre-Accept Contact Redaction & Abuse Controls @tier2', () => {
  test('Pre-accept obfuscated English & Hindi word-digit phone numbers are redacted to •••', async () => {
    const { apiA, tokenA, conversationId } = await setupMaskedPairChat(272_000);

    const enWordPhone = await apiA.sendMessage(
      tokenA,
      conversationId,
      'Call me at nine eight seven six five four three two one zero',
    );
    expect(enWordPhone.data.moderation).toBe('redacted');
    expect(String(enWordPhone.data.body)).toContain('•••');

    const hiWordPhone = await apiA.sendMessage(
      tokenA,
      conversationId,
      'मेरा नंबर नौ आठ सात छह पांच चार तीन दो एक शून्य है',
    );
    expect(hiWordPhone.data.moderation).toBe('redacted');
    expect(String(hiWordPhone.data.body)).toContain('•••');
  });

  test('Pre-accept UPI IDs, obfuscated emails, and URLs are redacted to •••', async () => {
    const { apiA, tokenA, conversationId } = await setupMaskedPairChat(272_100);

    const upi = await apiA.sendMessage(tokenA, conversationId, 'Pay me on ravi.sharma@okicici');
    expect(upi.data.moderation).toBe('redacted');
    expect(String(upi.data.body)).not.toContain('okicici');

    const email = await apiA.sendMessage(tokenA, conversationId, 'Mail user [at] gmail [dot] com');
    expect(email.data.moderation).toBe('redacted');
    expect(String(email.data.body)).toContain('•••');

    const url = await apiA.sendMessage(tokenA, conversationId, 'Ping me on https://wa.me/919876543210');
    expect(url.data.moderation).toBe('redacted');
    expect(String(url.data.body)).not.toContain('wa.me');
  });

  test('Blocked user is rejected with 403 when trying to send messages', async () => {
    const { apiA, apiB, tokenA, tokenB, conversationId, partnerAlias } =
      await setupMaskedPairChat(272_200);

    const block = await apiA.blockUser(tokenA, partnerAlias);
    expect(block.status).toBe(200);

    const sendBlocked = await apiB.sendMessage(tokenB, conversationId, 'Can you hear me?');
    apiB.assertProblemJson(sendBlocked, 403);
  });

  test('New account (<7d) exceeding 5 new conversations/day is rate-limited with 429', async () => {
    const travelDate = futureDateIso(10);
    const apiA = new SaathApiClient();
    const authA = await apiA.loginWithOtp(uniquePhone(272_300));
    const vA = await apiA.verifyTrainSms(
      authA.access,
      `IRCTC PNR:${uniquePnr('f27-cap-a')},TRN:12951,DOJ:${travelDate},CLS:3A,B3 42 UB,NDLS-MMCT`,
    );
    expect(vA.ok).toBe(true);
    const hubA = await apiA.getJourney(authA.access, getString(asRecord(vA.data.journey, 'jA'), 'id'));
    const pA = getString(asRecord(hubA.data.party, 'pA'), 'id');
    await apiA.setGoal(authA.access, pA, {
      goal_type: 'lower',
      movers: [getString(asRecord(asArray(hubA.data.seat_holders, 'hA')[0], 'hA0'), 'id')],
      preferred_seats: [],
      constraints: { women_only: false, no_middle: false, same_coach_only: false, verified_only: false },
    });

    const helperSeats = ['1', '4', '9', '12', '17', '20', '25'];
    const openedCardIds = new Set<string>();
    let hit429 = false;

    for (let i = 0; i < helperSeats.length; i += 1) {
      const seat = helperSeats[i] ?? String(i + 1);
      const helperApi = new SaathApiClient();
      const authH = await helperApi.loginWithOtp(uniquePhone(272_310 + i));
      const vH = await helperApi.verifyTrainSms(
        authH.access,
        `IRCTC PNR:${uniquePnr(272_310 + i)},TRN:12951,DOJ:${travelDate},CLS:3A,B3 ${seat} LB,NDLS-MMCT`,
      );
      expect(vH.ok).toBe(true);
      const hubH = await helperApi.getJourney(
        authH.access,
        getString(asRecord(vH.data.journey, 'jH'), 'id'),
      );
      const pH = getString(asRecord(hubH.data.party, 'pH'), 'id');
      await helperApi.setGoal(authH.access, pH, {
        goal_type: 'open_to_help',
        movers: [getString(asRecord(asArray(hubH.data.seat_holders, 'hH')[0], 'hH0'), 'id')],
        preferred_seats: [],
        constraints: { women_only: false, no_middle: false, same_coach_only: false, verified_only: false },
        standing_offer: { give_to: 'anyone' },
      });

      let newCard: MatchCardDto | undefined;
      await expect(async () => {
        const matches = await apiA.getMatches(authA.access, pA, 'pair');
        expect(matches.status).toBe(200);
        newCard = matches.data.items.find((c) => !openedCardIds.has(c.card_id));
        expect(newCard).toBeDefined();
      }).toPass({ timeout: 12_000, intervals: [500, 1000, 1500] });

      if (!newCard) {
        throw new Error(`Expected distinct match card at iteration ${i}`);
      }
      openedCardIds.add(newCard.card_id);
      const res = await apiA.createConversation(authA.access, newCard.card_id);
      if (res.status === 429) {
        apiA.assertProblemJson(res, 429);
        hit429 = true;
        break;
      }
      expect([200, 201]).toContain(res.status);
    }

    expect(openedCardIds.size).toBeGreaterThanOrEqual(6);
    expect(hit429).toBe(true);
  });

  test('Three distinct reports auto-restrict offending sender from chat (403)', async () => {
    const travelDate = futureDateIso(11);
    const offenderApi = new SaathApiClient();
    const authOffender = await offenderApi.loginWithOtp(uniquePhone(272_400));
    const vOffender = await offenderApi.verifyTrainSms(
      authOffender.access,
      `IRCTC PNR:${uniquePnr('f27-offender')},TRN:12951,DOJ:${travelDate},CLS:3A,B3 1 LB,NDLS-MMCT`,
    );
    expect(vOffender.ok).toBe(true);
    const hubOff = await offenderApi.getJourney(
      authOffender.access,
      getString(asRecord(vOffender.data.journey, 'jOff'), 'id'),
    );
    const pOff = getString(asRecord(hubOff.data.party, 'pOff'), 'id');
    await offenderApi.setGoal(authOffender.access, pOff, {
      goal_type: 'open_to_help',
      movers: [getString(asRecord(asArray(hubOff.data.seat_holders, 'hOff')[0], 'hOff0'), 'id')],
      preferred_seats: [],
      constraints: { women_only: false, no_middle: false, same_coach_only: false, verified_only: false },
      standing_offer: { give_to: 'anyone' },
    });

    const reporterSpecs = [
      { seed: 272_411, seat: '2', reason: 'abuse' },
      { seed: 272_412, seat: '5', reason: 'scam' },
      { seed: 272_413, seat: '10', reason: 'harassment' },
    ] as const;

    let lastConversationId = '';
    for (const spec of reporterSpecs) {
      const repApi = new SaathApiClient();
      const authRep = await repApi.loginWithOtp(uniquePhone(spec.seed));
      const vRep = await repApi.verifyTrainSms(
        authRep.access,
        `IRCTC PNR:${uniquePnr(spec.seed)},TRN:12951,DOJ:${travelDate},CLS:3A,B3 ${spec.seat} UB,NDLS-MMCT`,
      );
      expect(vRep.ok).toBe(true);
      const hubRep = await repApi.getJourney(
        authRep.access,
        getString(asRecord(vRep.data.journey, 'jRep'), 'id'),
      );
      const pRep = getString(asRecord(hubRep.data.party, 'pRep'), 'id');
      await repApi.setGoal(authRep.access, pRep, {
        goal_type: 'lower',
        movers: [getString(asRecord(asArray(hubRep.data.seat_holders, 'hRep')[0], 'hRep0'), 'id')],
        preferred_seats: [],
        constraints: { women_only: false, no_middle: false, same_coach_only: false, verified_only: false },
      });

      let card: MatchCardDto | undefined;
      await expect(async () => {
        const matches = await repApi.getMatches(authRep.access, pRep, 'pair');
        expect(matches.status).toBe(200);
        expect(matches.data.items.length).toBeGreaterThanOrEqual(1);
        card = matches.data.items[0];
      }).toPass({ timeout: 12_000, intervals: [500, 1000, 1500] });
      if (!card) {
        throw new Error(`Expected match card for reporter ${spec.seed}`);
      }

      const convo = await repApi.createConversation(authRep.access, card.card_id);
      expect([200, 201]).toContain(convo.status);
      const convoId = getString(convo.data, 'id');
      lastConversationId = convoId;

      const msg = await offenderApi.sendMessage(
        authOffender.access,
        convoId,
        `Abusive message for auto-restrict (${spec.reason})`,
      );
      expect([200, 201]).toContain(msg.status);

      const repRes = await repApi.reportUser(authRep.access, {
        conversation_id: convoId,
        message_id: getString(msg.data, 'id'),
        reason: spec.reason,
      });
      expect([200, 201]).toContain(repRes.status);
    }

    const sendAfter = await offenderApi.sendMessage(
      authOffender.access,
      lastConversationId,
      'Trying to chat after 3 reports',
    );
    offenderApi.assertProblemJson(sendAfter, 403);
  });
});
