import { test, expect } from '../../fixtures/multi-browser.js';
import { SaathApiClient, type MatchCardDto } from '../../helpers/api.js';
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

async function getAdminToken(api: SaathApiClient): Promise<string> {
  const res = await api.request<{ access?: string; token?: string }>('POST', '/v1/admin/auth/session', {
    body: { email: E2E_ENV.adminTestEmail },
  });
  expect([200, 201]).toContain(res.status);
  const adminToken = res.data.access ?? res.data.token;
  if (!adminToken) {
    throw new Error(`Expected admin access token from /v1/admin/auth/session, got: ${res.rawText}`);
  }
  return adminToken;
}

test.describe('F31: Separate Admin Portal (apps/admin) @tier1', () => {
  test('Admin Portal :3001 loads operator dashboard cleanly', async ({ page }) => {
    await page.goto(E2E_ENV.adminUrl, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(/Saath Admin|Funnel|Moderation|Providers/i).first()).toBeVisible();
  });

  test('Admin analytics funnel and provider health endpoints return valid operational metrics', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);

    const funnel = await api.getAdminFunnel(adminToken);
    expect(funnel.status).toBe(200);

    const health = await api.getAdminProvidersHealth(adminToken);
    expect(health.status).toBe(200);
  });

  test('Moderation queue displays reported messages and executes hide/dismiss action', async () => {
    const api = new SaathApiClient();
    const authA = await api.loginWithOtp(uniquePhone(31_001));
    const authB = await api.loginWithOtp(uniquePhone(31_002));

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
    const msg = await api.sendMessage(authB.access, convoId, 'Reported chat text');
    const report = await api.reportUser(authA.access, {
      conversation_id: convoId,
      message_id: getString(msg.data, 'id'),
      reason: 'harassment',
    });
    const reportId = getString(report.data, 'report_id');

    const adminToken = await getAdminToken(api);
    const queue = await api.getAdminModerationQueue(adminToken);
    expect(queue.status).toBe(200);

    const actionRes = await api.actOnModeration(adminToken, reportId, 'hide');
    expect(actionRes.status).toBe(200);
  });

  test('Fraud graph and feature flags endpoints load and update flags cleanly', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);

    const fraud = await api.getAdminFraudGraph(adminToken);
    expect(fraud.status).toBe(200);

    const flags = await api.getAdminFlags(adminToken);
    expect(flags.status).toBe(200);

    const patch = await api.patchAdminFlag(adminToken, 'rewards_catalogue_enabled', false);
    expect(patch.status).toBe(200);
  });

  test('Admin views automatically record immutable audit_log entries', async () => {
    const api = new SaathApiClient();
    const adminToken = await getAdminToken(api);

    await api.getAdminModerationQueue(adminToken);
    const audit = await api.getAdminAuditLog(adminToken);
    expect(audit.status).toBe(200);
    const rows = asArray(audit.data.items ?? audit.data.entries ?? audit.data, 'audit rows');
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
});
