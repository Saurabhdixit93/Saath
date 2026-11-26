import fs from 'node:fs/promises';
import { test, expect, injectAuthSession, type Page } from '../../fixtures/multi-browser.js';
import { SaathApiClient, type MatchCardDto } from '../../helpers/api.js';
import { E2E_ENV, TEST_PNRS, uniquePhone } from '../../helpers/env.js';
import { parseDpdpExportZip } from '../../helpers/zip.js';

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

async function authenticateAdminBrowser(
  page: Page,
  api: SaathApiClient,
): Promise<string> {
  const adminSession = await api.createAdminSession(E2E_ENV.adminTestEmail);
  expect([200, 201]).toContain(adminSession.status);
  const adminToken = adminSession.data.access ?? adminSession.data.token ?? '';
  expect(adminToken.length).toBeGreaterThan(0);

  if (E2E_ENV.envMode !== 'production') {
    await page.goto(`${E2E_ENV.adminUrl}/login`, { waitUntil: 'domcontentloaded' });
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
      return adminToken;
    }
  }

  await injectAuthSession(page, { access: adminToken }, E2E_ENV.adminUrl);
  await page.context().addCookies([
    { name: 'saath_admin_token', value: adminToken, url: E2E_ENV.adminUrl },
  ]);
  return adminToken;
}

