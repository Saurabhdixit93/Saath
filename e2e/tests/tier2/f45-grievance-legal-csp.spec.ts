import { test, expect } from '../../fixtures/multi-browser.js';
import { assertTapTargets, assertWcagAA } from '../../helpers/a11y.js';
import { E2E_ENV } from '../../helpers/env.js';

function extractNonce(csp: string): string {
  const match = /'nonce-([^']+)'/i.exec(csp);
  return match?.[1] ?? '';
}

test.describe('@tier2 F45 Tier 2: Grievance Officer, Legal Pages & CSP Boundaries', () => {
  test('CSP header rotates cryptographic nonce across sequential HTTP requests', async () => {
    const res1 = await fetch(E2E_ENV.webUrl);
    const res2 = await fetch(E2E_ENV.webUrl);
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    const csp1 = res1.headers.get('content-security-policy') ?? '';
    const csp2 = res2.headers.get('content-security-policy') ?? '';
    const nonce1 = extractNonce(csp1);
    const nonce2 = extractNonce(csp2);
    expect(nonce1.length).toBeGreaterThanOrEqual(8);
    expect(nonce2.length).toBeGreaterThanOrEqual(8);
    expect(nonce1).not.toBe(nonce2);
  });

  test('script-src forbids unsafe-inline and wildcard * across /, /legal/privacy, /legal/terms, and /grievance', async () => {
    for (const path of ['/', '/legal/privacy', '/legal/terms', '/grievance']) {
      const res = await fetch(`${E2E_ENV.webUrl}${path}`);
      expect(res.status).toBe(200);
      const csp = res.headers.get('content-security-policy') ?? '';
      const scriptSrc = /script-src[^;]*/i.exec(csp)?.[0] ?? '';
      expect(scriptSrc).toContain('nonce-');
      expect(scriptSrc).not.toContain("'unsafe-inline'");
      expect(scriptSrc).not.toMatch(/\s\*(?:\s|$)/);
    }
  });

  test('Dark mode + 360x800 mobile + 200% zoom across legal and grievance pages pass axe, tap targets, and overflow', async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 360, height: 800 },
      hasTouch: true,
    });
    const page = await context.newPage();
    try {
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: /theme|dark|light|☾|☀/i }).click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

      for (const route of ['/legal/privacy', '/legal/terms', '/grievance']) {
        await page.goto(route, { waitUntil: 'domcontentloaded' });
        await assertWcagAA(page);
        await assertTapTargets(page);
        await page.evaluate(() => {
          document.documentElement.style.fontSize = '200%';
        });
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth,
        );
        expect(overflow).toBeLessThanOrEqual(2);
      }
    } finally {
      await context.close();
    }
  });

  test('Unsupported locale prefix (/fr/legal/privacy) returns 404 cleanly without 500', async () => {
    const res = await fetch(`${E2E_ENV.webUrl}/fr/legal/privacy`);
    expect(res.status).toBe(404);
  });

  test('Legal and grievance routes return X-Content-Type-Options: nosniff and omit x-powered-by', async () => {
    for (const route of ['/legal/privacy', '/legal/terms', '/grievance']) {
      const res = await fetch(`${E2E_ENV.webUrl}${route}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('x-powered-by')).toBeNull();
    }
  });
});
