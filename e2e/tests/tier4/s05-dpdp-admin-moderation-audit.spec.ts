import { test, expect, injectAuthSession } from '../../fixtures/multi-browser.js';
import { type MatchCardDto } from '../../helpers/api.js';
import { E2E_ENV, TEST_PNRS, uniquePhone } from '../../helpers/env.js';

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

test.describe('S05: Solo-Woman Safety, Admin Moderation, Audit Log & DPDP Erasure @tier4', () => {
  test('women_only matching + chat report -> Admin :3001 moderation & audit_log -> DPDP consent, export zip & DELETE /me erasure', async ({
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

    // Chat abuse + redaction + report -> Admin Portal :3001 moderation + audit_log
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

    const adminSession = await woman.api.request<{ access?: string; token?: string }>(
      'POST',
      '/v1/admin/auth/session',
      { body: { email: E2E_ENV.adminTestEmail } },
    );
    expect([200, 201]).toContain(adminSession.status);
    const adminToken = adminSession.data.access ?? adminSession.data.token ?? '';
    expect(adminToken.length).toBeGreaterThan(0);

    const adminOperator = await createIsolatedPassenger('admin-operator');
    await injectAuthSession(adminOperator.page, { access: adminToken }, E2E_ENV.adminUrl);
    await adminOperator.context.addCookies([
      { name: 'saath_admin_token', value: adminToken, url: E2E_ENV.adminUrl },
    ]);
    await adminOperator.page.goto(`${E2E_ENV.adminUrl}/moderation`, {
      waitUntil: 'domcontentloaded',
    });
    await expect(adminOperator.page.getByText(/Moderation|Queue/i).first()).toBeVisible();

    const modAction = await woman.api.actOnModeration(adminToken, reportId, 'restrict');
    expect(modAction.status).toBe(200);

    const blockedSend = await femaleHelper.api.sendMessage(
      authFemale.access,
      convoId,
      'Message after admin restrict',
    );
    femaleHelper.api.assertProblemJson(blockedSend, 403);

    const audit = await woman.api.getAdminAuditLog(adminToken);
    expect(audit.status).toBe(200);
    expect(asArray(audit.data.items ?? audit.data.entries ?? audit.data, 'audit').length).toBeGreaterThanOrEqual(1);

    // DPDP Consents + Export ZIP + Delete Erasure on woman account
    const consentRes = await woman.api.saveConsents(authWoman.access, [
      { purpose: 'verification', notice_version: '1.0', granted: true },
      { purpose: 'analytics', notice_version: '1.0', granted: false },
    ]);
    expect([200, 201]).toContain(consentRes.status);

    await injectAuthSession(woman.page, authWoman);
    await woman.page.goto('/profile', { waitUntil: 'domcontentloaded' });
    await expect(woman.page.getByRole('button', { name: /Download my data|Export/i })).toBeVisible();

    const zipRes = await woman.api.exportMyData(authWoman.access);
    expect(zipRes.status).toBe(200);
    expect(zipRes.buffer.subarray(0, 2).toString('utf8')).toBe('PK');

    const delRes = await woman.api.deleteMyAccount(authWoman.access);
    expect([200, 202]).toContain(delRes.status);

    const postDeleteMe = await woman.api.getMe(authWoman.access);
    woman.api.assertProblemJson(postDeleteMe, [401, 403, 404]);
  });
});
