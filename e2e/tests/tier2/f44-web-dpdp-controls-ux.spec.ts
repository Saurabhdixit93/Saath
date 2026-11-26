import { test, expect, injectAuthSession } from '../../fixtures/multi-browser.js';
import { assertTapTargets, assertWcagAA } from '../../helpers/a11y.js';
import { TEST_PNRS, uniquePhone } from '../../helpers/env.js';
import { assertNoPiiLeak } from '../../helpers/pii.js';

test.describe('@tier2 F44 Tier 2: Web DPDP Controls & Consent UX Boundaries', () => {
  test('Cancelling Delete Account confirmation modal on /profile preserves session and account', async ({
    createIsolatedPassenger,
  }) => {
    const passenger = await createIsolatedPassenger('f44-t2-cancel');
    const auth = await passenger.api.loginWithOtp(uniquePhone('f44-t2-cancel'));
    await injectAuthSession(passenger.page, auth);
    await passenger.page.goto('/profile', { waitUntil: 'domcontentloaded' });

    await passenger.page.getByRole('button', { name: /Delete my data|Delete account/i }).click();
    const cancelBtn = passenger.page.getByRole('button', { name: /cancel|keep|close|रद्द/i }).first();
    await expect(cancelBtn).toBeVisible();
    await cancelBtn.click();

    const tokenAfter = await passenger.page.evaluate(
      () => window.localStorage.getItem('saath_access_token') ?? '',
    );
    expect(tokenAfter.length).toBeGreaterThan(10);
    expect((await passenger.api.getMe(auth.access)).status).toBe(200);
  });

  test('Unauthenticated /profile shows sign-in gate without leaking PII', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto('/profile', { waitUntil: 'domcontentloaded' });
      const bodyText = await page.locator('body').innerText();
      assertNoPiiLeak({ text: bodyText }, 'f44-t2-unauth-profile');
      expect(/sign in|verify|phone|login|साइन/i.test(bodyText) || /\/login/.test(page.url())).toBe(
        true,
      );
    } finally {
      await context.close();
    }
  });

  test('DPDP consent sheet and /profile controls pass WCAG 2.2 AA & >=48px tap targets at 360x800', async ({
    browser,
    createIsolatedPassenger,
  }) => {
    const helper = await createIsolatedPassenger('f44-t2-a11y');
    const auth = await helper.api.loginWithOtp(uniquePhone('f44-t2-a11y'));
    const context = await browser.newContext({
      viewport: { width: 360, height: 800 },
      hasTouch: true,
    });
    const page = await context.newPage();
    try {
      await injectAuthSession(page, auth);
      await page.goto('/profile', { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('button', { name: /Download my data|Export/i })).toBeVisible();
      await assertWcagAA(page);
      await assertTapTargets(page);

      await page.goto('/', { waitUntil: 'domcontentloaded' });
      const pnrInput = page
        .getByLabel(/pnr/i)
        .or(page.getByPlaceholder(/10-digit|pnr/i))
        .first();
      await pnrInput.fill(TEST_PNRS.rajdhani3A);
      await page.getByRole('button', { name: /verify|check/i }).first().click();
      await expect(page.getByText(/DPDP|Consent|Data use/i).first()).toBeVisible();
      await assertWcagAA(page);
      await assertTapTargets(page);
    } finally {
      await context.close();
    }
  });

  test('200% text zoom on /profile at 360x800 causes zero horizontal overflow', async ({
    browser,
    createIsolatedPassenger,
  }) => {
    const helper = await createIsolatedPassenger('f44-t2-zoom');
    const auth = await helper.api.loginWithOtp(uniquePhone('f44-t2-zoom'));
    const context = await browser.newContext({
      viewport: { width: 360, height: 800 },
      hasTouch: true,
    });
    const page = await context.newPage();
    try {
      await injectAuthSession(page, auth);
      await page.goto('/profile', { waitUntil: 'domcontentloaded' });
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

  test('Clicking Download my data on /profile with an expired/revoked token handles 401 cleanly without PII leak', async ({
    createIsolatedPassenger,
  }) => {
    const passenger = await createIsolatedPassenger('f44-t2-revoked');
    const auth = await passenger.api.loginWithOtp(uniquePhone('f44-t2-revoked'));
    await injectAuthSession(passenger.page, auth);
    await passenger.page.goto('/profile', { waitUntil: 'domcontentloaded' });

    await passenger.api.deleteMyAccount(auth.access);

    const downloadBtn = passenger.page.getByRole('button', { name: /Download my data|Export/i });
    await expect(downloadBtn).toBeVisible();
    await downloadBtn.click();

    await expect(
      passenger.page.getByText(/sign in|expired|error|failed|unauthorized/i).first(),
    ).toBeVisible();
    const bodyText = await passenger.page.locator('body').innerText();
    assertNoPiiLeak({ text: bodyText }, 'f44-t2-revoked-ui');
  });
});
