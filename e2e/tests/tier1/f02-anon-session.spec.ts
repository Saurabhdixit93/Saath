import { test, expect } from '@playwright/test';
import { SaathApiClient } from '../../helpers/api.js';
import { TEST_PNRS } from '../../helpers/env.js';

function decodeJwtPart(token: string, index: 0 | 1): Record<string, unknown> {
  const parts = token.split('.');
  const segment = parts[index];
  if (!segment) {
    throw new Error(`Invalid JWT structure at segment ${index}`);
  }
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, unknown>;
}

test.describe('@tier1 F02: Anonymous Session Token', () => {
  test('POST /v1/auth/anonymous issues an access JWT with valid Turnstile token', async () => {
    const api = new SaathApiClient();
    const res = await api.issueAnonymousToken();
    expect([200, 201]).toContain(res.status);
    expect(typeof res.data.access).toBe('string');
    expect(res.data.access.split('.')).toHaveLength(3);
  });

  test('Anonymous JWT uses EdDSA algorithm, anon: subject prefix, and ~2h TTL', async () => {
    const api = new SaathApiClient();
    const res = await api.issueAnonymousToken();
    expect(res.ok).toBe(true);

    const header = decodeJwtPart(res.data.access, 0);
    const claims = decodeJwtPart(res.data.access, 1);

    expect(header.alg).toBe('EdDSA');
    expect(String(claims.sub)).toMatch(/^anon:[0-9a-f-]+$/i);
    expect(typeof claims.iat).toBe('number');
    expect(typeof claims.exp).toBe('number');

    const ttlSeconds = Number(claims.exp) - Number(claims.iat);
    expect(ttlSeconds).toBeGreaterThanOrEqual(7100);
    expect(ttlSeconds).toBeLessThanOrEqual(7300);
  });

  test('Anonymous session can verify a train PNR', async () => {
    const api = new SaathApiClient();
    const anon = await api.issueAnonymousToken();
    expect(anon.ok).toBe(true);

    const verifyRes = await api.verifyTrainPnr(anon.data.access, TEST_PNRS.rajdhani3A);
    expect([200, 201]).toContain(verifyRes.status);
    expect(verifyRes.data.journey).toBeTruthy();
    expect(verifyRes.data.trust_tier).toBe('verified_provider');
  });

  test('Anonymous session can read own journeys and browse matches', async () => {
    const api = new SaathApiClient();
    const anon = await api.issueAnonymousToken();
    expect(anon.ok).toBe(true);

    const verifyRes = await api.verifyTrainPnr<{
      party?: { id: string };
    }>(anon.data.access, TEST_PNRS.rajdhani3A);
    expect(verifyRes.ok).toBe(true);

    const listRes = await api.getJourneys(anon.data.access);
    expect(listRes.status).toBe(200);
    expect(listRes.data.items.length).toBeGreaterThanOrEqual(1);

    const partyId = verifyRes.data.party?.id;
    expect(typeof partyId).toBe('string');
    const matchesRes = await api.getMatches(anon.data.access, String(partyId));
    expect(matchesRes.status).toBe(200);
    expect(Array.isArray(matchesRes.data.items)).toBe(true);
  });

  test('Anonymous session is blocked from swaps, chat, and karma until OTP verification', async () => {
    const api = new SaathApiClient();
    const anon = await api.issueAnonymousToken();
    expect(anon.ok).toBe(true);

    const swapRes = await api.createSwap(anon.data.access, 'mc_00000000000000000000000000');
    api.assertProblemJson(swapRes, [401, 403]);
    expect([401, 403]).toContain(swapRes.status);

    const chatRes = await api.createConversation(anon.data.access, 'mc_00000000000000000000000000');
    api.assertProblemJson(chatRes, [401, 403]);
    expect([401, 403]).toContain(chatRes.status);

    const karmaRes = await api.getKarma(anon.data.access);
    api.assertProblemJson(karmaRes, [401, 403]);
    expect([401, 403]).toContain(karmaRes.status);
  });
});
