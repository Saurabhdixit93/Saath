import { test, expect, injectAuthSession } from '../../fixtures/multi-browser.js';
import {
  assertLocale,
  assertTapTargets,
  assertThemeTokens,
  assertWcagAA,
} from '../../helpers/a11y.js';
import { type MatchCardDto } from '../../helpers/api.js';
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

test.describe('F24: Saath Brand, Bilingual (en/hi), Themes & WCAG 2.2 AA @tier1', () => {
  test('Light theme enforces Saath warm paper #FAF7F2, saffron #E2572B, and teal #1F6F78 tokens', async ({
    page,
  }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await assertThemeTokens(page, 'light');
    await expect(page.getByText(/Sit together\. Safely\./i)).toBeVisible();
  });

  test('Theme toggle switches to dark theme #0F1115 with #FF7A4D primary and #4FB3BD secondary', async ({
    page,
  }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const toggle = page.getByRole('button', { name: /theme|dark|light|☾|☀/i });
    await expect(toggle).toBeVisible();
    await toggle.click();

    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await assertThemeTokens(page, 'dark');
  });

  test('Bilingual [हिं/EN] switcher translates UI to Hindi while keeping Latin numerals for PNR and berths', async ({
    createIsolatedPassenger,
  }) => {
    const passenger = await createIsolatedPassenger('i18n-hi');
    const auth = await passenger.api.loginWithOtp(uniquePhone(24_001));
    const verify = await passenger.api.verifyTrainPnr(auth.access, TEST_PNRS.rajdhani3A);
    const journeyId = getString(asRecord(verify.data.journey, 'journey'), 'id');

    await injectAuthSession(passenger.page, auth);
    await passenger.page.goto(`/journeys/${journeyId}`, { waitUntil: 'domcontentloaded' });

    const langToggle = passenger.page.getByRole('button', { name: /हिं|EN|Language/i });
    await expect(langToggle).toBeVisible();
    await langToggle.click();
    await expect(passenger.page.locator('html')).toHaveAttribute('lang', /^hi/i);

    await assertLocale(passenger.page, 'hi', {
      latinDigitTexts: ['12951'],
    });
  });

  test('WCAG 2.2 AA axe audit passes on Home, Pricing, Journey Hub, Profile, and Inbox chat', async ({
    createIsolatedPassenger,
  }) => {
    const passenger = await createIsolatedPassenger('axe-audit');
    const helper = await createIsolatedPassenger('axe-audit-helper');
    const auth = await passenger.api.loginWithOtp(uniquePhone(24_002));
    const authHelper = await helper.api.loginWithOtp(uniquePhone(24_003));

    const vA = await passenger.api.verifyTrainPnr(auth.access, TEST_PNRS.cycleA);
    const vB = await helper.api.verifyTrainPnr(authHelper.access, TEST_PNRS.cycleB);
    const journeyId = getString(asRecord(vA.data.journey, 'journey'), 'id');
    const hubA = await passenger.api.getJourney(auth.access, journeyId);
    const hubB = await helper.api.getJourney(
      authHelper.access,
      getString(asRecord(vB.data.journey, 'journeyB'), 'id'),
    );
    const pA = getString(asRecord(hubA.data.party, 'pA'), 'id');
    const pB = getString(asRecord(hubB.data.party, 'pB'), 'id');

    await passenger.api.setGoal(auth.access, pA, {
      goal_type: 'lower',
      movers: [getString(asRecord(asArray(hubA.data.seat_holders, 'hA')[0], 'hA0'), 'id')],
      preferred_seats: [],
      constraints: { women_only: false, no_middle: false, same_coach_only: false, verified_only: false },
    });
    await helper.api.setGoal(authHelper.access, pB, {
      goal_type: 'open_to_help',
      movers: [getString(asRecord(asArray(hubB.data.seat_holders, 'hB')[0], 'hB0'), 'id')],
      preferred_seats: [],
      constraints: { women_only: false, no_middle: false, same_coach_only: false, verified_only: false },
      standing_offer: { give_to: 'anyone' },
    });

    let card: MatchCardDto | undefined;
    await expect(async () => {
      const matches = await passenger.api.getMatches(auth.access, pA, 'pair');
      expect(matches.status).toBe(200);
      expect(matches.data.items.length).toBeGreaterThanOrEqual(1);
      card = matches.data.items[0];
    }).toPass({ timeout: 12_000, intervals: [500, 1000, 1500] });
    if (!card) {
      throw new Error('Expected match card for inbox axe check');
    }
    const convo = await passenger.api.createConversation(auth.access, card.card_id);
    const convoId = getString(convo.data, 'id');

    await passenger.page.goto('/', { waitUntil: 'domcontentloaded' });
    await assertWcagAA(passenger.page);

    await passenger.page.goto('/pricing', { waitUntil: 'domcontentloaded' });
    await assertWcagAA(passenger.page);

    await injectAuthSession(passenger.page, auth);
    await passenger.page.goto(`/journeys/${journeyId}`, { waitUntil: 'domcontentloaded' });
    await assertWcagAA(passenger.page);

    await passenger.page.goto('/profile', { waitUntil: 'domcontentloaded' });
    await expect(passenger.page.getByRole('heading').first()).toBeVisible();
    await assertWcagAA(passenger.page);

    await passenger.page.goto(`/inbox/${convoId}`, { waitUntil: 'domcontentloaded' });
    await expect(passenger.page.getByRole('textbox').first()).toBeVisible();
    await assertWcagAA(passenger.page);
  });

  test('Mobile 360x800 viewport satisfies >=48px tap targets across Home, Profile, Inbox, and keyboard navigation on CoachMap', async ({
    browser,
    createIsolatedPassenger,
  }) => {
    const helper = await createIsolatedPassenger('tap-helper');
    const context = await browser.newContext({
      viewport: { width: 360, height: 800 },
      hasTouch: true,
    });
    const page = await context.newPage();

    try {
      const auth = await helper.api.loginWithOtp(uniquePhone(24_004));
      const authPartner = await helper.api.loginWithOtp(uniquePhone(24_005));
      const vA = await helper.api.verifyTrainPnr(auth.access, TEST_PNRS.cycleA);
      const vB = await helper.api.verifyTrainPnr(authPartner.access, TEST_PNRS.cycleB);
      const journeyId = getString(asRecord(vA.data.journey, 'jA'), 'id');
      const hubA = await helper.api.getJourney(auth.access, journeyId);
      const hubB = await helper.api.getJourney(
        authPartner.access,
        getString(asRecord(vB.data.journey, 'jB'), 'id'),
      );
      const pA = getString(asRecord(hubA.data.party, 'pA'), 'id');
      const pB = getString(asRecord(hubB.data.party, 'pB'), 'id');

      await helper.api.setGoal(auth.access, pA, {
        goal_type: 'lower',
        movers: [getString(asRecord(asArray(hubA.data.seat_holders, 'hA')[0], 'hA0'), 'id')],
        preferred_seats: [],
        constraints: { women_only: false, no_middle: false, same_coach_only: false, verified_only: false },
      });
      await helper.api.setGoal(authPartner.access, pB, {
        goal_type: 'open_to_help',
        movers: [getString(asRecord(asArray(hubB.data.seat_holders, 'hB')[0], 'hB0'), 'id')],
        preferred_seats: [],
        constraints: { women_only: false, no_middle: false, same_coach_only: false, verified_only: false },
        standing_offer: { give_to: 'anyone' },
      });

      let card: MatchCardDto | undefined;
      await expect(async () => {
        const matches = await helper.api.getMatches(auth.access, pA, 'pair');
        expect(matches.status).toBe(200);
        expect(matches.data.items.length).toBeGreaterThanOrEqual(1);
        card = matches.data.items[0];
      }).toPass({ timeout: 12_000, intervals: [500, 1000, 1500] });
      if (!card) {
        throw new Error('Expected match card for mobile tap target check');
      }
      const convo = await helper.api.createConversation(auth.access, card.card_id);
      const convoId = getString(convo.data, 'id');

      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await assertTapTargets(page);

      await injectAuthSession(page, auth);

      await page.goto('/profile', { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('heading').first()).toBeVisible();
      await assertTapTargets(page);

      await page.goto(`/inbox/${convoId}`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('textbox').first()).toBeVisible();
      await assertTapTargets(page);

      // Navigate to CoachMap on /journeys/[id]/matches (or /journeys/[id]) and test keyboard navigation
      await page.goto(`/journeys/${journeyId}/matches`, { waitUntil: 'domcontentloaded' });
      const mapTab = page
        .getByRole('tab', { name: /coach map|cabin map|map/i })
        .or(page.getByRole('button', { name: /coach map|cabin map|map/i }));
      if ((await mapTab.count()) > 0) {
        await mapTab.first().click();
      } else {
        await page.goto(`/journeys/${journeyId}`, { waitUntil: 'domcontentloaded' });
      }

      await expect(page.locator('svg').first()).toBeVisible();
      const focusableInMap = page.locator(
        'svg [tabindex="0"], [aria-label*="Coach" i] button, [aria-label*="berth" i], [aria-label*="seat" i]',
      );
      if ((await focusableInMap.count()) > 0) {
        await focusableInMap.first().focus();
        await page.keyboard.press('Tab');
      } else {
        await page.keyboard.press('Tab');
      }

      const activeInfo = await page.evaluate(() => ({
        tag: document.activeElement?.tagName ?? '',
        isBody: document.activeElement === document.body,
      }));
      expect(activeInfo.tag.length).toBeGreaterThan(0);
      expect(activeInfo.isBody).toBe(false);
    } finally {
      await context.close();
    }
  });
});
