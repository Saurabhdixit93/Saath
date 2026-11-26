import { test, expect, type Page } from '../../fixtures/multi-browser.js';
import { SaathApiClient, type MatchCardDto } from '../../helpers/api.js';
import { E2E_ENV, futureDateIso, uniquePhone, uniquePnr } from '../../helpers/env.js';

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

async function getAdminToken(api: SaathApiClient): Promise<string> {
  const res = await api.createAdminSession(E2E_ENV.adminTestEmail);
  expect([200, 201]).toContain(res.status);
  const adminToken = res.data.access ?? res.data.token;
  if (!adminToken) {
    throw new Error(
      `Expected admin access token from /v1/admin/auth/session, got: ${res.rawText}`,
    );
  }
  return adminToken;
}

async function createReportedMessage(
  api: SaathApiClient,
  seedPrefix: string,
  travelDate: string,
  seatA: string,
  seatB: string,
  messageText: string,
  reason: string,
): Promise<{
  authA: Awaited<ReturnType<SaathApiClient['loginWithOtp']>>;
  authB: Awaited<ReturnType<SaathApiClient['loginWithOtp']>>;
  convoId: string;
  messageId: string;
  reportId: string;
}> {
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
  const hubA = await api.getJourney(authA.access, getString(asRecord(vA.data.journey, 'jA'), 'id'));
  const hubB = await api.getJourney(authB.access, getString(asRecord(vB.data.journey, 'jB'), 'id'));
  const pA = getString(asRecord(hubA.data.party, 'pA'), 'id');
  const pB = getString(asRecord(hubB.data.party, 'pB'), 'id');

  await api.setGoal(authA.access, pA, {
    goal_type: 'lower',
    movers: [getString(asRecord(asArray(hubA.data.seat_holders, 'hA')[0], 'hA0'), 'id')],
    preferred_seats: [],
    constraints: { women_only: false, no_middle: false, same_coach_only: false, verified_only: false },
  });
  await api.setGoal(authB.access, pB, {
    goal_type: 'open_to_help',
    movers: [getString(asRecord(asArray(hubB.data.seat_holders, 'hB')[0], 'hB0'), 'id')],
    preferred_seats: [],
    constraints: { women_only: false, no_middle: false, same_coach_only: false, verified_only: false },
    standing_offer: { give_to: 'anyone' },
  });

  let card: MatchCardDto | undefined;
  await expect(async () => {
    const matches = await api.getMatches(authA.access, pA, 'pair');
    expect(matches.status).toBe(200);
    expect(matches.data.items.length).toBeGreaterThanOrEqual(1);
    card = matches.data.items[0];
  }).toPass({ timeout: 12_000, intervals: [500, 1000, 1500] });
  if (!card) {
    throw new Error('Expected match card');
  }

  const convo = await api.createConversation(authA.access, card.card_id);
  const convoId = getString(convo.data, 'id');
  const msg = await api.sendMessage(authB.access, convoId, messageText);
  expect([200, 201]).toContain(msg.status);
  const messageId = getString(msg.data, 'id');

  const report = await api.reportUser(authA.access, {
    conversation_id: convoId,
    message_id: messageId,
    reason,
  });
  expect([200, 201]).toContain(report.status);
  const reportId = getString(report.data, 'report_id');

  return { authA, authB, convoId, messageId, reportId };
}

async function signInAdminUi(page: Page, api: SaathApiClient): Promise<void> {
  await page.goto(`${E2E_ENV.adminUrl}/login`, { waitUntil: 'domcontentloaded' });
  const robotsMeta = page.locator('meta[name="robots"]');
  await expect(robotsMeta).toHaveAttribute('content', /noindex.*nofollow|nofollow.*noindex/i);

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
    return;
  }

  const token = await getAdminToken(api);
  await page.evaluate((t) => {
    window.localStorage.setItem('saath_access_token', t);
    window.localStorage.setItem('saath_admin_token', t);
  }, token);
  await page.goto(E2E_ENV.adminUrl, { waitUntil: 'domcontentloaded' });
}

