import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const WEB_URL = process.env.WEB_URL ?? 'http://localhost:3000';

// Expose normalized defaults in env so helpers resolve identically in worker processes.
process.env.WEB_URL ??= WEB_URL;
process.env.ADMIN_URL ??= 'http://localhost:3001';
process.env.API_URL ??= 'http://localhost:8000';
process.env.WS_URL ??= 'ws://localhost:8000';

export function resolveChromiumExecutablePath(): string | undefined {
  const explicit = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim();
  if (explicit) {
    return explicit;
  }

  if (process.platform !== 'darwin') {
    return undefined;
  }

  const msPlaywrightDir = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  if (fs.existsSync(msPlaywrightDir)) {
    const chromiumDirs = fs
      .readdirSync(msPlaywrightDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^chromium-\d+$/.test(entry.name))
      .sort((a, b) => {
        const revA = Number.parseInt(a.name.replace('chromium-', ''), 10);
        const revB = Number.parseInt(b.name.replace('chromium-', ''), 10);
        return revB - revA;
      });

    for (const dir of chromiumDirs) {
      const base = path.join(msPlaywrightDir, dir.name);
      const candidates = [
        path.join(
          base,
          'chrome-mac-x64',
          'Google Chrome for Testing.app',
          'Contents',
          'MacOS',
          'Google Chrome for Testing',
        ),
        path.join(
          base,
          'chrome-mac-arm64',
          'Google Chrome for Testing.app',
          'Contents',
          'MacOS',
          'Google Chrome for Testing',
        ),
        path.join(base, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
      ];
      for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      }
    }
  }

  const systemChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (fs.existsSync(systemChrome)) {
    return systemChrome;
  }

  return undefined;
}

const chromiumExecutablePath = resolveChromiumExecutablePath();
const workers = Number(process.env.E2E_WORKERS ?? 1);

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: Number.isFinite(workers) && workers > 0 ? workers : 1,
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: WEB_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    launchOptions: chromiumExecutablePath
      ? { executablePath: chromiumExecutablePath }
      : undefined,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
      },
    },
  ],
});
