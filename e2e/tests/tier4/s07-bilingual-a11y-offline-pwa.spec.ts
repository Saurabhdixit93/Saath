import { test, expect, injectAuthSession } from '../../fixtures/multi-browser.js';
import {
  assertLocale,
  assertTapTargets,
  assertThemeTokens,
  assertWcagAA,
} from '../../helpers/a11y.js';
import { SaathApiClient, type MatchCardDto } from '../../helpers/api.js';
import { TEST_PNRS, uniquePhone } from '../../helpers/env.js';

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

test.describe('S07: Mobile 360x800 Bilingual, Themes, WCAG 2.2 AA & Offline PWA @tier4', () => {
  test('Mobile en/hi + light/dark walkthrough passes axe + >=48px tap targets + offline Swap Card & IndexedDB chat queue', async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 360, height: 800 },
      hasTouch: true,
    });
    const page = await context.newPage();

    try {
      const apiA = new SaathApiClient();
      const apiB = new SaathApiClient();
      const authA = await apiA.loginWithOtp(uniquePhone(407_001));
      const authB = await apiB.loginWithOtp(uniquePhone(407_002));

      const vA = await apiA.verifyTrainPnr(authA.access, TEST_PNRS.cycleA);
      const vB = await apiB.verifyTrainPnr(authB.access, TEST_PNRS.cycleB);
      const jAId = getString(asRecord(vA.data.journey, 'jA'), 'id');
      const jBId = getString(asRecord(vB.data.journey, 'jB'), 'id');
      const hubA = await apiA.getJourney(authA.access, jAId);
      const hubB = await apiB.getJourney(authB.access, jBId);
      const pAId = getString(asRecord(hubA.data.party, 'pA'), 'id');
      const pBId = getString(asRecord(hubB.data.party, 'pB'), 'id');

      await apiA.setGoal(authA.access, pAId, {
        goal_type: 'lower',
        movers: [getString(asRecord(asArray(hubA.data.seat_holders, 'hA')[0], 'hA0'), 'id')],
        preferred_seats: [],
        constraints: { women_only: false, no_middle: false, same_coach_only: false, verified_only: false },
      });
      await apiB.setGoal(authB.access, pBId, {
        goal_type: 'open_to_help',
        movers: [getString(asRecord(asArray(hubB.data.seat_holders, 'hB')[0], 'hB0'), 'id')],
        preferred_seats: [],
        constraints: { women_only: false, no_middle: false, same_coach_only: false, verified_only: false },
        standing_offer: { give_to: 'anyone' },
      });

      let card: MatchCardDto | undefined;
      await expect(async () => {
        const matches = await apiA.getMatches(authA.access, pAId, 'pair');
        expect(matches.status).toBe(200);
        expect(matches.data.items.length).toBeGreaterThanOrEqual(1);
        card = matches.data.items[0];
      }).toPass({ timeout: 12_000, intervals: [500, 1000, 1500] });
      if (!card) {
        throw new Error('Expected match card for s07');
      }
      const convo = await apiA.createConversation(authA.access, card.card_id);
      const convoId = getString(convo.data, 'id');

      const swapRes = await apiA.createSwap(authA.access, card.card_id);
      const swapId = getString(swapRes.data, 'id');
      const a1 = await apiA.acceptSwap(authA.access, swapId, Number(swapRes.data.version ?? 0));
      await apiB.acceptSwap(authB.access, swapId, Number(a1.data.version ?? 1));
      const cardJson = await apiA.getSwapCard(authA.access, swapId, 'json');
      const publicCode = getString(cardJson.data, 'public_code');

      // Mobile Home: light theme, en, axe, >=48px tap targets
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await assertThemeTokens(page, 'light');
      await assertLocale(page, 'en');
      await assertWcagAA(page);
      await assertTapTargets(page);

      // Switch to dark theme + Hindi
      await page.getByRole('button', { name: /theme|dark|light|☾|☀/i }).click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await assertThemeTokens(page, 'dark');
      await page.getByRole('button', { name: /हिं|EN|Language/i }).click();
      await expect(page.locator('html')).toHaveAttribute('lang', /^hi/i);
      await assertLocale(page, 'hi', { latinDigitTexts: ['12951'] });
      await assertWcagAA(page);
      await assertTapTargets(page);

      // Visit Swap Card & Chat online first so PWA caches card
      await injectAuthSession(page, authA);
      await page.goto(`/swaps/${swapId}/card`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByText(new RegExp(publicCode))).toBeVisible();
      await assertWcagAA(page);
      await assertTapTargets(page);

      await page.goto(`/inbox/${convoId}`, { waitUntil: 'domcontentloaded' });
      await assertTapTargets(page);

      // Go offline -> send queued message in IndexedDB + verify cached Swap Card
      await context.setOffline(true);

      const chatInput = page.getByRole('textbox').first();
      await chatInput.fill('Offline queued message from platform');
      await page.getByRole('button', { name: /Send|भेजें/i }).first().click();

      await expect(
        page.getByText(/Queued|Pending|Offline queued message from platform/i).first(),
      ).toBeVisible();

      // Still offline: navigate to cached Swap Card and verify it renders offline
      await page.goto(`/swaps/${swapId}/card`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByText(new RegExp(publicCode))).toBeVisible();
      await expect(page.getByText(/#?SW-/).first()).toBeVisible();

      // Reconnect -> queued message flushes to API
      await context.setOffline(false);
      await page.goto(`/inbox/${convoId}`, { waitUntil: 'domcontentloaded' });
      await expect
        .poll(
          async () => {
            const history = await apiA.getMessages(authA.access, convoId);
            return JSON.stringify(history.data.items);
          },
          { timeout: 15_000 },
        )
        .toContain('Offline queued message from platform');
    } finally {
      await context.close();
    }
  });
});
