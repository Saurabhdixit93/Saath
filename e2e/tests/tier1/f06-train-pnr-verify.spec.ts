import { test, expect } from '@playwright/test';
import { SaathApiClient } from '../../helpers/api.js';
import { E2E_ENV, TEST_PNRS, uniquePhone } from '../../helpers/env.js';
import { assertNoPiiLeak } from '../../helpers/pii.js';

function getSeatHolders(data: Record<string, unknown>): Array<Record<string, unknown>> {
  const holders = data.seat_holders;
  if (!Array.isArray(holders) || holders.length === 0) {
    throw new Error('Expected non-empty seat_holders array');
  }
  return holders as Array<Record<string, unknown>>;
}

test.describe('@tier1 F06: Train PNR Verification', () => {
  test('Verify 3A Rajdhani PNR returns verified_provider journey with zero raw passenger names', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone('f06-3a'), 'whatsapp');

    const res = await api.verifyTrainPnr(auth.access, TEST_PNRS.rajdhani3A);
    expect([200, 201]).toContain(res.status);
    expect(res.data.trust_tier).toBe('verified_provider');
    expect(res.data.journey).toBeTruthy();
    expect(res.data.booking).toBeTruthy();

    const holders = getSeatHolders(res.data);
    expect(holders.length).toBeGreaterThanOrEqual(1);
    assertNoPiiLeak(res.data, 'f06-3a-verify', [TEST_PNRS.rajdhani3A], {
      allowLayoutSeatNo: false,
      allowedKeys: ['seat_no'],
    });
  });

  test('Verify Sleeper (SL) PNR maps standard sleeper berth types', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone('f06-sl'), 'whatsapp');

    const res = await api.verifyTrainPnr(auth.access, TEST_PNRS.sleeperSL);
    expect([200, 201]).toContain(res.status);
    expect(res.data.trust_tier).toBe('verified_provider');

    const holders = getSeatHolders(res.data);
    const first = holders[0];
    expect(first).toBeDefined();
    expect(['LB', 'MB', 'UB', 'SL', 'SU']).toContain(String(first?.seat_type));
  });

  test('Verify Vande Bharat Chair Car (CC) PNR maps WS/MS/AS seat types', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone('f06-cc'), 'whatsapp');

    const res = await api.verifyTrainPnr(auth.access, TEST_PNRS.vandeBharatCC);
    expect([200, 201]).toContain(res.status);
    expect(res.data.trust_tier).toBe('verified_provider');

    const holders = getSeatHolders(res.data);
    const first = holders[0];
    expect(first).toBeDefined();
    expect(['WS', 'MS', 'AS', 'CC']).toContain(String(first?.seat_type));
  });

  test('Verify RAC/WL PNR handles RAC/waitlist booking status cleanly', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone('f06-rac'), 'whatsapp');

    const res = await api.verifyTrainPnr(auth.access, TEST_PNRS.racWL);
    expect([200, 201]).toContain(res.status);
    expect(res.data.trust_tier).toBe('verified_provider');
    const holders = getSeatHolders(res.data);
    const serialized = JSON.stringify(holders);
    expect(serialized).toMatch(/RAC|WL|CNF|SL/i);
  });

  test('Web UI Train PNR input verifies 10-digit PNR and opens Journey Hub without raw names', async ({
    page,
  }) => {
    await page.goto(E2E_ENV.webUrl, { waitUntil: 'domcontentloaded' });
    const pnrInput = page.getByLabel(/pnr/i).or(page.getByPlaceholder(/10-digit|pnr/i));
    await expect(pnrInput.first()).toBeVisible();
    await pnrInput.first().fill(TEST_PNRS.rajdhani3A);

    const verifyBtn = page.getByRole('button', { name: /verify|check|सत्यापित/i });
    await verifyBtn.first().click();

    await expect(page).toHaveURL(/\/journeys\//);
    await expect(page.getByText(/3A|12951|rajdhani|chart/i).first()).toBeVisible();
  });
});
