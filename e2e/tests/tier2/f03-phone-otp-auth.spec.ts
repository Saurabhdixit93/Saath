import { test, expect } from '@playwright/test';
import { SaathApiClient } from '../../helpers/api.js';
import { uniquePhone } from '../../helpers/env.js';

test.describe('@tier2 F03: Phone / WhatsApp OTP Negative & Boundary Cases', () => {
  test('Invalid Indian phone numbers rejected with 422 problem+json', async () => {
    const api = new SaathApiClient();
    const badPhones = ['5123456789', '0987654321', '98765', '98765432101', 'abcdefghij'];

    for (const phone of badPhones) {
      const res = await api.startOtp(phone, 'whatsapp');
      const problem = api.assertProblemJson(res, 422);
      expect(problem.status).toBe(422);
    }
  });

  test('Invalid Turnstile token on otp/start rejected with 400/403', async () => {
    const api = new SaathApiClient();
    const res = await api.startOtp(uniquePhone('f03-t2-turnstile'), 'whatsapp', 'bad-turnstile');
    const problem = api.assertProblemJson(res, [400, 403]);
    expect([400, 403]).toContain(problem.status);
  });

  test('Resending OTP before 30s cooldown is throttled with 429', async () => {
    const api = new SaathApiClient();
    const phone = uniquePhone('f03-t2-resend');

    const first = await api.startOtp(phone, 'whatsapp');
    expect([200, 201]).toContain(first.status);

    const immediateSecond = await api.startOtp(phone, 'whatsapp');
    const problem = api.assertProblemJson(immediateSecond, 429);
    expect(problem.status).toBe(429);
  });

  test('Wrong OTP locks request after 5 failed verification attempts', async () => {
    const api = new SaathApiClient();
    const phone = uniquePhone('f03-t2-lock');
    const start = await api.startOtp(phone, 'sms');
    expect(start.ok).toBe(true);

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const bad = await api.verifyOtp(start.data.request_id, '000000');
      api.assertProblemJson(bad, [400, 401, 429]);
    }

    const sixthEvenIfRight = await api.verifyOtp(
      start.data.request_id,
      start.data.dev_otp ?? '123456',
    );
    const problem = api.assertProblemJson(sixthEvenIfRight, [400, 401, 423, 429]);
    expect([400, 401, 423, 429]).toContain(problem.status);
  });

  test('Unsupported OTP channel rejected with 422 problem+json', async () => {
    const api = new SaathApiClient();
    const res = await api.request('POST', '/v1/auth/otp/start', {
      body: {
        phone: uniquePhone('f03-t2-chan'),
        channel: 'telegram',
        turnstile: 'fake-turnstile-ok',
      },
    });
    const problem = api.assertProblemJson(res, 422);
    expect(problem.status).toBe(422);
  });
});
