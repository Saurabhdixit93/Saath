import { test, expect, injectAuthSession } from '../../fixtures/multi-browser.js';
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

function extractInviteToken(inviteRes: Record<string, unknown>): string {
  if (typeof inviteRes.token === 'string' && inviteRes.token.length > 0) {
    return inviteRes.token;
  }
  const url = getString(inviteRes, 'invite_url');
  const token = url.split('/j/')[1]?.split(/[?#]/)[0];
  if (!token) {
    throw new Error(`Missing token in ${url}`);
  }
  return token;
}

test.describe('S06: Growth /j/[token] Invite, ISR SEO Pages & Signed WhatsApp Webhook @tier4', () => {
  test('Cold-start coach -> /j/[token] visitor converts to open_to_help -> live match + ISR SEO + signed WhatsApp webhook', async ({
    createIsolatedPassenger,
  }) => {
    const inviter = await createIsolatedPassenger('inviter');
    const visitor = await createIsolatedPassenger('visitor');

    const authInv = await inviter.api.loginWithOtp(uniquePhone(406_001));
    const vInv = await inviter.api.verifyTrainPnr(authInv.access, TEST_PNRS.cycleA);
    const jInvId = getString(asRecord(vInv.data.journey, 'jInv'), 'id');
    const hubInv = await inviter.api.getJourney(authInv.access, jInvId);
    const pInvId = getString(asRecord(hubInv.data.party, 'pInv'), 'id');
    const hInvId = getString(asRecord(asArray(hubInv.data.seat_holders, 'hInv')[0], 'h0'), 'id');

    await inviter.api.setGoal(authInv.access, pInvId, {
      goal_type: 'lower',
      movers: [hInvId],
      preferred_seats: [],
      constraints: { women_only: false, no_middle: false, same_coach_only: false, verified_only: false },
    });

    const seatInvite = await inviter.api.createSeatInvite(authInv.access, jInvId, {
      coach: 'B5',
      seat_no: '11',
    });
    const inviteToken = extractInviteToken(seatInvite.data);

    // Visitor opens /j/[token] in separate browser
    await visitor.page.goto(`/j/${inviteToken}`, { waitUntil: 'domcontentloaded' });
    await expect(visitor.page.getByText(/B5|open to help|verify/i).first()).toBeVisible();

    const authVis = await visitor.api.loginWithOtp(uniquePhone(406_002));
    const vVis = await visitor.api.verifyJourney(authVis.access, {
      mode: 'train',
      pnr: TEST_PNRS.cycleB,
      invite_token: inviteToken,
      open_to_help: true,
    });
    expect(vVis.status).toBe(200);

    // Inviter now sees match on Matches page
    await expect(async () => {
      const matches = await inviter.api.getMatches(authInv.access, pInvId);
      expect(matches.status).toBe(200);
      expect(matches.data.items.length).toBeGreaterThanOrEqual(1);
      assertNoPiiLeak(matches.data, 's06-invite-match');
    }).toPass({ timeout: 12_000, intervals: [500, 1000, 1500] });

    await injectAuthSession(inviter.page, authInv);
    await inviter.page.goto(`/journeys/${jInvId}/matches`, { waitUntil: 'domcontentloaded' });
    await expect(inviter.page.getByText(/Perfect swap|Great match|Workable|Passenger/i).first()).toBeVisible();

    // ISR SEO Utility Pages & Sitemap
    await visitor.page.goto('/pnr-status', { waitUntil: 'domcontentloaded' });
    await expect(visitor.page.locator('script[type="application/ld+json"]').first()).toBeAttached();

    await visitor.page.goto('/train/12951/live', { waitUntil: 'domcontentloaded' });
    await expect(visitor.page.getByText(/12951/).first()).toBeVisible();

    await visitor.page.goto('/flights/6E/A320neo/seat-map', { waitUntil: 'domcontentloaded' });
    await expect(visitor.page.locator('svg').first()).toBeVisible();

    const sitemapRes = await fetch(`${E2E_ENV.webUrl}/sitemap.xml`);
    expect(sitemapRes.status).toBe(200);

    // Signed WhatsApp Cloud API inbound webhook verifies PNR
    const waRes = await inviter.api.sendWhatsappWebhook({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '1009',
          changes: [
            {
              field: 'messages',
              value: {
                messages: [
                  {
                    from: `91${uniquePhone(406_003)}`,
                    id: `wamid.s06.${Date.now()}`,
                    type: 'text',
                    text: { body: TEST_PNRS.rajdhani3A },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(waRes.status).toBe(200);
  });
});
