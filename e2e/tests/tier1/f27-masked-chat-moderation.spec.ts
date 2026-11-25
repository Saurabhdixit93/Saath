import crypto from 'node:crypto';
import { test, expect, injectAuthSession } from '../../fixtures/multi-browser.js';
import { SaathApiClient, type MatchCardDto } from '../../helpers/api.js';
import { TEST_PNRS, uniquePhone } from '../../helpers/env.js';
import { assertNoPiiLeak } from '../../helpers/pii.js';

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

async function setupMaskedConversation(seedBase: number): Promise<{
  apiA: SaathApiClient;
  apiB: SaathApiClient;
  tokenA: string;
  tokenB: string;
  conversationId: string;
  partnerAlias: string;
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
    throw new Error('Expected match card for chat test');
  }
  const convo = await apiA.createConversation(authA.access, card.card_id);
  expect([200, 201]).toContain(convo.status);

  return {
    apiA,
    apiB,
    tokenA: authA.access,
    tokenB: authB.access,
    conversationId: getString(convo.data, 'id'),
    partnerAlias: getString(convo.data, 'partner_alias'),
  };
}

test.describe('F27: Masked Chat, Redaction, Translation & Moderation @tier1', () => {
  test('POST /v1/conversations opens pre-accept masked chat with pseudonymous alias and zero PII', async () => {
    const { apiA, tokenA, conversationId, partnerAlias } = await setupMaskedConversation(27_000);

    expect(partnerAlias).toMatch(/Passenger/i);
    const list = await apiA.listConversations(tokenA);
    expect(list.status).toBe(200);
    expect(asArray(list.data.items, 'conversations').length).toBeGreaterThanOrEqual(1);

    const msgs = await apiA.getMessages(tokenA, conversationId);
    expect(msgs.status).toBe(200);
    assertNoPiiLeak(msgs.data, 'masked-chat-init', [TEST_PNRS.cycleA, TEST_PNRS.cycleB]);
  });

  test('POST /v1/conversations/{id}/messages sends clean text and is idempotent on client_id', async () => {
    const { apiA, tokenA, conversationId } = await setupMaskedConversation(27_100);
    const clientId = crypto.randomUUID();

    const m1 = await apiA.sendMessage(tokenA, conversationId, 'Hi, happy to swap before Pune!', clientId);
    expect([200, 201]).toContain(m1.status);
    expect(m1.data.moderation).toBe('ok');

    const m2 = await apiA.sendMessage(tokenA, conversationId, 'Hi, happy to swap before Pune!', clientId);
    expect([200, 201]).toContain(m2.status);

    const history = await apiA.getMessages(tokenA, conversationId);
    const items = asArray(history.data.items, 'messages').map((m) => asRecord(m, 'msg'));
    const matching = items.filter((m) => m.client_id === clientId);
    expect(matching.length).toBe(1);
  });

  test('UI /inbox masked chat renders quick-reply chips and sends message', async ({
    createIsolatedPassenger,
  }) => {
    const { tokenA, conversationId, partnerAlias } = await setupMaskedConversation(27_200);
    const passenger = await createIsolatedPassenger('chat-ui');

    await injectAuthSession(passenger.page, { access: tokenA });
    await passenger.page.goto(`/inbox/${conversationId}`, { waitUntil: 'domcontentloaded' });

    await expect(passenger.page.getByText(new RegExp(partnerAlias)).first()).toBeVisible();
    const chip = passenger.page.getByRole('button', {
      name: /Swap at|Happy to swap|Can we|अदला-बदली/i,
    }).first();
    await expect(chip).toBeVisible();
    await chip.click();

    await expect(passenger.page.getByText(/swap|अदला-बदली/i).first()).toBeVisible();
  });

  test('POST /v1/conversations/{id}/translate translates message between English and Hindi', async () => {
    const { apiA, apiB, tokenA, tokenB, conversationId } = await setupMaskedConversation(27_300);

    const sent = await apiA.sendMessage(tokenA, conversationId, 'Can we swap near Vadodara?');
    const msgId = getString(sent.data, 'id');

    const tr = await apiB.translateMessage(tokenB, conversationId, msgId, 'hi');
    expect(tr.status).toBe(200);
    expect(getString(tr.data, 'translated_text').length).toBeGreaterThan(0);
    expect(tr.data.to).toBe('hi');
  });

  test('POST /v1/reports creates open report and POST /v1/users/block blocks alias', async () => {
    const { apiA, apiB, tokenA, tokenB, conversationId, partnerAlias } =
      await setupMaskedConversation(27_400);

    const sent = await apiB.sendMessage(tokenB, conversationId, 'Unwanted spam message');
    const msgId = getString(sent.data, 'id');

    const report = await apiA.reportUser(tokenA, {
      conversation_id: conversationId,
      message_id: msgId,
      reason: 'spam',
    });
    expect([200, 201]).toContain(report.status);
    expect(getString(report.data, 'status')).toBe('open');

    const block = await apiA.blockUser(tokenA, partnerAlias);
    expect(block.status).toBe(200);
    expect(block.data.blocked).toBe(true);
  });
});