test.describe('S05: Solo-Woman Safety, Admin Moderation, Audit Log & DPDP Erasure @tier4', () => {
  test('women_only matching + chat report -> Admin :3001 moderation, fraud & audit UI -> DPDP profile export zip & delete UI', async ({
    threePassengers,
    createIsolatedPassenger,
  }) => {
    const { userA: woman, userB: maleStranger, userC: femaleHelper } = threePassengers;

    const authWoman = await woman.api.loginWithOtp(uniquePhone(405_001));
    const authMale = await maleStranger.api.loginWithOtp(uniquePhone(405_002));
    const authFemale = await femaleHelper.api.loginWithOtp(uniquePhone(405_003));

    await woman.api.patchMe(authWoman.access, { gender_self: 'female' });
    await maleStranger.api.patchMe(authMale.access, { gender_self: 'male' });
    await femaleHelper.api.patchMe(authFemale.access, { gender_self: 'female' });

    const [vW, vM, vF] = await Promise.all([
      woman.api.verifyTrainPnr(authWoman.access, TEST_PNRS.cycleA),
      maleStranger.api.verifyTrainPnr(authMale.access, TEST_PNRS.cycleB),
      femaleHelper.api.verifyTrainPnr(authFemale.access, TEST_PNRS.cycleC),
    ]);

    const hubW = await woman.api.getJourney(
      authWoman.access,
      getString(asRecord(vW.data.journey, 'jW'), 'id'),
    );
    const hubM = await maleStranger.api.getJourney(
      authMale.access,
      getString(asRecord(vM.data.journey, 'jM'), 'id'),
    );
    const hubF = await femaleHelper.api.getJourney(
      authFemale.access,
      getString(asRecord(vF.data.journey, 'jF'), 'id'),
    );

    const pW = getString(asRecord(hubW.data.party, 'pW'), 'id');
    const pM = getString(asRecord(hubM.data.party, 'pM'), 'id');
    const pF = getString(asRecord(hubF.data.party, 'pF'), 'id');

    await maleStranger.api.setGoal(authMale.access, pM, {
      goal_type: 'open_to_help',
      movers: [getString(asRecord(asArray(hubM.data.seat_holders, 'hM')[0], 'hM0'), 'id')],
      preferred_seats: [],
      constraints: { women_only: false, no_middle: false, same_coach_only: false, verified_only: false },
      standing_offer: { give_to: 'anyone' },
    });
    await femaleHelper.api.setGoal(authFemale.access, pF, {
      goal_type: 'open_to_help',
      movers: [getString(asRecord(asArray(hubF.data.seat_holders, 'hF')[0], 'hF0'), 'id')],
      preferred_seats: [],
      constraints: { women_only: false, no_middle: false, same_coach_only: false, verified_only: false },
      standing_offer: { give_to: 'women' },
    });
    await woman.api.setGoal(authWoman.access, pW, {
      goal_type: 'lower',
      movers: [getString(asRecord(asArray(hubW.data.seat_holders, 'hW')[0], 'hW0'), 'id')],
      preferred_seats: [],
      constraints: { women_only: true, no_middle: false, same_coach_only: false, verified_only: false },
    });

    // Only femaleHelper matches under women_only=true
    let firstCard: MatchCardDto | undefined;
    await expect(async () => {
      const matchesW = await woman.api.getMatches(authWoman.access, pW);
      expect(matchesW.status).toBe(200);
      expect(matchesW.data.items.length).toBeGreaterThanOrEqual(1);
      firstCard = matchesW.data.items[0];
    }).toPass({ timeout: 12_000, intervals: [500, 1000, 1500] });
    if (!firstCard) {
      throw new Error('Expected female-only match card');
    }

    // Chat abuse + redaction + report -> Admin Portal :3001 moderation UI + fraud UI + audit UI
    const convo = await woman.api.createConversation(authWoman.access, firstCard.card_id);
    const convoId = getString(convo.data, 'id');
    const badMsg = await femaleHelper.api.sendMessage(
      authFemale.access,
      convoId,
      'Reach me at 9988776655 or scam@okicici',
    );
    expect(badMsg.data.moderation).toBe('redacted');

    const report = await woman.api.reportUser(authWoman.access, {
      conversation_id: convoId,
      message_id: getString(badMsg.data, 'id'),
      reason: 'suspicious_contact_sharing',
    });
    const reportId = getString(report.data, 'report_id');

    const adminOperator = await createIsolatedPassenger('admin-operator');
    const adminToken = await authenticateAdminBrowser(adminOperator.page, woman.api);

    await adminOperator.page.goto(`${E2E_ENV.adminUrl}/moderation`, {
      waitUntil: 'domcontentloaded',
    });
    await expect(adminOperator.page.getByText(/Moderation|Queue/i).first()).toBeVisible();
    await expect(
      adminOperator.page.getByText(/suspicious_contact_sharing/i).first(),
    ).toBeVisible();

    // Execute restrict via /moderation UI
    const reportContainer = adminOperator.page
      .locator('tr, article, li, [data-report-id]')
      .filter({ hasText: /suspicious_contact_sharing/i })
      .first();
    const restrictBtn = reportContainer
      .getByRole('button', { name: /restrict/i })
      .or(adminOperator.page.getByRole('button', { name: /restrict/i }))
      .first();
    await expect(restrictBtn).toBeVisible();
    await Promise.all([
      adminOperator.page.waitForResponse(
        (res) =>
          res.url().includes('/v1/admin/moderation/') &&
          res.url().includes('/action') &&
          res.request().method() === 'POST',
      ),
      restrictBtn.click(),
    ]);

    const blockedSend = await femaleHelper.api.sendMessage(
      authFemale.access,
      convoId,
      'Message after admin restrict',
    );
    femaleHelper.api.assertProblemJson(blockedSend, 403);

    // Check /fraud UI (graph + dispute/redemption override section) and /audit UI
    await adminOperator.page.goto(`${E2E_ENV.adminUrl}/fraud`, {
      waitUntil: 'domcontentloaded',
    });
    await expect(adminOperator.page.getByText(/Fraud|Graph|Collusion/i).first()).toBeVisible();
    await expect(
      adminOperator.page.getByText(/Dispute|Redemption|Override/i).first(),
    ).toBeVisible();

    await adminOperator.page.goto(`${E2E_ENV.adminUrl}/audit`, {
      waitUntil: 'domcontentloaded',
    });
    await expect(adminOperator.page.getByText(/Audit/i).first()).toBeVisible();
    await expect(
      adminOperator.page.getByText(/restrict|moderation|fraud/i).first(),
    ).toBeVisible();

    const audit = await woman.api.getAdminAuditLog(adminToken);
    expect(audit.status).toBe(200);
    expect(
      asArray(audit.data.items ?? audit.data.entries ?? audit.data, 'audit').length,
    ).toBeGreaterThanOrEqual(1);
    expect(reportId.length).toBeGreaterThan(0);

    // DPDP Consents + UI Export ZIP + UI Delete Erasure on woman account
    const consentRes = await woman.api.saveConsents(authWoman.access, [
      { purpose: 'verification', notice_version: '1.0', granted: true },
      { purpose: 'analytics', notice_version: '1.0', granted: false },
    ]);
    expect([200, 201]).toContain(consentRes.status);

    await injectAuthSession(woman.page, authWoman);
    await woman.page.goto('/profile', { waitUntil: 'domcontentloaded' });
    const downloadBtn = woman.page.getByRole('button', { name: /Download my data|Export/i });
    await expect(downloadBtn).toBeVisible();

    const [download] = await Promise.all([
      woman.page.waitForEvent('download'),
      downloadBtn.click(),
    ]);
    const downloadPath = await download.path();
    expect(downloadPath).toBeTruthy();
    if (downloadPath) {
      const zipBytes = await fs.readFile(downloadPath);
      expect(zipBytes.subarray(0, 2).toString('utf8')).toBe('PK');
      const bundle = parseDpdpExportZip(zipBytes);
      expect(Object.keys(bundle)).toHaveLength(8);
    }

    const deleteBtn = woman.page.getByRole('button', {
      name: /Delete my data|Delete account/i,
    });
    await expect(deleteBtn).toBeVisible();
    await deleteBtn.click();
    const confirmDeleteBtn = woman.page
      .getByRole('button', { name: /confirm delete|yes, delete|permanently delete|erase/i })
      .first();
    if ((await confirmDeleteBtn.count()) > 0) {
      await confirmDeleteBtn.click();
    }

    await expect
      .poll(
        async () =>
          woman.page.evaluate(
            () => window.localStorage.getItem('saath_access_token') ?? '',
          ),
        { timeout: 10_000 },
      )
      .toBe('');

    const postDeleteMe = await woman.api.getMe(authWoman.access);
    woman.api.assertProblemJson(postDeleteMe, [401, 403, 404]);

    const postDeleteRefresh = await woman.api.refreshTokens(authWoman.refresh);
    woman.api.assertProblemJson(postDeleteRefresh, [401, 403]);
  });
});
