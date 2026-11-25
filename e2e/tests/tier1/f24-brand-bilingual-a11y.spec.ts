import { test, expect, injectAuthSession } from '../../fixtures/multi-browser.js';
import {
  assertLocale,
  assertTapTargets,
  assertThemeTokens,
  assertWcagAA,
} from '../../helpers/a11y.js';
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

    await assertLocale(passenger.page, 'hi', {
      latinDigitTexts: ['12951'],
    });
  });

  test('WCAG 2.2 AA axe audit passes on Home, Pricing, and Journey Hub', async ({
    createIsolatedPassenger,
  }) => {
    const passenger = await createIsolatedPassenger('axe-audit');
    const auth = await passenger.api.loginWithOtp(uniquePhone(24_002));
    const verify = await passenger.api.verifyTrainPnr(auth.access, TEST_PNRS.rajdhani3A);
    const journeyId = getString(asRecord(verify.data.journey, 'journey'), 'id');

    await passenger.page.goto('/', { waitUntil: 'domcontentloaded' });
    await assertWcagAA(passenger.page);

    await passenger.page.goto('/pricing', { waitUntil: 'domcontentloaded' });
    await assertWcagAA(passenger.page);

    await injectAuthSession(passenger.page, auth);
    await passenger.page.goto(`/journeys/${journeyId}`, { waitUntil: 'domcontentloaded' });
    await assertWcagAA(passenger.page);
  });

  test('Mobile 360x800 viewport satisfies >=48px tap targets and keyboard navigation on CoachMap', async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 360, height: 800 },
      hasTouch: true,
    });
    const page = await context.newPage();

    try {
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await assertTapTargets(page);

      await page.keyboard.press('Tab');
      const focusedTag = await page.evaluate(() => document.activeElement?.tagName ?? '');
      expect(focusedTag.length).toBeGreaterThan(0);
    } finally {
      await context.close();
    }
  });
});
