import { test, expect } from '../../fixtures/multi-browser.js';
import { SaathApiClient, type MatchCardDto } from '../../helpers/api.js';
import { E2E_ENV, TEST_PNRS, uniquePhone } from '../../helpers/env.js';
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

function getNumber(obj: Record<string, unknown>, key: string): number {
  const val = obj[key];
  if (typeof val !== 'number') {
    throw new Error(`Expected number "${key}"`);
  }
  return val;
}

test.describe('F32 Tier 2: DPDP Erasure, Token Revocation, CSP & Minor Safety @tier2', () => {
  test('Unauthenticated DPDP endpoints return 401 and invalid consent purpose returns 422 RFC 9457', async () => {
    const api = new SaathApiClient();

    const g = await api.request('GET', '/v1/me/consents');
    api.assertProblemJson(g, 401);

    const c = await api.request('POST', '/v1/me/consents', { body: { consents: [] } });
    api.assertProblemJson(c, 401);

    const e = await api.request('GET', '/v1/me/export');
    api.assertProblemJson(e, 401);

    const d = await api.request('DELETE', '/v1/me');
    api.assertProblemJson(d, 401);

    const auth = await api.loginWithOtp(uniquePhone(322_000));
    const invalidPurpose = await api.saveConsents(auth.access, [
      { purpose: 'sell_to_brokers', notice_version: '1.0', granted: true },
    ]);
    api.assertProblemJson(invalidPurpose, 422);
  });

  test('After DELETE /v1/me, existing JWT and refresh token are denied across profile, journeys, karma, export, and consents', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone(322_001));
    await api.verifyTrainPnr(auth.access, TEST_PNRS.rajdhani3A);

    const del = await api.deleteMyAccount(auth.access);
    expect([200, 202]).toContain(del.status);

    const refreshAfter = await api.refreshTokens(auth.refresh);
    api.assertProblemJson(refreshAfter, [401, 403]);

    const meAfter = await api.getMe(auth.access);
    api.assertProblemJson(meAfter, [401, 403, 404]);

    const journeysAfter = await api.getJourneys(auth.access);
    api.assertProblemJson(journeysAfter, [401, 403, 404]);

    const karmaAfter = await api.getKarma(auth.access);
    api.assertProblemJson(karmaAfter, [401, 403, 404]);

    const consentsAfter = await api.getConsents(auth.access);
    api.assertProblemJson(consentsAfter, [401, 403, 404]);

    const exportAfter = await api.exportMyData(auth.access);
    expect([401, 403, 404]).toContain(exportAfter.status);
  });

  test('DELETE /v1/me removes erased user from karma leaderboard while keeping partner swap intact without PII', async () => {
    const api = new SaathApiClient();
    const phoneA = uniquePhone(322_010);
    const phoneB = uniquePhone(322_011);
    const authA = await api.loginWithOtp(phoneA);
    const authB = await api.loginWithOtp(phoneB);

    const aliasB = 'EphemeralUser322';
    await api.patchMe(authB.access, {
      display_alias: aliasB,
      leaderboard_opt_in: true,
    });

    const vA = await api.verifyTrainPnr(authA.access, TEST_PNRS.cycleA);
    const vB = await api.verifyTrainPnr(authB.access, TEST_PNRS.cycleB);
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
      const m = await api.getMatches(authA.access, pA, 'pair');
      expect(m.status).toBe(200);
      expect(m.data.items.length).toBeGreaterThanOrEqual(1);
      card = m.data.items[0];
    }).toPass({ timeout: 12_000, intervals: [500, 1000, 1500] });
    if (!card) {
      throw new Error('Expected match card');
    }

    const swap = await api.createSwap(authA.access, card.card_id);
    const swapId = getString(swap.data, 'id');
    const accA = await api.acceptSwap(authA.access, swapId, getNumber(swap.data, 'version'));
    await api.acceptSwap(authB.access, swapId, getNumber(accA.data, 'version'));
    await api.confirmCompletion(authA.access, swapId, 'yes');
    await api.confirmCompletion(authB.access, swapId, 'yes');

    const karmaBBefore = await api.getKarma(authB.access);
    expect(Number(karmaBBefore.data.balance)).toBeGreaterThan(0);

    const del = await api.deleteMyAccount(authB.access);
    expect([200, 202]).toContain(del.status);
    expect(JSON.stringify(del.data)).not.toContain(phoneB);

    const karmaAAfter = await api.getKarma(authA.access);
    expect(karmaAAfter.status).toBe(200);
    expect(JSON.stringify(karmaAAfter.data.leaderboard ?? [])).not.toContain(aliasB);

    const partnerSwap = await api.getSwap(authA.access, swapId);
    expect(partnerSwap.status).toBe(200);
    expect(partnerSwap.data.status).toBe('completed');
    assertNoPiiLeak(partnerSwap.data, 'partner-swap-after-erasure', [phoneB, aliasB]);
  });

  test('Party / journey DTOs for bookings with children never expose raw minor name or age', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone(322_003));
    const verify = await api.verifyTrainPnr(auth.access, TEST_PNRS.rajdhani3A);
    const jId = getString(asRecord(verify.data.journey, 'j'), 'id');
    const hub = await api.getJourney(auth.access, jId);

    assertNoPiiLeak(verify.data, 'dpdp-verify-no-minor-pii');
    assertNoPiiLeak(hub.data, 'dpdp-hub-no-minor-pii');
  });

  test('Withdrawing optional analytics & notification consents persists granted=false and apps/web serves nonce-based CSP', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone(322_004));

    await api.saveConsents(auth.access, [
      { purpose: 'analytics', notice_version: '1.0', granted: true },
      { purpose: 'notifications', notice_version: '1.0', granted: true },
    ]);

    const withdraw = await api.saveConsents(auth.access, [
      { purpose: 'analytics', notice_version: '1.0', granted: false },
      { purpose: 'notifications', notice_version: '1.0', granted: false },
    ]);
    expect([200, 201]).toContain(withdraw.status);
    const rows = Array.isArray(withdraw.data.consents)
      ? (withdraw.data.consents as Array<Record<string, unknown>>)
      : [];
    expect(rows.some((r) => r.purpose === 'analytics' && r.granted === false)).toBe(true);

    const webRes = await fetch(E2E_ENV.webUrl);
    expect(webRes.status).toBe(200);
    const csp = webRes.headers.get('content-security-policy') ?? '';
    expect(csp).toContain('nonce-');
    const scriptSrcMatch = /script-src[^;]*/i.exec(csp);
    expect(scriptSrcMatch).not.toBeNull();
    expect(scriptSrcMatch?.[0] ?? '').not.toContain("'unsafe-inline'");
  });
});
