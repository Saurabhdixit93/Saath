import { test, expect, type Page } from '../../fixtures/multi-browser.js';
import { assertTapTargets, assertWcagAA } from '../../helpers/a11y.js';
import { SaathApiClient, type MatchCardDto } from '../../helpers/api.js';
import { E2E_ENV, futureDateIso, uniquePhone, uniquePnr } from '../../helpers/env.js';
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

async function getAdminToken(api: SaathApiClient): Promise<string> {
  const session = await api.createAdminSession(E2E_ENV.adminTestEmail);
  expect([200, 201]).toContain(session.status);
  const adminToken = session.data.access ?? session.data.token ?? '';
  expect(adminToken.length).toBeGreaterThan(0);
  return adminToken;
}

async function createRealReport(api: SaathApiClient, seed: string): Promise<string> {
  const travelDate = futureDateIso(26);
  const authA = await api.loginWithOtp(uniquePhone(`${seed}-a`));
  const authB = await api.loginWithOtp(uniquePhone(`${seed}-b`));

  const vA = await api.verifyTrainSms(
    authA.access,
    `IRCTC PNR:${uniquePnr(`${seed}-a`)},TRN:12951,DOJ:${travelDate},CLS:3A,B3 1 LB,NDLS-MMCT`,
  );
  const vB = await api.verifyTrainSms(
    authB.access,
    `IRCTC PNR:${uniquePnr(`${seed}-b`)},TRN:12951,DOJ:${travelDate},CLS:3A,B3 3 UB,NDLS-MMCT`,
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
  const msg = await api.sendMessage(authB.access, convoId, 'Report target for validation test');
  const report = await api.reportUser(authA.access, {
    conversation_id: convoId,
    message_id: getString(msg.data, 'id'),
    reason: 'spam',
  });
  return getString(report.data, 'report_id');
}

async function signInAdminUi(page: Page, api: SaathApiClient): Promise<void> {
  await page.goto(`${E2E_ENV.adminUrl}/login`, { waitUntil: 'domcontentloaded' });
  if (E2E_ENV.envMode !== 'production') {
    const emailInput = page
      .getByLabel(/email/i)
      .or(page.getByPlaceholder(/email|ops@saath/i))
      .or(page.getByRole('textbox'))
      .first();
    if ((await emailInput.count()) > 0) {
      await emailInput.fill(E2E_ENV.adminTestEmail);
      await page
        .getByRole('button', { name: /sign in|login|continue|session|submit/i })
        .first()
        .click();
      await expect(page).not.toHaveURL(/\/login$/);
      return;
    }
  }
  const token = await getAdminToken(api);
  await page.evaluate((t) => {
    window.localStorage.setItem('saath_access_token', t);
    window.localStorage.setItem('saath_admin_token', t);
  }, token);
}

test.describe('F31 Tier 2: Admin Portal AuthZ, Prod Guards, Validation & A11y @tier2', () => {
  test('Unauthenticated, invalid/tampered admin JWT, and non-allowlisted SSO emails return 401/403 RFC 9457', async () => {
    const api = new SaathApiClient();

    const queueUnauth = await api.request('GET', '/v1/admin/moderation/queue');
    api.assertProblemJson(queueUnauth, 401);

    const auditUnauth = await api.request('GET', '/v1/admin/audit-log');
    api.assertProblemJson(auditUnauth, 401);

    const invalidJwtQueue = await api.getAdminModerationQueue('invalid.admin.jwt');
    api.assertProblemJson(invalidJwtQueue, 401);

    const nonAllowlisted = await api.createAdminSession('intruder@evil.example');
    api.assertProblemJson(nonAllowlisted, 403);

    const badOidc = await api.createAdminSession(undefined, {
      id_token: 'invalid.oidc.id.token',
    });
    api.assertProblemJson(badOidc, [401, 403, 422]);

    if (E2E_ENV.envMode === 'production') {
      const prodPasswordless = await api.createAdminSession(E2E_ENV.adminTestEmail);
      api.assertProblemJson(prodPasswordless, [401, 403]);
    }
  });

  test('Regular passenger JWT cannot access /v1/admin/* endpoints (403)', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone(312_001));

    const queue = await api.getAdminModerationQueue(auth.access);
    api.assertProblemJson(queue, 403);

    const flags = await api.getAdminFlags(auth.access);
    api.assertProblemJson(flags, 403);

    const disputes = await api.getAdminDisputes(auth.access);
    api.assertProblemJson(disputes, 403);

    const redemptions = await api.getAdminRedemptions(auth.access);
    api.assertProblemJson(redemptions, 403);
  });

  test('Production route guard: /test-login and /admin/reset-demo are absent when ENV=production', async () => {
    const api = new SaathApiClient();
    const testLoginRes = await api.request('POST', '/test-login', {
      body: { phone: uniquePhone(312_002) },
    });
    const resetRes = await api.request('POST', '/admin/reset-demo');

    const expectedStatuses = E2E_ENV.envMode === 'production' ? [404, 405] : [200, 404, 405];
    expect(expectedStatuses).toContain(testLoginRes.status);
    expect(expectedStatuses).toContain(resetRes.status);
  });

  test('Invalid moderation action returns 422 on real report, nonexistent report returns 404, and unknown flag/dispute/redemption/date return 404/422 RFC 9457', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);
    const realReportId = await createRealReport(api, 'f31-t2-val');

    const invalidActionRes = await api.actOnModeration(
      adminToken,
      realReportId,
      'invalid_action_xyz',
    );
    api.assertProblemJson(invalidActionRes, 422);

    const missingReportRes = await api.actOnModeration(
      adminToken,
      '00000000-0000-0000-0000-000000000001',
      'dismiss',
    );
    api.assertProblemJson(missingReportRes, 404);

    const unknownFlagRes = await api.patchAdminFlag(adminToken, 'unknown_flag_xyz', true);
    api.assertProblemJson(unknownFlagRes, [404, 422]);

    const unknownDisputeRes = await api.overrideAdminDispute(
      adminToken,
      '00000000-0000-0000-0000-000000000001',
      { resolution: 'mark_completed', note: 'missing' },
    );
    api.assertProblemJson(unknownDisputeRes, [404, 422]);

    const unknownRedemptionRes = await api.reviewAdminRedemption(
      adminToken,
      '00000000-0000-0000-0000-000000000001',
      { decision: 'approve', note: 'missing' },
    );
    api.assertProblemJson(unknownRedemptionRes, [404, 422]);

    const badFunnelDate = await api.getAdminFunnel(adminToken, { from_date: 'not-a-date' });
    api.assertProblemJson(badFunnelDate, 422);
  });

  test('Viewing fraud graph appends an entry to audit_log', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);

    const before = await api.getAdminAuditLog(adminToken);
    expect(before.status).toBe(200);
    const beforeCount =
      typeof before.data.total === 'number'
        ? before.data.total
        : asArray(before.data.items ?? before.data.entries ?? before.data, 'before').length;

    const fraudRes = await api.getAdminFraudGraph(adminToken);
    expect(fraudRes.status).toBe(200);

    const after = await api.getAdminAuditLog(adminToken);
    expect(after.status).toBe(200);
    const afterCount =
      typeof after.data.total === 'number'
        ? after.data.total
        : asArray(after.data.items ?? after.data.entries ?? after.data, 'after').length;
    expect(afterCount).toBeGreaterThan(beforeCount);
  });

  test('Unauthenticated Admin UI routes redirect/gate to /login without leaking PII, and Admin Portal passes WCAG 2.2 AA & tap targets', async ({
    browser,
  }) => {
    const api = new SaathApiClient();
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      for (const route of ['/moderation', '/fraud', '/flags', '/audit']) {
        await page.goto(`${E2E_ENV.adminUrl}${route}`, { waitUntil: 'domcontentloaded' });
        const bodyText = await page.locator('body').innerText();
        assertNoPiiLeak({ text: bodyText }, `unauth-admin-${route}`);
        const onLoginRoute = /\/login/.test(page.url());
        const hasLoginGate = /sign in|operator sso|login/i.test(bodyText);
        expect(onLoginRoute || hasLoginGate).toBe(true);
      }

      await page.goto(`${E2E_ENV.adminUrl}/login`, { waitUntil: 'domcontentloaded' });
      await assertWcagAA(page);
      await assertTapTargets(page);

      await signInAdminUi(page, api);

      for (const route of ['/', '/moderation', '/fraud', '/flags', '/audit']) {
        await page.goto(`${E2E_ENV.adminUrl}${route}`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByRole('heading').first()).toBeVisible();
        await assertWcagAA(page);
        await assertTapTargets(page);
      }
    } finally {
      await context.close();
    }
  });
});
