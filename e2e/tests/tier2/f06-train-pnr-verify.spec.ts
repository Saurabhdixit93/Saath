import { test, expect } from '@playwright/test';
import { SaathApiClient } from '../../helpers/api.js';
import { TEST_PNRS, uniquePhone } from '../../helpers/env.js';

const RATE_LIMIT_TEST_IP = '198.51.100.60';

async function burstVerifyUntil429(
  api: SaathApiClient,
  token: string,
  pnr: string,
  maxCalls: number,
) {
  const statuses: number[] = [];
  let lastRes = await api.request('POST', '/v1/journeys/verify', {
    token,
    body: { mode: 'train', pnr },
    headers: { 'X-Forwarded-For': RATE_LIMIT_TEST_IP },
  });
  statuses.push(lastRes.status);
  for (let i = 0; i < maxCalls; i += 1) {
    lastRes = await api.request('POST', '/v1/journeys/verify', {
      token,
      body: { mode: 'train', pnr: TEST_PNRS.sleeperSL },
      headers: { 'X-Forwarded-For': RATE_LIMIT_TEST_IP },
    });
    statuses.push(lastRes.status);
    if (lastRes.status === 429) {
      break;
    }
  }
  return { statuses, lastRes };
}

test.describe('@tier2 F06: Train PNR Boundary & Rate-Limit Cases', () => {
  test('Non-10-digit or non-numeric PNRs rejected with 422 problem+json', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone('f06-t2-fmt'), 'whatsapp');

    for (const badPnr of ['12345', '12345678901', '24156ABC01', '']) {
      const res = await api.verifyTrainPnr(auth.access, badPnr);
      const problem = api.assertProblemJson(res, 422);
      expect(problem.status).toBe(422);
    }
  });

  test('Flushed and cancelled PNRs return 404/422 with user-friendly problem detail', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone('f06-t2-flushed'), 'whatsapp');

    const flushed = await api.verifyTrainPnr(auth.access, TEST_PNRS.flushed);
    const pFlushed = api.assertProblemJson(flushed, [404, 422]);
    expect(pFlushed.detail.length).toBeGreaterThan(10);

    const cancelled = await api.verifyTrainPnr(auth.access, TEST_PNRS.cancelled);
    const pCancelled = api.assertProblemJson(cancelled, [404, 422]);
    expect(pCancelled.detail.length).toBeGreaterThan(10);
  });

  test('Unknown/invalid 10-digit PNR returns 404/422 problem+json', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone('f06-t2-invalid'), 'whatsapp');

    const res = await api.verifyTrainPnr(auth.access, TEST_PNRS.invalid);
    const problem = api.assertProblemJson(res, [404, 422]);
    expect([404, 422]).toContain(problem.status);
  });

  test('Re-verifying same PNR by same user does not duplicate active journeys', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone('f06-t2-idem'), 'whatsapp');

    const r1 = await api.verifyTrainPnr(auth.access, TEST_PNRS.rajdhani3A);
    const r2 = await api.verifyTrainPnr(auth.access, TEST_PNRS.rajdhani3A);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);

    const list = await api.getJourneys(auth.access);
    expect(list.status).toBe(200);
    expect(list.data.items).toHaveLength(1);
  });

  test('Bursting >10 verify calls per minute from same IP triggers 429 rate limit', async () => {
    test.setTimeout(90_000);
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone('f06-t2-rl'), 'whatsapp');

    const { statuses, lastRes } = await burstVerifyUntil429(
      api,
      auth.access,
      TEST_PNRS.rajdhani3A,
      12,
    );

    expect(statuses).toContain(429);
    const problem = api.assertProblemJson(lastRes, 429);
    expect(problem.status).toBe(429);

    // Probe loopback once without X-Forwarded-For; if server ignored XFF and throttled 127.0.0.1,
    // wait out the Retry-After cooldown (<= 65s) so subsequent Tier 2 specs are never poisoned.
    const loopbackProbe = await api.verifyTrainPnr(auth.access, TEST_PNRS.rajdhani3A);
    if (loopbackProbe.status === 429) {
      const retryAfterRaw = Number.parseInt(
        loopbackProbe.headers.get('retry-after') ?? '60',
        10,
      );
      const cooldownMs =
        Math.min(Number.isFinite(retryAfterRaw) && retryAfterRaw > 0 ? retryAfterRaw + 5 : 65, 65) *
        1000;
      await expect(async () => {
        const retryProbe = await api.verifyTrainPnr(auth.access, TEST_PNRS.rajdhani3A);
        expect(retryProbe.status).not.toBe(429);
      }).toPass({ timeout: cooldownMs, intervals: [2000, 5000] });
    }
  });
});
