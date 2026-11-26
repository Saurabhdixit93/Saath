import { test, expect } from '../../fixtures/multi-browser.js';
import {
  asArray,
  asRecord,
  getAdminToken,
  getNumber,
  getString,
} from '../../helpers/admin-seed.js';
import { type AuthTokens, type MatchCardDto, SaathApiClient } from '../../helpers/api.js';
import { futureDateIso, uniquePhone, uniquePnr } from '../../helpers/env.js';
import { assertNoPiiLeak } from '../../helpers/pii.js';
import { parseDpdpExportZip } from '../../helpers/zip.js';

interface SeededCycle {
  authA: AuthTokens;
  authB: AuthTokens;
  authC: AuthTokens;
  partyA: string;
  partyB: string;
  partyC: string;
  card: MatchCardDto;
  convoId: string;
}

async function seedThreeWayCycle(
  api: SaathApiClient,
  seedPrefix: string,
  travelDate: string,
): Promise<SeededCycle> {
  const authA = await api.loginWithOtp(uniquePhone(`${seedPrefix}-a`), 'whatsapp');
  const authB = await api.loginWithOtp(uniquePhone(`${seedPrefix}-b`), 'whatsapp');
  const authC = await api.loginWithOtp(uniquePhone(`${seedPrefix}-c`), 'whatsapp');

  // Directed 3-cycle: A(B3 11 UB)->wants B3-12, B(B3 20 LB)->wants B3-11, C(B3 12 LB)->wants B3-20
  const [vA, vB, vC] = await Promise.all([
    api.verifyTrainSms(
      authA.access,
      `IRCTC PNR:${uniquePnr(`${seedPrefix}-a`)},TRN:12951,DOJ:${travelDate},CLS:3A,B3 11 UB,NDLS-MMCT`,
    ),
    api.verifyTrainSms(
      authB.access,
      `IRCTC PNR:${uniquePnr(`${seedPrefix}-b`)},TRN:12951,DOJ:${travelDate},CLS:3A,B3 20 LB,NDLS-MMCT`,
    ),
    api.verifyTrainSms(
      authC.access,
      `IRCTC PNR:${uniquePnr(`${seedPrefix}-c`)},TRN:12951,DOJ:${travelDate},CLS:3A,B3 12 LB,NDLS-MMCT`,
    ),
  ]);
  expect(vA.status).toBe(200);
  expect(vB.status).toBe(200);
  expect(vC.status).toBe(200);

  const [hubA, hubB, hubC] = await Promise.all([
    api.getJourney(authA.access, getString(asRecord(vA.data.journey, 'jA'), 'id')),
    api.getJourney(authB.access, getString(asRecord(vB.data.journey, 'jB'), 'id')),
    api.getJourney(authC.access, getString(asRecord(vC.data.journey, 'jC'), 'id')),
  ]);

  const partyA = getString(asRecord(hubA.data.party, 'pA'), 'id');
  const partyB = getString(asRecord(hubB.data.party, 'pB'), 'id');
  const partyC = getString(asRecord(hubC.data.party, 'pC'), 'id');

  const hA = getString(asRecord(asArray(hubA.data.seat_holders, 'hA')[0], 'hA0'), 'id');
  const hB = getString(asRecord(asArray(hubB.data.seat_holders, 'hB')[0], 'hB0'), 'id');
  const hC = getString(asRecord(asArray(hubC.data.seat_holders, 'hC')[0], 'hC0'), 'id');

  const constraints = {
    women_only: false,
    no_middle: false,
    same_coach_only: false,
    verified_only: false,
  };

  await api.setGoal(authA.access, partyA, {
    goal_type: 'specific_seats',
    movers: [hA],
    preferred_seats: ['B3-12'],
    constraints,
  });
  await api.setGoal(authB.access, partyB, {
    goal_type: 'specific_seats',
    movers: [hB],
    preferred_seats: ['B3-11'],
    constraints,
  });
  await api.setGoal(authC.access, partyC, {
    goal_type: 'specific_seats',
    movers: [hC],
    preferred_seats: ['B3-20'],
    constraints,
  });

  let card: MatchCardDto | undefined;
  await expect(async () => {
    const matches = await api.getMatches(authA.access, partyA);
    expect(matches.status).toBe(200);
    const found = matches.data.items.find((c) => c.kind === 'cycle3') ?? matches.data.items[0];
    expect(found).toBeDefined();
    card = found;
  }).toPass({ timeout: 15_000, intervals: [500, 1000, 1500] });
  if (!card) {
    throw new Error(`Expected 3-way match card for ${seedPrefix}`);
  }

  const convo = await api.createConversation(authA.access, card.card_id);
  expect([200, 201]).toContain(convo.status);
  const convoId = getString(convo.data, 'id');

  return { authA, authB, authC, partyA, partyB, partyC, card, convoId };
}

