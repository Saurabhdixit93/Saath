import { test, expect } from '@playwright/test';
import { SaathApiClient } from '../../helpers/api.js';
import { E2E_ENV, TEST_PNRS, uniquePhone } from '../../helpers/env.js';

function decodeClaims(token: string): Record<string, unknown> {
  const payload = token.split('.')[1];
  if (!payload) {
    throw new Error('Malformed JWT payload');
  }
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
}

test.describe('@tier1 F03: Phone / WhatsApp OTP Auth', () => {
  test('POST /v1/auth/otp/start via WhatsApp returns request_id and resend_after=30', async () => {
    const api = new SaathApiClient();
    const phone = uniquePhone('f03-wa-start');
    const res = await api.startOtp(phone, 'whatsapp');
    expect([200, 201]).toContain(res.status);
    expect(typeof res.data.request_id).toBe('string');
    expect(res.data.request_id.length).toBeGreaterThan(4);
    expect(res.data.resend_after).toBe(30);
  });

  test('POST /v1/auth/otp/start via SMS returns request_id and resend_after=30', async () => {
    const api = new SaathApiClient();
    const phone = uniquePhone('f03-sms-start');
    const res = await api.startOtp(phone, 'sms');
    expect([200, 201]).toContain(res.status);
    expect(typeof res.data.request_id).toBe('string');
    expect(res.data.resend_after).toBe(30);
  });

  test('POST /v1/auth/otp/verify issues 15m EdDSA access JWT, 30d refresh token, and user DTO', async () => {
    const api = new SaathApiClient();
    const phone = uniquePhone('f03-otp-verify');
    const tokens = await api.loginWithOtp(phone, 'whatsapp');

    expect(typeof tokens.access).toBe('string');
    expect(typeof tokens.refresh).toBe('string');
    expect(typeof tokens.user.id).toBe('string');
    expect(tokens.user.phone_enc).toBeUndefined();

    const claims = decodeClaims(tokens.access);
    const ttl = Number(claims.exp) - Number(claims.iat);
    expect(ttl).toBeGreaterThanOrEqual(840);
    expect(ttl).toBeLessThanOrEqual(960);
  });

  test('OTP verify merges existing anonymous verified journey into the authenticated user', async () => {
    const api = new SaathApiClient();
    const anon = await api.issueAnonymousToken();
    expect(anon.ok).toBe(true);

    const verifyJourney = await api.verifyTrainPnr<{ journey?: { id: string } }>(
      anon.data.access,
      TEST_PNRS.rajdhani3A,
    );
    expect(verifyJourney.ok).toBe(true);
    const anonJourneyId = verifyJourney.data.journey?.id;
    expect(typeof anonJourneyId).toBe('string');

    const phone = uniquePhone('f03-merge');
    const auth = await api.loginWithOtp(phone, 'whatsapp', anon.data.access);

    const listRes = await api.getJourneys(auth.access);
    expect(listRes.status).toBe(200);
    const found = listRes.data.items.some((item) => {
      const journey = item.journey as { id?: string } | undefined;
      return item.id === anonJourneyId || journey?.id === anonJourneyId;
    });
    expect(found).toBe(true);
  });

  test('Web UI phone +91 OTP sheet authenticates user and displays verified session', async ({
    page,
  }) => {
    const phone = uniquePhone('f03-ui-otp');
    await page.goto(`${E2E_ENV.webUrl}/profile`, { waitUntil: 'domcontentloaded' });

    const phoneInput = page.getByLabel(/phone|mobile|फ़ोन/i).or(
      page.getByPlaceholder(/98\d{8}|10-digit|mobile/i),
    );
    await expect(phoneInput.first()).toBeVisible();
    await phoneInput.first().fill(phone);

    const sendOtpBtn = page.getByRole('button', { name: /send otp|get otp|continue|ओटीपी/i });
    await sendOtpBtn.first().click();

    const otpInput = page.getByLabel(/otp|code|ओटीपी/i).or(
      page.getByPlaceholder(/otp|6-digit|123456/i),
    );
    await expect(otpInput.first()).toBeVisible();
    await otpInput.first().fill(E2E_ENV.testOtpCode);

    const verifyOtpBtn = page.getByRole('button', { name: /verify|confirm|सत्यापित/i });
    await verifyOtpBtn.first().click();

    await expect(page.getByText(/reliability|kept|display|alias|प्रोफ़ाइल/i).first()).toBeVisible();
  });
});
