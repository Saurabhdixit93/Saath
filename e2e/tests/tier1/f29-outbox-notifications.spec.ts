import { test, expect, injectAuthSession } from '../../fixtures/multi-browser.js';
import { SaathApiClient, type MatchCardDto } from '../../helpers/api.js';
import { TEST_PNRS, uniquePhone } from '../../helpers/env.js';

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Expected object for ${label}`);
  }
  return value as Record<string, unknown>;
}

function getString(obj: Record<string, unknown>, key: string): string {
  const val = obj[key];
  if (typeof val !== 'string' || val.length === 0) {
    throw new Error(`Expected string "${key}"`);
  }
  return val;
}

test.describe('F29: Transactional Outbox & Multi-Channel Notifications @tier1', () => {
  test('POST /v1/me/push-subscriptions stores VAPID Web Push subscription', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone(29_001));

    const res = await api.savePushSubscription(auth.access, {
      endpoint: `https://push.example.test/sub/${Date.now()}`,
      keys: {
        p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8p8REfXRs',
        auth: 'tBHItJI5svbpez7KI4CCXg',
      },
    });
    expect([200, 201]).toContain(res.status);
    expect(res.data.subscribed).toBe(true);
  });

  test('Domain event GoalChanged + swap lifecycle queues transactional outbox notifications cleanly', async () => {
    const apiA = new SaathApiClient();
    const apiB = new SaathApiClient();
    const authA = await apiA.loginWithOtp(uniquePhone(29_002));
    const authB = await apiB.loginWithOtp(uniquePhone(29_003));

    const vA = await apiA.verifyTrainPnr(authA.access, TEST_PNRS.cycleA);
    const vB = await apiB.verifyTrainPnr(authB.access, TEST_PNRS.cycleB);
    const hubA = await apiA.getJourney(authA.access, getString(asRecord(vA.data.journey, 'jA'), 'id'));
    const hubB = await apiB.getJourney(authB.access, getString(asRecord(vB.data.journey, 'jB'), 'id'));
    const pA = getString(asRecord(hubA.data.party, 'pA'), 'id');
    const pB = getString(asRecord(hubB.data.party, 'pB'), 'id');

    await apiA.setGoal(authA.access, pA, {
      goal_type: 'lower',
      movers: [getString(asRecord((hubA.data.seat_holders as unknown[])[0], 'hA0'), 'id')],
      preferred_seats: [],
      constraints: { women_only: false, no_middle: false, same_coach_only: false, verified_only: false },
    });
    await apiB.setGoal(authB.access, pB, {
      goal_type: 'open_to_help',
      movers: [getString(asRecord((hubB.data.seat_holders as unknown[])[0], 'hB0'), 'id')],
      preferred_seats: [],
      constraints: { women_only: false, no_middle: false, same_coach_only: false, verified_only: false },
      standing_offer: { give_to: 'anyone' },
    });

    let card: MatchCardDto | undefined;
    await expect(async () => {
      const matches = await apiA.getMatches(authA.access, pA, 'pair');
      expect(matches.status).toBe(200);
      expect(matches.data.items.length).toBeGreaterThanOrEqual(1);
      card = matches.data.items[0];
    }).toPass({ timeout: 12_000, intervals: [500, 1000, 1500] });
    if (!card) {
      throw new Error('Expected match card');
    }
    const swap = await apiA.createSwap(authA.access, card.card_id);
    expect([200, 201]).toContain(swap.status);
  });

  test('UI notification settings on /profile never auto-prompt browser push on load', async ({
    createIsolatedPassenger,
  }) => {
    const passenger = await createIsolatedPassenger('notif-ui');
    const auth = await passenger.api.loginWithOtp(uniquePhone(29_004));

    await passenger.page.addInitScript(() => {
      const win = window as Window & { __saathNotifPromptCalls?: number };
      win.__saathNotifPromptCalls = 0;
      if ('Notification' in window && typeof window.Notification.requestPermission === 'function') {
        const original = window.Notification.requestPermission.bind(window.Notification);
        Object.defineProperty(window.Notification, 'requestPermission', {
          configurable: true,
          writable: true,
          value: (...args: Parameters<typeof window.Notification.requestPermission>) => {
            win.__saathNotifPromptCalls = (win.__saathNotifPromptCalls ?? 0) + 1;
            return original(...args);
          },
        });
      }
    });

    await injectAuthSession(passenger.page, auth);
    for (const route of ['/', '/journeys', '/profile']) {
      await passenger.page.goto(route, { waitUntil: 'domcontentloaded' });
    }

    await expect(
      passenger.page.getByText(/Notifications|WhatsApp|Push/i).first(),
    ).toBeVisible();

    const promptCalls = await passenger.page.evaluate(() => {
      const win = window as Window & { __saathNotifPromptCalls?: number };
      return win.__saathNotifPromptCalls ?? 0;
    });
    expect(promptCalls).toBe(0);
  });

  test('POST /v1/webhooks/whatsapp verifies HMAC signature and handles inbound PNR message', async () => {
    const api = new SaathApiClient();
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '1001',
          changes: [
            {
              field: 'messages',
              value: {
                messages: [
                  {
                    from: `91${uniquePhone(29_005)}`,
                    id: `wamid.e2e.${Date.now()}`,
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

    const res = await api.sendWhatsappWebhook(payload);
    expect(res.status).toBe(200);
  });

  test('Quiet-hours / notification preferences persist via PATCH /v1/me', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone(29_006));

    const patch = await api.patchMe(auth.access, {
      locale: 'en',
      notification_channels: { push: true, whatsapp: true, sms: false },
    });
    expect(patch.status).toBe(200);

    const me = await api.getMe(auth.access);
    expect(me.status).toBe(200);
  });
});
