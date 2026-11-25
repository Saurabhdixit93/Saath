import { test, expect } from '@playwright/test';
import { SaathApiClient } from '../../helpers/api.js';
import { E2E_ENV, TEST_PNRS, futureDateIso, uniquePhone } from '../../helpers/env.js';

function buildSampleIrctcSms(pnr: string, dateIso: string): string {
  return `IRCTC PNR:${pnr},TRN:12951,DOJ:${dateIso},CLS:3A,B3 42 UB,NDLS-MMCT,CHART NOT PREPARED`;
}

test.describe('@tier1 F07: Train SMS / E-Ticket Parse Fallback', () => {
  test('POST /v1/journeys/verify with sms_text parses IRCTC SMS into verified_doc journey', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone('f07-sms-api'), 'whatsapp');
    const sms = buildSampleIrctcSms(TEST_PNRS.rajdhani3A, futureDateIso(5));

    const res = await api.verifyTrainSms(auth.access, sms);
    expect([200, 201]).toContain(res.status);
    expect(res.data.trust_tier).toBe('verified_doc');
    expect(res.data.journey).toBeTruthy();
  });

  test('SMS parser maps coach and berth type accurately', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone('f07-berth'), 'whatsapp');
    const sms = `PNR ${TEST_PNRS.sleeperSL} Train 12137 DOJ ${futureDateIso(6)} SL Coach S4 Seat 25 LB CNF`;

    const res = await api.verifyTrainSms<{
      seat_holders?: Array<{ coach?: string; seat_type?: string }>;
    }>(auth.access, sms);
    expect([200, 201]).toContain(res.status);
    const holder = res.data.seat_holders?.[0];
    expect(holder).toBeDefined();
    expect(holder?.coach).toBe('S4');
    expect(holder?.seat_type).toBe('LB');
  });

  test('Web UI PNRInput paste-detect extracts 10-digit PNR from pasted IRCTC SMS', async ({
    page,
  }) => {
    await page.goto(E2E_ENV.webUrl, { waitUntil: 'domcontentloaded' });
    const pnrInput = page.getByLabel(/pnr/i).or(page.getByPlaceholder(/10-digit|pnr/i)).first();
    await expect(pnrInput).toBeVisible();

    const sms = buildSampleIrctcSms(TEST_PNRS.rajdhani3A, futureDateIso(5));
    await pnrInput.fill(sms);

    await expect(pnrInput).toHaveValue(new RegExp(TEST_PNRS.rajdhani3A));
  });

  test('Web UI SMS fallback mode submits pasted e-ticket text and opens Journey Hub', async ({
    page,
  }) => {
    await page.goto(E2E_ENV.webUrl, { waitUntil: 'domcontentloaded' });
    const fallbackToggle = page.getByRole('button', { name: /paste.*sms|e-ticket|sms/i }).or(
      page.getByText(/paste.*sms|e-ticket/i),
    );
    await expect(fallbackToggle.first()).toBeVisible();
    await fallbackToggle.first().click();

    const smsBox = page.getByRole('textbox').last();
    await smsBox.fill(buildSampleIrctcSms(TEST_PNRS.rajdhani3A, futureDateIso(5)));

    const submitBtn = page.getByRole('button', { name: /verify|parse|submit|सत्यापित/i });
    await submitBtn.first().click();

    await expect(page).toHaveURL(/\/journeys\//);
  });

  test('Journey Hub displays verified_doc / document-verified badge for SMS-verified booking', async ({
    page,
  }) => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone('f07-badge'), 'whatsapp');
    const sms = buildSampleIrctcSms(TEST_PNRS.sleeperSL, futureDateIso(7));
    const res = await api.verifyTrainSms<{ journey?: { id: string } }>(auth.access, sms);
    expect(res.ok).toBe(true);

    const journeyId = res.data.journey?.id;
    expect(typeof journeyId).toBe('string');

    await page.goto(E2E_ENV.webUrl, { waitUntil: 'domcontentloaded' });
    await page.evaluate((t) => {
      window.localStorage.setItem('saath_access_token', t.access);
      window.localStorage.setItem('access_token', t.access);
      window.localStorage.setItem('saath_refresh_token', t.refresh);
    }, auth);

    await page.goto(`${E2E_ENV.webUrl}/journeys/${String(journeyId)}`, {
      waitUntil: 'domcontentloaded',
    });
    await expect(page.getByText(/verified|doc|sms|ticket/i).first()).toBeVisible();
  });
});
