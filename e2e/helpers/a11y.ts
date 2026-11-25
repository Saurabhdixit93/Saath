import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

export interface WcagCheckOptions {
  exclude?: string[];
  disableRules?: string[];
}

export async function assertWcagAA(
  page: Page,
  options: WcagCheckOptions = {},
): Promise<void> {
  let builder = new AxeBuilder({ page }).withTags([
    'wcag2a',
    'wcag2aa',
    'wcag21a',
    'wcag21aa',
    'wcag22aa',
  ]);

  for (const selector of options.exclude ?? []) {
    builder = builder.exclude(selector);
  }
  if (options.disableRules && options.disableRules.length > 0) {
    builder = builder.disableRules(options.disableRules);
  }

  const results = await builder.analyze();
  if (results.violations.length > 0) {
    const formatted = results.violations
      .map(
        (v) =>
          `[${v.impact ?? 'unknown'}] ${v.id}: ${v.help}\n` +
          v.nodes
            .slice(0, 5)
            .map((n) => `    target=${n.target.join(' ')} (${n.failureSummary ?? ''})`)
            .join('\n'),
      )
      .join('\n\n');
    throw new Error(`WCAG 2.2 AA violations found on ${page.url()}:\n${formatted}`);
  }
}

export interface TapTargetOptions {
  minSizePx?: number;
  selector?: string;
}

export async function assertTapTargets(
  page: Page,
  options: TapTargetOptions = {},
): Promise<void> {
  const minSize = options.minSizePx ?? 48;
  const selector =
    options.selector ??
    'button, a[href], [role="button"], input:not([type="hidden"]), select, summary';

  const failures = await page.evaluate(
    ({ sel, min }) => {
      const elements = Array.from(document.querySelectorAll<HTMLElement>(sel));
      const bad: Array<{ tag: string; text: string; width: number; height: number }> = [];

      for (const el of elements) {
        const style = window.getComputedStyle(el);
        if (
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          style.opacity === '0'
        ) {
          continue;
        }
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) {
          continue;
        }
        // Skip inline prose links inside paragraphs unless explicitly styled as controls
        if (
          el.tagName === 'A' &&
          style.display === 'inline' &&
          el.closest('p, li') !== null &&
          !el.getAttribute('role')
        ) {
          continue;
        }
        if (rect.width < min - 0.5 || rect.height < min - 0.5) {
          bad.push({
            tag: el.tagName.toLowerCase(),
            text: (el.innerText || el.getAttribute('aria-label') || el.id || '').trim().slice(0, 40),
            width: Math.round(rect.width * 10) / 10,
            height: Math.round(rect.height * 10) / 10,
          });
        }
      }
      return bad;
    },
    { sel: selector, min: minSize },
  );

  if (failures.length > 0) {
    const details = failures
      .slice(0, 10)
      .map((f) => `<${f.tag}> "${f.text}" -> ${f.width}x${f.height}px`)
      .join('\n  - ');
    throw new Error(
      `Tap targets smaller than ${minSize}x${minSize}px on ${page.url()}:\n  - ${details}`,
    );
  }
}

export const SAATH_THEME_TOKENS = {
  light: {
    bg: '#faf7f2',
    primary: '#e2572b',
    secondary: '#1f6f78',
  },
  dark: {
    bg: '#0f1115',
    primary: '#ff7a4d',
    secondary: '#4fb3bd',
  },
} as const;

