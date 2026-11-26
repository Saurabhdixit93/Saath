import { expect, type Page } from '@playwright/test';
import { type AuthTokens, type MatchCardDto, SaathApiClient } from './api.js';
import { E2E_ENV, futureDateIso, uniquePhone, uniquePnr } from './env.js';

export function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Expected object for ${label}`);
  }
  return value as Record<string, unknown>;
}

export function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Expected array for ${label}`);
  }
  return value;
}

export function getString(obj: Record<string, unknown>, key: string): string {
  const val = obj[key];
  if (typeof val !== 'string' || val.length === 0) {
    throw new Error(`Expected non-empty string "${key}" in ${JSON.stringify(obj)}`);
  }
  return val;
}

export function getNumber(obj: Record<string, unknown>, key: string): number {
  const val = obj[key];
  if (typeof val !== 'number') {
    throw new Error(`Expected number "${key}" in ${JSON.stringify(obj)}`);
  }
  return val;
}

export async function getAdminToken(api: SaathApiClient = new SaathApiClient()): Promise<string> {
  const res = await api.createAdminSession(E2E_ENV.adminTestEmail);
  expect([200, 201]).toContain(res.status);
  const token = res.data.access ?? res.data.token ?? '';
  if (!token) {
    throw new Error(`Missing admin token in response: ${res.rawText}`);
  }
  return token;
}

export async function signInAdminUi(page: Page, api: SaathApiClient): Promise<string> {
  await page.goto(`${E2E_ENV.adminUrl}/login`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
    'content',
    /noindex.*nofollow|nofollow.*noindex/i,
  );

  if (E2E_ENV.envMode !== 'production') {
    const emailInput = page
      .getByLabel(/email/i)
      .or(page.getByPlaceholder(/email|ops@saath/i))
      .or(page.getByRole('textbox'))
      .first();
    await expect(emailInput).toBeVisible();
    await emailInput.fill(E2E_ENV.adminTestEmail);

    const submitBtn = page
      .getByRole('button', { name: /sign in|login|continue|session|submit/i })
      .first();
    await submitBtn.click();
    await expect(page).not.toHaveURL(/\/login$/);
  } else {
    const token = await getAdminToken(api);
    await page.evaluate((t) => {
      window.localStorage.setItem('saath_access_token', t);
      window.localStorage.setItem('saath_admin_token', t);
    }, token);
    await page.context().addCookies([
      { name: 'saath_admin_token', value: token, url: E2E_ENV.adminUrl },
    ]);
    await page.goto(E2E_ENV.adminUrl, { waitUntil: 'domcontentloaded' });
  }

  return getAdminToken(api);
}

export interface SeededMatchedPair {
  authA: AuthTokens;
  authB: AuthTokens;
  journeyIdA: string;
  journeyIdB: string;
  partyIdA: string;
  partyIdB: string;
  cardId: string;
  convoId: string;
}

export async function seedMatchedPairWithChat(
  api: SaathApiClient,
  seedPrefix: string,
  opts: {
    travelDate?: string;
    seatA?: string;
    seatB?: string;
    createSwap?: boolean;
  } = {},
): Promise<SeededMatchedPair & { swapId?: string; swapVersion?: number }> {
  const travelDate = opts.travelDate ?? futureDateIso(24);
  const seatA = opts.seatA ?? '1';
  const seatB = opts.seatB ?? '3';

  const authA = await api.loginWithOtp(uniquePhone(`${seedPrefix}-a`));
  const authB = await api.loginWithOtp(uniquePhone(`${seedPrefix}-b`));

  const vA = await api.verifyTrainSms(
    authA.access,
    `IRCTC PNR:${uniquePnr(`${seedPrefix}-a`)},TRN:12951,DOJ:${travelDate},CLS:3A,B3 ${seatA} LB,NDLS-MMCT`,
  );
  const vB = await api.verifyTrainSms(
    authB.access,
    `IRCTC PNR:${uniquePnr(`${seedPrefix}-b`)},TRN:12951,DOJ:${travelDate},CLS:3A,B3 ${seatB} UB,NDLS-MMCT`,
  );
  expect(vA.status).toBe(200);
  expect(vB.status).toBe(200);

  const journeyIdA = getString(asRecord(vA.data.journey, 'journeyA'), 'id');
  const journeyIdB = getString(asRecord(vB.data.journey, 'journeyB'), 'id');
  const hubA = await api.getJourney(authA.access, journeyIdA);
  const hubB = await api.getJourney(authB.access, journeyIdB);
  const partyIdA = getString(asRecord(hubA.data.party, 'partyA'), 'id');
  const partyIdB = getString(asRecord(hubB.data.party, 'partyB'), 'id');

  const hA0 = getString(asRecord(asArray(hubA.data.seat_holders, 'hA')[0], 'hA0'), 'id');
  const hB0 = getString(asRecord(asArray(hubB.data.seat_holders, 'hB')[0], 'hB0'), 'id');

  await api.setGoal(authA.access, partyIdA, {
    goal_type: 'lower',
    movers: [hA0],
    preferred_seats: [],
    constraints: { women_only: false, no_middle: false, same_coach_only: false, verified_only: false },
  });
  await api.setGoal(authB.access, partyIdB, {
    goal_type: 'open_to_help',
    movers: [hB0],
    preferred_seats: [],
    constraints: { women_only: false, no_middle: false, same_coach_only: false, verified_only: false },
    standing_offer: { give_to: 'anyone' },
  });

  let card: MatchCardDto | undefined;
  await expect(async () => {
    const matches = await api.getMatches(authA.access, partyIdA, 'pair');
    expect(matches.status).toBe(200);
    expect(matches.data.items.length).toBeGreaterThanOrEqual(1);
    card = matches.data.items[0];
  }).toPass({ timeout: 12_000, intervals: [500, 1000, 1500] });
  if (!card) {
    throw new Error(`Expected match card for ${seedPrefix}`);
  }

  const convo = await api.createConversation(authA.access, card.card_id);
  expect([200, 201]).toContain(convo.status);
  const convoId = getString(convo.data, 'id');

  if (opts.createSwap) {
    const swap = await api.createSwap(authA.access, card.card_id);
    expect([200, 201]).toContain(swap.status);
    return {
      authA,
      authB,
      journeyIdA,
      journeyIdB,
      partyIdA,
      partyIdB,
      cardId: card.card_id,
      convoId,
      swapId: getString(swap.data, 'id'),
      swapVersion: getNumber(swap.data, 'version'),
    };
  }

  return {
    authA,
    authB,
    journeyIdA,
    journeyIdB,
    partyIdA,
    partyIdB,
    cardId: card.card_id,
    convoId,
  };
}

