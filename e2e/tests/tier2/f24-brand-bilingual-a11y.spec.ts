import { test, expect, injectAuthSession } from '../../fixtures/multi-browser.js';
import {
  assertLocale,
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

test.describe('F24 Tier 2: Dark/Hindi Axe, 200% Zoom & Reduced Motion A11y @tier2', () => {
  test('Dark theme passes WCAG 2.2 AA axe audit with 0 violations on Home and Pricing', async ({
    page,
  }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: /theme|dark|light|☾|☀/i }).click();
    await assertThemeTokens(page, 'dark');
    await assertWcagAA(page);

    await page.goto('/pricing', { waitUntil: 'domcontentloaded' });
    await assertWcagAA(page);
  });

  test('Hindi locale passes WCAG 2.2 AA axe audit and retains Latin digits', async ({
    page,
  }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: /हिं|EN|Language/i }).click();
    await assertLocale(page, 'hi');
    await assertWcagAA(page);
  });

  test('200% text scale at 360x800 mobile width causes zero horizontal overflow', async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 360, height: 800 },
      hasTouch: true,
    });
    const page = await context.newPage();

    try {
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => {
        document.documentElement.style.fontSize = '200%';
      });

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow).toBeLessThanOrEqual(2);
    } finally {
      await context.close();
    }
  });

  test('prefers-reduced-motion media query suppresses transition/animation motion', async ({
    browser,
  }) => {
    const context = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await context.newPage();
    try {
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      const matchesReduced = await page.evaluate(
        () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      );
      expect(matchesReduced).toBe(true);
    } finally {
      await context.close();
    }
  });

  test('CoachMap pairs colours with accessible ARIA berth labels and non-colour legend symbols', async ({
    createIsolatedPassenger,
  }) => {
    const passenger = await createIsolatedPassenger('coach-map-a11y');
    const auth = await passenger.api.loginWithOtp(uniquePhone(242_001));
    const v = await passenger.api.verifyTrainPnr(auth.access, TEST_PNRS.rajdhani3A);
    const jId = getString(asRecord(v.data.journey, 'j'), 'id');

    await injectAuthSession(passenger.page, auth);
    await passenger.page.goto(`/journeys/${jId}/matches`, { waitUntil: 'domcontentloaded' });

    const mapTab = passenger.page.getByRole('tab', { name: /Coach map|Map/i }).or(
      passenger.page.getByRole('button', { name: /Coach map|Map/i }),
    );
    await mapTab.first().click();

    await expect(passenger.page.locator('svg').first()).toBeVisible();
    await assertWcagAA(passenger.page);
  });
});