export async function assertThemeTokens(
  page: Page,
  expectedTheme: 'light' | 'dark',
): Promise<void> {
  const actual = await page.evaluate(() => {
    const root = document.documentElement;
    const rootStyle = window.getComputedStyle(root);
    const bodyStyle = window.getComputedStyle(document.body);

    function toHex(color: string): string {
      const trimmed = color.trim().toLowerCase();
      if (trimmed === 'transparent' || /^rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)$/.test(trimmed)) {
        return 'transparent';
      }
      if (trimmed.startsWith('#')) {
        if (trimmed.length === 4) {
          return `#${trimmed[1]}${trimmed[1]}${trimmed[2]}${trimmed[2]}${trimmed[3]}${trimmed[3]}`;
        }
        return trimmed.slice(0, 7);
      }
      const match = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(trimmed);
      if (!match?.[1] || !match[2] || !match[3]) {
        return trimmed;
      }
      const r = Number.parseInt(match[1], 10).toString(16).padStart(2, '0');
      const g = Number.parseInt(match[2], 10).toString(16).padStart(2, '0');
      const b = Number.parseInt(match[3], 10).toString(16).padStart(2, '0');
      return `#${r}${g}${b}`;
    }

    return {
      dataTheme: root.getAttribute('data-theme'),
      bgVar: toHex(rootStyle.getPropertyValue('--bg')),
      primaryVar: toHex(rootStyle.getPropertyValue('--primary')),
      secondaryVar: toHex(rootStyle.getPropertyValue('--secondary')),
      bodyBg: toHex(bodyStyle.backgroundColor),
    };
  });

  const expected = SAATH_THEME_TOKENS[expectedTheme];
  const mismatches: string[] = [];

  if (actual.dataTheme !== expectedTheme) {
    mismatches.push(
      `data-theme=${JSON.stringify(actual.dataTheme)} (expected "${expectedTheme}")`,
    );
  }

  if (actual.bgVar !== expected.bg) {
    mismatches.push(
      `--bg="${actual.bgVar}" (expected "${expected.bg}", bodyBg="${actual.bodyBg}")`,
    );
  }

  if (actual.bodyBg !== 'transparent' && actual.bodyBg !== expected.bg) {
    mismatches.push(`bodyBg="${actual.bodyBg}" (expected "${expected.bg}")`);
  }

  if (actual.primaryVar !== expected.primary) {
    mismatches.push(`--primary="${actual.primaryVar}" (expected "${expected.primary}")`);
  }

  if (actual.secondaryVar !== expected.secondary) {
    mismatches.push(
      `--secondary="${actual.secondaryVar}" (expected "${expected.secondary}")`,
    );
  }

  if (mismatches.length > 0) {
    throw new Error(
      `Saath ${expectedTheme} theme token mismatch on ${page.url()}:\n  - ${mismatches.join('\n  - ')}`,
    );
  }
}

export interface LocaleCheckOptions {
  /** Texts (e.g. PNR or seat labels) that must strictly retain ASCII Latin digits [0-9]. */
  latinDigitTexts?: string[];
  /** Optional selector whose text should be verified to contain Devanagari in `hi` mode. */
  sampleSelector?: string;
}

export async function assertLocale(
  page: Page,
  locale: 'en' | 'hi',
  options: LocaleCheckOptions = {},
): Promise<void> {
  const snapshot = await page.evaluate((sel) => {
    const target = sel ? document.querySelector<HTMLElement>(sel) : document.body;
    return {
      htmlLang: document.documentElement.lang,
      text: target ? target.innerText : document.body.innerText,
    };
  }, options.sampleSelector ?? null);

  const normalizedLang = snapshot.htmlLang.trim().toLowerCase();
  if (!normalizedLang || !normalizedLang.startsWith(locale)) {
    throw new Error(
      `Expected non-empty <html lang> starting with "${locale}", got "${snapshot.htmlLang}"`,
    );
  }

  const devanagariPattern = /[\u0900-\u097F]/;
  const devanagariDigitPattern = /[\u0966-\u096F]/;

  if (locale === 'hi' && !devanagariPattern.test(snapshot.text)) {
    throw new Error(
      `Expected Devanagari script characters for locale="hi" on ${page.url()}, found none`,
    );
  }

  for (const text of options.latinDigitTexts ?? []) {
    if (devanagariDigitPattern.test(text)) {
      throw new Error(
        `PNR/seat text "${text}" used Devanagari numerals; DESIGN.md requires Latin digits [0-9]`,
      );
    }
    if (!/[0-9]/.test(text)) {
      throw new Error(`Expected Latin digits [0-9] in "${text}"`);
    }
  }
}
