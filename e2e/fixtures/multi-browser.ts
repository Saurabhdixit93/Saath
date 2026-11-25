import { test as base, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { SaathApiClient, type AuthTokens } from '../helpers/api.js';
import { E2E_ENV } from '../helpers/env.js';

export interface PassengerSession {
  readonly name: string;
  readonly context: BrowserContext;
  readonly page: Page;
  readonly api: SaathApiClient;
}

export interface ThreePassengersFixture {
  userA: PassengerSession;
  userB: PassengerSession;
  userC: PassengerSession;
}

export interface MultiBrowserFixtures {
  createIsolatedPassenger: (name?: string) => Promise<PassengerSession>;
  threePassengers: ThreePassengersFixture;
}

async function spawnPassenger(
  browser: Browser,
  name: string,
  apiBaseUrl: string,
): Promise<PassengerSession> {
  const context = await browser.newContext({
    baseURL: E2E_ENV.webUrl,
  });
  const page = await context.newPage();
  const api = new SaathApiClient(apiBaseUrl);
  return { name, context, page, api };
}

/**
 * Injects EdDSA access/refresh session tokens into an isolated browser page's storage
 * so multi-browser scenarios can bind verified API sessions to live UI contexts.
 */
export async function injectAuthSession(
  page: Page,
  tokens: Pick<AuthTokens, 'access'> & Partial<Pick<AuthTokens, 'refresh' | 'user'>>,
  origin: string = E2E_ENV.webUrl,
): Promise<void> {
  const currentUrl = page.url();
  if (!currentUrl.startsWith(origin)) {
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
  }
  await page.evaluate((session) => {
    window.localStorage.setItem('saath_access_token', session.access);
    window.localStorage.setItem('access_token', session.access);
    if (session.refresh) {
      window.localStorage.setItem('saath_refresh_token', session.refresh);
      window.localStorage.setItem('refresh_token', session.refresh);
    }
    if (session.user) {
      window.localStorage.setItem('saath_user', JSON.stringify(session.user));
    }
  }, tokens);
}

export const test = base.extend<MultiBrowserFixtures>({
  createIsolatedPassenger: async ({ browser }, use) => {
    const created: BrowserContext[] = [];
    let counter = 0;

    const factory = async (name?: string): Promise<PassengerSession> => {
      counter += 1;
      const session = await spawnPassenger(
        browser,
        name ?? `passenger-${counter}`,
        E2E_ENV.apiUrl,
      );
      created.push(session.context);
      return session;
    };

    try {
      await use(factory);
    } finally {
      await Promise.all(
        created.map(async (ctx) => {
          await ctx.close().catch(() => undefined);
        }),
      );
    }
  },

  threePassengers: async ({ browser }, use) => {
    const [userA, userB, userC] = await Promise.all([
      spawnPassenger(browser, 'userA', E2E_ENV.apiUrl),
      spawnPassenger(browser, 'userB', E2E_ENV.apiUrl),
      spawnPassenger(browser, 'userC', E2E_ENV.apiUrl),
    ]);

    try {
      await use({ userA, userB, userC });
    } finally {
      await Promise.all([
        userA.context.close().catch(() => undefined),
        userB.context.close().catch(() => undefined),
        userC.context.close().catch(() => undefined),
      ]);
    }
  },
});

export { expect };
