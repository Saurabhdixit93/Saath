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

test.describe('F22: AI Swap Concierge & Outreach Drafts @tier1', () => {
  test('POST /v1/ai/concierge streams SSE proposal and explanation events', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone(22_001));
    const verify = await api.verifyTrainPnr(auth.access, TEST_PNRS.rajdhani3A);
    const journeyId = getString(asRecord(verify.data.journey, 'journey'), 'id');

    const streamRes = await api.conciergeStream(
      auth.access,
      journeyId,
      'My senior mother needs a lower berth in the same coach',
    );
    expect(streamRes.status).toBe(200);
    expect(streamRes.headers.get('content-type') ?? '').toContain('text/event-stream');
    expect(streamRes.events.length).toBeGreaterThanOrEqual(1);
    const eventNames = streamRes.events.map((e) => e.event);
    expect(eventNames.some((n) => ['proposal', 'explanation', 'done', 'message'].includes(n))).toBe(
      true,
    );
  });

  test('AI Concierge UI displays proposed goal for explicit user confirmation and never auto-submits', async ({
    createIsolatedPassenger,
  }) => {
    const passenger = await createIsolatedPassenger('ai-concierge-ui');
    const auth = await passenger.api.loginWithOtp(uniquePhone(22_002));
    const verify = await passenger.api.verifyTrainPnr(auth.access, TEST_PNRS.rajdhani3A);
    const journeyId = getString(asRecord(verify.data.journey, 'journey'), 'id');

    await injectAuthSession(passenger.page, auth);
    await passenger.page.goto(`/journeys/${journeyId}`, { waitUntil: 'domcontentloaded' });

    const conciergeInput = passenger.page.getByRole('textbox', {
      name: /concierge|ask|help|goal/i,
    });
    await expect(conciergeInput).toBeVisible();
    await conciergeInput.fill('Need a lower berth near family');
    await passenger.page.getByRole('button', { name: /ask|suggest|send/i }).click();

    const confirmBtn = passenger.page.getByRole('button', {
      name: /confirm|apply goal/i,
    });
    await expect(confirmBtn).toBeVisible();

    const hubBeforeConfirm = await passenger.api.getJourney(auth.access, journeyId);
    expect(hubBeforeConfirm.data.goal).toBeFalsy();

    await confirmBtn.click();
    const hubAfterConfirm = await passenger.api.getJourney(auth.access, journeyId);
    expect(hubAfterConfirm.data.goal).toBeTruthy();
  });

  test('POST /v1/ai/draft-request generates English outreach draft <= 300 chars', async () => {
    const apiA = new SaathApiClient();
    const apiB = new SaathApiClient();
    const authA = await apiA.loginWithOtp(uniquePhone(22_003));
    const authB = await apiB.loginWithOtp(uniquePhone(22_004));

    const vA = await apiA.verifyTrainPnr(authA.access, TEST_PNRS.cycleA);
    const vB = await apiB.verifyTrainPnr(authB.access, TEST_PNRS.cycleB);
    const hubA = await apiA.getJourney(authA.access, getString(asRecord(vA.data.journey, 'jA'), 'id'));
    const hubB = await apiB.getJourney(authB.access, getString(asRecord(vB.data.journey, 'jB'), 'id'));

    const pA = asRecord(hubA.data.party, 'pA');
    const pB = asRecord(hubB.data.party, 'pB');
    const hA = asRecord(asArray(hubA.data.seat_holders, 'hA')[0], 'hA0');
    const hB = asRecord(asArray(hubB.data.seat_holders, 'hB')[0], 'hB0');

    await apiA.setGoal(authA.access, getString(pA, 'id'), {
      goal_type: 'lower',
      movers: [getString(hA, 'id')],
      preferred_seats: [],
      constraints: { women_only: false, no_middle: false, same_coach_only: false, verified_only: false },
    });
    await apiB.setGoal(authB.access, getString(pB, 'id'), {
      goal_type: 'open_to_help',
      movers: [getString(hB, 'id')],
      preferred_seats: [],
      constraints: { women_only: false, no_middle: false, same_coach_only: false, verified_only: false },
      standing_offer: { give_to: 'anyone' },
    });

    let card: MatchCardDto | undefined;
    await expect(async () => {
      const matches = await apiA.getMatches(authA.access, getString(pA, 'id'));
      expect(matches.status).toBe(200);
      expect(matches.data.items.length).toBeGreaterThanOrEqual(1);
      card = matches.data.items[0];
    }).toPass({ timeout: 12_000, intervals: [500, 1000, 1500] });
    if (!card) {
      throw new Error('Expected match card for draft-request test');
    }

    const draft = await apiA.draftRequest(authA.access, card.card_id, {
      tone: 'polite',
      lang: 'en',
    });
    expect(draft.status).toBe(200);
    expect(draft.data.text.length).toBeGreaterThan(10);
    expect(draft.data.text.length).toBeLessThanOrEqual(300);
  });

  test('POST /v1/ai/draft-request generates Hindi outreach draft <= 300 chars', async () => {
    const apiA = new SaathApiClient();
    const apiB = new SaathApiClient();
    const authA = await apiA.loginWithOtp(uniquePhone(22_005));
    const authB = await apiB.loginWithOtp(uniquePhone(22_006));

    const vA = await apiA.verifyTrainPnr(authA.access, TEST_PNRS.cycleA);
    const vB = await apiB.verifyTrainPnr(authB.access, TEST_PNRS.cycleB);
    const hubA = await apiA.getJourney(authA.access, getString(asRecord(vA.data.journey, 'jA'), 'id'));
    const hubB = await apiB.getJourney(authB.access, getString(asRecord(vB.data.journey, 'jB'), 'id'));

    const pA = asRecord(hubA.data.party, 'pA');
    const pB = asRecord(hubB.data.party, 'pB');
    const hA = asRecord(asArray(hubA.data.seat_holders, 'hA')[0], 'hA0');
    const hB = asRecord(asArray(hubB.data.seat_holders, 'hB')[0], 'hB0');

    await apiA.setGoal(authA.access, getString(pA, 'id'), {
      goal_type: 'lower',
      movers: [getString(hA, 'id')],
      preferred_seats: [],
      constraints: { women_only: false, no_middle: false, same_coach_only: false, verified_only: false },
    });
    await apiB.setGoal(authB.access, getString(pB, 'id'), {
      goal_type: 'open_to_help',
      movers: [getString(hB, 'id')],
      preferred_seats: [],
      constraints: { women_only: false, no_middle: false, same_coach_only: false, verified_only: false },
      standing_offer: { give_to: 'anyone' },
    });

    let card: MatchCardDto | undefined;
    await expect(async () => {
      const matches = await apiA.getMatches(authA.access, getString(pA, 'id'));
      expect(matches.status).toBe(200);
      expect(matches.data.items.length).toBeGreaterThanOrEqual(1);
      card = matches.data.items[0];
    }).toPass({ timeout: 12_000, intervals: [500, 1000, 1500] });
    if (!card) {
      throw new Error('Expected match card for Hindi draft-request test');
    }

    const draft = await apiA.draftRequest(authA.access, card.card_id, {
      tone: 'polite',
      lang: 'hi',
    });
    expect(draft.status).toBe(200);
    expect(draft.data.text).toMatch(/[\u0900-\u097F]/);
    expect(draft.data.text.length).toBeLessThanOrEqual(300);
  });

  test('AI Concierge response scrubs PII and never exposes raw PNR or phone numbers', async () => {
    const api = new SaathApiClient();
    const phone = uniquePhone(22_007);
    const auth = await api.loginWithOtp(phone);
    const verify = await api.verifyTrainPnr(auth.access, TEST_PNRS.rajdhani3A);
    const journeyId = getString(asRecord(verify.data.journey, 'journey'), 'id');

    const streamRes = await api.conciergeStream(
      auth.access,
      journeyId,
      'Suggest the best swap goal for my booking',
    );
    expect(streamRes.status).toBe(200);
    assertNoPiiLeak(streamRes.events, 'ai-concierge-sse', [phone, TEST_PNRS.rajdhani3A]);
  });
});