test.describe('@tier3 P11: 3-Way Swap -> Masked Chat -> Moderation -> Karma -> DPDP Export & Erasure', () => {
  test('3-way cycle swap + masked chat redaction + mutual accept/confirm -> karma -> DPDP export & erasure', async () => {
    const api = new SaathApiClient();
    const cycle = await seedThreeWayCycle(api, 'p11-full', futureDateIso(34));

    const preAcceptMsg = await api.sendMessage(
      cycle.authA.access,
      cycle.convoId,
      'Meet near B3, call 9876543210 or pay test@okicici',
    );
    expect([200, 201]).toContain(preAcceptMsg.status);
    expect(preAcceptMsg.data.moderation).toBe('redacted');

    const swap = await api.createSwap(cycle.authA.access, cycle.card.card_id);
    expect([200, 201]).toContain(swap.status);
    const swapId = getString(swap.data, 'id');
    let version = getNumber(swap.data, 'version');

    const accA = await api.acceptSwap(cycle.authA.access, swapId, version);
    version = getNumber(accA.data, 'version');
    const accB = await api.acceptSwap(cycle.authB.access, swapId, version);
    version = getNumber(accB.data, 'version');
    const accC = await api.acceptSwap(cycle.authC.access, swapId, version);
    expect(accC.data.status).toBe('confirmed');

    await api.confirmCompletion(cycle.authA.access, swapId, 'yes');
    await api.confirmCompletion(cycle.authB.access, swapId, 'yes');
    const confC = await api.confirmCompletion(cycle.authC.access, swapId, 'yes');
    expect(confC.data.status).toBe('completed');

    const [kA, kB, kC] = await Promise.all([
      api.getKarma<{ balance: number }>(cycle.authA.access),
      api.getKarma<{ balance: number }>(cycle.authB.access),
      api.getKarma<{ balance: number }>(cycle.authC.access),
    ]);
    expect(kA.data.balance).toBeGreaterThan(0);
    expect(kB.data.balance).toBeGreaterThan(0);
    expect(kC.data.balance).toBeGreaterThan(0);

    const exportB = await api.exportMyData(cycle.authB.access);
    expect(exportB.status).toBe(200);
    const bundleB = parseDpdpExportZip(exportB.buffer);
    expect(Object.keys(bundleB)).toHaveLength(8);
    expect(JSON.stringify(bundleB['swaps.json'])).toContain(swapId);
    assertNoPiiLeak(bundleB['swaps.json'], 'p11-export-swaps');

    const aliasC = 'P11ErasedCycleC';
    await api.patchMe(cycle.authC.access, { display_alias: aliasC, leaderboard_opt_in: true });
    const delC = await api.deleteMyAccount(cycle.authC.access);
    expect([200, 202]).toContain(delC.status);

    const swapForA = await api.getSwap(cycle.authA.access, swapId);
    expect(swapForA.status).toBe(200);
    expect(swapForA.data.status).toBe('completed');
    assertNoPiiLeak(swapForA.data, 'p11-partner-swap-post-erasure', [aliasC]);
  });

  test('3-way cycle swap with chat report -> admin restrict (403 chat) -> admin ban invalidates pending swap & revokes tokens', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);
    const cycle = await seedThreeWayCycle(api, 'p11-mod-ban', futureDateIso(35));

    const swap = await api.createSwap(cycle.authA.access, cycle.card.card_id);
    const swapId = getString(swap.data, 'id');

    const badMsg = await api.sendMessage(cycle.authC.access, cycle.convoId, 'Harassing cycle member');
    const report = await api.reportUser(cycle.authA.access, {
      conversation_id: cycle.convoId,
      message_id: getString(badMsg.data, 'id'),
      reason: 'harassment',
    });
    const reportId = getString(report.data, 'report_id');

    const restrictRes = await api.actOnModeration(adminToken, reportId, 'restrict', 'Restrict cycle offender');
    expect(restrictRes.status).toBe(200);
    expect(restrictRes.data.target_user_status).toBe('restricted');

    api.assertProblemJson(
      await api.sendMessage(cycle.authC.access, cycle.convoId, 'Blocked after restrict'),
      403,
    );

    const banRes = await api.actOnModeration(adminToken, reportId, 'ban', 'Escalate to ban');
    expect(banRes.status).toBe(200);
    expect(banRes.data.target_user_status).toBe('banned');
    expect(Number(banRes.data.invalidated_swaps)).toBeGreaterThanOrEqual(1);

    api.assertProblemJson(await api.getMe(cycle.authC.access), [401, 403]);
    api.assertProblemJson(await api.refreshTokens(cycle.authC.refresh), [401, 403]);

    const swapAfterBan = await api.getSwap(cycle.authA.access, swapId);
    expect(swapAfterBan.status).toBe(200);
    expect(swapAfterBan.data.status).toBe('invalidated');

    const audit = await api.getAdminAuditLog<{ total: number }>(adminToken, {
      action: 'admin.moderation.ban',
      resource: `report:${reportId}`,
    });
    expect(audit.data.total).toBe(1);
  });

  test('Admin dismiss on benign 3-way chat report leaves chat and 3-way swap unaffected', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);
    const cycle = await seedThreeWayCycle(api, 'p11-dismiss', futureDateIso(36));

    const msg = await api.sendMessage(cycle.authB.access, cycle.convoId, 'Happy to swap seats!');
    const report = await api.reportUser(cycle.authA.access, {
      conversation_id: cycle.convoId,
      message_id: getString(msg.data, 'id'),
      reason: 'other',
    });
    const reportId = getString(report.data, 'report_id');

    const dismiss = await api.actOnModeration(adminToken, reportId, 'dismiss', 'Benign conversation');
    expect(dismiss.status).toBe(200);
    expect(dismiss.data.report_status).toBe('dismissed');
    expect(dismiss.data.target_user_status).toBe('active');

    const followUp = await api.sendMessage(cycle.authB.access, cycle.convoId, 'Still active after dismiss');
    expect([200, 201]).toContain(followUp.status);

    const swap = await api.createSwap(cycle.authA.access, cycle.card.card_id);
    expect([200, 201]).toContain(swap.status);
  });
});