export async function createReportedMessage(
  api: SaathApiClient,
  seedPrefix: string,
  opts: {
    travelDate?: string;
    seatA?: string;
    seatB?: string;
    messageText?: string;
    reason?: string;
    createPendingSwap?: boolean;
  } = {},
): Promise<
  SeededMatchedPair & {
    messageId: string;
    reportId: string;
    swapId?: string;
  }
> {
  const seeded = await seedMatchedPairWithChat(api, seedPrefix, {
    travelDate: opts.travelDate,
    seatA: opts.seatA,
    seatB: opts.seatB,
    createSwap: opts.createPendingSwap,
  });

  const msg = await api.sendMessage(
    seeded.authB.access,
    seeded.convoId,
    opts.messageText ?? 'Moderation test message',
  );
  expect([200, 201]).toContain(msg.status);
  const messageId = getString(msg.data, 'id');

  const report = await api.reportUser(seeded.authA.access, {
    conversation_id: seeded.convoId,
    message_id: messageId,
    reason: opts.reason ?? 'abuse',
  });
  expect([200, 201]).toContain(report.status);
  const reportId = getString(report.data, 'report_id');

  return {
    ...seeded,
    messageId,
    reportId,
  };
}

export async function seedSwapDispute(
  api: SaathApiClient,
  seedPrefix: string,
  opts: {
    travelDate?: string;
    seatA?: string;
    seatB?: string;
    completeFirst?: boolean;
  } = {},
): Promise<SeededMatchedPair & { swapId: string; publicCode: string }> {
  const seeded = await seedMatchedPairWithChat(api, seedPrefix, {
    travelDate: opts.travelDate,
    seatA: opts.seatA,
    seatB: opts.seatB,
    createSwap: true,
  });
  const swapId = seeded.swapId;
  if (!swapId || seeded.swapVersion === undefined) {
    throw new Error('Expected swapId and swapVersion');
  }

  const accA = await api.acceptSwap(seeded.authA.access, swapId, seeded.swapVersion);
  expect(accA.status).toBe(200);
  const accB = await api.acceptSwap(
    seeded.authB.access,
    swapId,
    getNumber(accA.data, 'version'),
  );
  expect(accB.status).toBe(200);

  const cardJson = await api.getSwapCard(seeded.authA.access, swapId, 'json');
  expect(cardJson.status).toBe(200);
  const publicCode = getString(cardJson.data, 'public_code');

  if (opts.completeFirst) {
    const c1 = await api.confirmCompletion(seeded.authA.access, swapId, 'yes');
    const c2 = await api.confirmCompletion(seeded.authB.access, swapId, 'yes');
    expect(c1.status).toBe(200);
    expect(c2.status).toBe(200);
  } else {
    const c1 = await api.confirmCompletion(seeded.authA.access, swapId, 'yes');
    const c2 = await api.confirmCompletion(seeded.authB.access, swapId, 'no');
    expect(c1.status).toBe(200);
    expect(c2.status).toBe(200);
    expect(c2.data.status).toBe('not_completed');
  }

  return {
    ...seeded,
    swapId,
    publicCode,
  };
}