test.describe('F31: Separate Admin Portal (apps/admin) @tier1', () => {
  test('POST /v1/admin/auth/session returns bearer token, expiry, email, and admin scopes', async () => {
    const api = new SaathApiClient();
    const res = await api.createAdminSession(E2E_ENV.adminTestEmail);
    expect([200, 201]).toContain(res.status);

    const token = res.data.access ?? res.data.token;
    expect(typeof token).toBe('string');
    expect((token ?? '').length).toBeGreaterThan(10);
    expect(String(res.data.token_type ?? '').toLowerCase()).toBe('bearer');
    expect(typeof res.data.expires_in).toBe('number');
    expect(Number(res.data.expires_in)).toBeGreaterThan(0);
    expect(String(res.data.email ?? '').toLowerCase()).toBe(
      E2E_ENV.adminTestEmail.toLowerCase(),
    );
    expect(Array.isArray(res.data.scopes)).toBe(true);
    expect((res.data.scopes ?? []).length).toBeGreaterThanOrEqual(1);
  });

  test('Admin Portal :3001 /login -> Dashboard, /moderation, /fraud, /flags, and /audit render with noindex, nofollow', async ({
    page,
  }) => {
    const api = new SaathApiClient();
    await signInAdminUi(page, api);

    await page.goto(E2E_ENV.adminUrl, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
      'content',
      /noindex.*nofollow|nofollow.*noindex/i,
    );
    await expect(page.getByText(/Funnel|Match rate|Verified/i).first()).toBeVisible();
    await expect(page.getByText(/Provider|Outbox|Health/i).first()).toBeVisible();

    await page.goto(`${E2E_ENV.adminUrl}/moderation`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(/Moderation|Queue/i).first()).toBeVisible();

    await page.goto(`${E2E_ENV.adminUrl}/fraud`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(/Fraud|Graph|Collusion/i).first()).toBeVisible();
    await expect(page.getByText(/Dispute|Redemption|Override/i).first()).toBeVisible();

    await page.goto(`${E2E_ENV.adminUrl}/flags`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(/Feature Flags|rewards_catalogue_enabled/i).first()).toBeVisible();

    await page.goto(`${E2E_ENV.adminUrl}/audit`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(/Audit/i).first()).toBeVisible();
  });

  test('Admin analytics funnel (with route/date filters) and provider health return required schema fields', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);

    const funnel = await api.getAdminFunnel(adminToken);
    expect(funnel.status).toBe(200);
    const counts = asRecord(
      funnel.data.counts ?? funnel.data.funnel ?? funnel.data,
      'funnel counts',
    );
    for (const key of [
      'verified',
      'goal_set',
      'matched',
      'swap_created',
      'swap_confirmed',
      'swap_completed',
    ]) {
      expect(typeof counts[key]).toBe('number');
      expect(Number(counts[key])).toBeGreaterThanOrEqual(0);
    }
    expect(funnel.data.match_rate).toBeDefined();
    expect(funnel.data.notification_delivery).toBeDefined();

    const filteredFunnel = await api.getAdminFunnel(adminToken, {
      route: '12951',
      from_date: '2026-01-01',
      to_date: '2027-01-01',
    });
    expect(filteredFunnel.status).toBe(200);

    const health = await api.getAdminProvidersHealth(adminToken);
    expect(health.status).toBe(200);
    const providers = asArray(health.data.providers, 'providers');
    expect(providers.length).toBeGreaterThanOrEqual(1);
    const outbox = asRecord(health.data.outbox, 'outbox');
    for (const key of ['queued', 'sent', 'dead_letter', 'lag_seconds']) {
      expect(typeof outbox[key]).toBe('number');
    }
  });

  test('Moderation queue lists open reports and executes dismiss, hide, restrict, and ban actions', async () => {
    const api = new SaathApiClient();
    const travelDate = futureDateIso(25);
    const adminToken = await getAdminToken(api);

    // 1. dismiss
    const repDismiss = await createReportedMessage(
      api,
      'f31-dismiss',
      travelDate,
      '1',
      '3',
      'Polite check message',
      'other',
    );
    const openQueue = await api.getAdminModerationQueue(adminToken, { status: 'open' });
    expect(openQueue.status).toBe(200);
    const openItems = asArray(openQueue.data.items, 'open moderation items');
    expect(
      openItems.some((item) => asRecord(item, 'item').id === repDismiss.reportId || asRecord(item, 'item').report_id === repDismiss.reportId),
    ).toBe(true);

    const dismissRes = await api.actOnModeration(
      adminToken,
      repDismiss.reportId,
      'dismiss',
      'False positive report',
    );
    expect(dismissRes.status).toBe(200);
    const afterDismissSend = await api.sendMessage(
      repDismiss.authB.access,
      repDismiss.convoId,
      'Still allowed after dismiss',
    );
    expect([200, 201]).toContain(afterDismissSend.status);

    // 2. hide
    const repHide = await createReportedMessage(
      api,
      'f31-hide',
      travelDate,
      '6',
      '11',
      'Offensive hidden message text',
      'abuse',
    );
    const hideRes = await api.actOnModeration(
      adminToken,
      repHide.reportId,
      'hide',
      'Abusive phrasing',
    );
    expect(hideRes.status).toBe(200);
    const msgsAfterHide = await api.getMessages(repHide.authA.access, repHide.convoId);
    expect(msgsAfterHide.status).toBe(200);
    const hiddenTarget = msgsAfterHide.data.items.find((m) => m.id === repHide.messageId);
    if (hiddenTarget) {
      const isMarkedHidden =
        hiddenTarget.hidden === true ||
        hiddenTarget.is_hidden === true ||
        hiddenTarget.moderation === 'hidden' ||
        hiddenTarget.status === 'hidden' ||
        hiddenTarget.body !== 'Offensive hidden message text';
      expect(isMarkedHidden).toBe(true);
    }

    // 3. restrict
    const repRestrict = await createReportedMessage(
      api,
      'f31-restrict',
      travelDate,
      '14',
      '19',
      'Restricted sender text',
      'spam',
    );
    const restrictRes = await api.actOnModeration(
      adminToken,
      repRestrict.reportId,
      'restrict',
      'Chat restriction applied',
    );
    expect(restrictRes.status).toBe(200);
    const sendAfterRestrict = await api.sendMessage(
      repRestrict.authB.access,
      repRestrict.convoId,
      'Blocked after restrict',
    );
    api.assertProblemJson(sendAfterRestrict, 403);

    // 4. ban (revokes JWT and refresh token)
    const repBan = await createReportedMessage(
      api,
      'f31-ban',
      travelDate,
      '22',
      '27',
      'Severe abuse leading to ban',
      'harassment',
    );
    const banRes = await api.actOnModeration(
      adminToken,
      repBan.reportId,
      'ban',
      'Repeated harassment',
    );
    expect(banRes.status).toBe(200);

    const meAfterBan = await api.getMe(repBan.authB.access);
    api.assertProblemJson(meAfterBan, [401, 403]);
    const refreshAfterBan = await api.refreshTokens(repBan.authB.refresh);
    api.assertProblemJson(refreshAfterBan, [401, 403]);
  });

  test('Fraud graph, feature flags (with cleanup), disputes, and redemptions contracts work and record audit_log', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);

    const auditBefore = await api.getAdminAuditLog<{ total?: number; items?: unknown[] }>(
      adminToken,
    );
    expect(auditBefore.status).toBe(200);
    const countBefore = Number(auditBefore.data.total ?? asArray(auditBefore.data.items, 'items').length);

    const fraud = await api.getAdminFraudGraph(adminToken);
    expect(fraud.status).toBe(200);
    expect(Array.isArray(fraud.data.nodes)).toBe(true);
    expect(Array.isArray(fraud.data.edges)).toBe(true);
    expect(Array.isArray(fraud.data.flagged_pairs)).toBe(true);
    expect(Array.isArray(fraud.data.shared_devices)).toBe(true);

    const auditAfterFraud = await api.getAdminAuditLog<{ total?: number; items?: unknown[] }>(
      adminToken,
    );
    expect(auditAfterFraud.status).toBe(200);
    const countAfterFraud = Number(
      auditAfterFraud.data.total ?? asArray(auditAfterFraud.data.items, 'items').length,
    );
    expect(countAfterFraud).toBeGreaterThan(countBefore);

    // Feature flags: update, re-read, and restore in finally
    const flagsBefore = await api.getAdminFlags(adminToken);
    expect(flagsBefore.status).toBe(200);
    const flagItems = asArray(
      flagsBefore.data.items ?? flagsBefore.data.flags ?? flagsBefore.data,
      'flags',
    );
    const existingFlag = flagItems.find(
      (f) => asRecord(f, 'flag').key === 'rewards_catalogue_enabled',
    );
    const originalValue = existingFlag
      ? Boolean(asRecord(existingFlag, 'flag').value)
      : true;

    try {
      const patch = await api.patchAdminFlag(
        adminToken,
        'rewards_catalogue_enabled',
        !originalValue,
        'E2E toggle verification',
      );
      expect(patch.status).toBe(200);

      const flagsAfter = await api.getAdminFlags(adminToken);
      expect(flagsAfter.status).toBe(200);
      const updatedItems = asArray(
        flagsAfter.data.items ?? flagsAfter.data.flags ?? flagsAfter.data,
        'updated flags',
      );
      const updatedFlag = updatedItems.find(
        (f) => asRecord(f, 'flag').key === 'rewards_catalogue_enabled',
      );
      expect(updatedFlag).toBeDefined();
      expect(Boolean(asRecord(updatedFlag, 'updated flag').value)).toBe(!originalValue);
    } finally {
      const restore = await api.patchAdminFlag(
        adminToken,
        'rewards_catalogue_enabled',
        originalValue,
        'Restore after E2E test',
      );
      expect(restore.status).toBe(200);
    }

    // Disputes & Redemptions list + optional override/review when present
    const disputes = await api.getAdminDisputes(adminToken);
    expect(disputes.status).toBe(200);
    const disputeList = asArray(
      disputes.data.items ?? disputes.data.disputes ?? disputes.data,
      'disputes',
    );
    if (disputeList.length > 0) {
      const firstDispute = asRecord(disputeList[0], 'first dispute');
      const disputeId = String(firstDispute.id ?? firstDispute.dispute_id ?? '');
      if (disputeId) {
        const overrideRes = await api.overrideAdminDispute(adminToken, disputeId, {
          resolution: 'mark_completed',
          note: 'E2E dispute override check',
        });
        expect([200, 201]).toContain(overrideRes.status);
      }
    }

    const redemptions = await api.getAdminRedemptions(adminToken);
    expect(redemptions.status).toBe(200);
    const redemptionList = asArray(
      redemptions.data.items ?? redemptions.data.redemptions ?? redemptions.data,
      'redemptions',
    );
    if (redemptionList.length > 0) {
      const firstRedemption = asRecord(redemptionList[0], 'first redemption');
      const redemptionId = String(firstRedemption.id ?? firstRedemption.redemption_id ?? '');
      if (redemptionId) {
        const reviewRes = await api.reviewAdminRedemption(adminToken, redemptionId, {
          decision: 'approve',
          note: 'E2E redemption review check',
        });
        expect([200, 201]).toContain(reviewRes.status);
      }
    }
  });

  test('Admin audit log returns structured entries and supports action, actor, limit, and offset filters', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);

    await api.getAdminModerationQueue(adminToken);
    const audit = await api.getAdminAuditLog(adminToken, { limit: 5, offset: 0 });
    expect(audit.status).toBe(200);
    expect(typeof audit.data.total).toBe('number');
    const rows = asArray(audit.data.items ?? audit.data.entries ?? audit.data, 'audit rows');
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.length).toBeLessThanOrEqual(5);

    const first = asRecord(rows[0], 'first audit row');
    expect(typeof first.action).toBe('string');
    expect(typeof (first.actor ?? first.actor_id ?? first.actor_email)).toBe('string');
    expect(typeof (first.created_at ?? first.at)).toBe('string');

    const actionFilter = String(first.action);
    const actorFilter = String(first.actor ?? first.actor_id ?? first.actor_email);

    const filtered = await api.getAdminAuditLog(adminToken, {
      action: actionFilter,
      actor: actorFilter,
      limit: 2,
      offset: 0,
    });
    expect(filtered.status).toBe(200);
    const filteredRows = asArray(
      filtered.data.items ?? filtered.data.entries ?? filtered.data,
      'filtered audit rows',
    );
    expect(filteredRows.length).toBeLessThanOrEqual(2);
    for (const row of filteredRows) {
      const r = asRecord(row, 'filtered row');
      expect(String(r.action)).toBe(actionFilter);
    }
  });
});
