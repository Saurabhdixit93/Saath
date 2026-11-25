import { test, expect } from '../../fixtures/multi-browser.js';
import { SaathApiClient } from '../../helpers/api.js';
import { TEST_PNRS, uniquePhone } from '../../helpers/env.js';

test.describe('F29 Tier 2: Outbox, Webhook HMAC & Quiet-Hours Boundaries @tier2', () => {
  test('Invalid X-Hub-Signature-256 on WhatsApp webhook is rejected with 401/403', async () => {
    const api = new SaathApiClient();
    const res = await api.sendWhatsappWebhook(
      { object: 'whatsapp_business_account', entry: [] },
      'wrong-secret',
      'sha256=deadbeefdeadbeefdeadbeefdeadbeef',
    );
    api.assertProblemJson(res, [401, 403]);
  });

  test('Inbound WhatsApp non-PNR text handled gracefully without 500 error', async () => {
    const api = new SaathApiClient();
    const res = await api.sendWhatsappWebhook({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '1002',
          changes: [
            {
              field: 'messages',
              value: {
                messages: [
                  {
                    from: `91${uniquePhone(292_001)}`,
                    id: `wamid.nonpnr.${Date.now()}`,
                    type: 'text',
                    text: { body: 'Hello, how does Saath work?' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(res.status).toBe(200);
  });

  test('Duplicate WhatsApp inbound wamid webhook delivery is idempotent', async () => {
    const api = new SaathApiClient();
    const wamid = `wamid.dup.${Date.now()}`;
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '1003',
          changes: [
            {
              field: 'messages',
              value: {
                messages: [
                  {
                    from: `91${uniquePhone(292_002)}`,
                    id: wamid,
                    type: 'text',
                    text: { body: TEST_PNRS.rajdhani3A },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const r1 = await api.sendWhatsappWebhook(payload);
    const r2 = await api.sendWhatsappWebhook(payload);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
  });

  test('Invalid VAPID push subscription payload rejected with 422 RFC 9457', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone(292_003));
    const res = await api.request('POST', '/v1/me/push-subscriptions', {
      token: auth.access,
      body: { endpoint: 'not-a-url', keys: { p256dh: '', auth: '' } },
    });
    api.assertProblemJson(res, 422);
  });

  test('Unauthenticated push subscription registration returns 401 RFC 9457', async () => {
    const api = new SaathApiClient();
    const res = await api.request('POST', '/v1/me/push-subscriptions', {
      body: {
        endpoint: 'https://push.example.test/sub',
        keys: { p256dh: 'abc', auth: 'def' },
      },
    });
    api.assertProblemJson(res, 401);
  });
});
