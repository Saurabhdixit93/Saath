import { test, expect } from '@playwright/test';
import { SaathApiClient } from '../../helpers/api.js';
import {
  buildBcbpString,
  generateBcbpPdf,
  generateBcbpPng,
} from '../../helpers/bcbp.js';
import { E2E_ENV, TEST_FLIGHTS, futureDateIso, uniquePhone } from '../../helpers/env.js';

function uniquePnrCode(prefix: string, seed: number): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = prefix;
  let val = seed;
  while (out.length < 6) {
    out += chars[val % chars.length] ?? 'X';
    val = Math.floor(val / chars.length) + 7;
  }
  return out;
}

test.describe('@tier1 F08: Flight BCBP Boarding Pass Verification', () => {
  test('API verifies single-leg IndiGo 6E A320neo IATA Res 792 BCBP with trust_tier=verified_bcbp', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone('f08-single'), 'whatsapp');
    const bcbp = buildBcbpString({
      passengerName: 'SHARMA/NEHA',
      pnr: uniquePnrCode('K', 101),
      from: TEST_FLIGHTS.indigoA320neo.defaultFrom,
      to: TEST_FLIGHTS.indigoA320neo.defaultTo,
      carrier: TEST_FLIGHTS.indigoA320neo.airline,
      flightNo: TEST_FLIGHTS.indigoA320neo.flightNo,
      julianDate: futureDateIso(5),
      seatNo: TEST_FLIGHTS.indigoA320neo.sampleValidSeat,
    });

    const res = await api.verifyFlightBcbp<{
      trust_tier?: string;
      seat_holders?: Array<{ seat_type?: string }>;
    }>(auth.access, bcbp);
    expect([200, 201]).toContain(res.status);
    expect(res.data.trust_tier).toBe('verified_bcbp');
    expect(res.data.seat_holders?.[0]?.seat_type).toBeDefined();
  });

  test('API parses multi-leg (M2) IATA Resolution 792 BCBP payload', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone('f08-multileg'), 'whatsapp');
    const travelDate = futureDateIso(6);
    const bcbp = buildBcbpString({
      passengerName: 'VERMA/ROHAN',
      pnr: uniquePnrCode('M', 202),
      from: 'DEL',
      to: 'BOM',
      carrier: '6E',
      flightNo: '2134',
      julianDate: travelDate,
      seatNo: '14A',
      legs: [
        {
          pnr: uniquePnrCode('L', 203),
          from: 'BOM',
          to: 'BLR',
          carrier: '6E',
          flightNo: '5112',
          julianDate: travelDate,
          seatNo: '08A',
        },
      ],
    });

    const res = await api.verifyFlightBcbp(auth.access, bcbp);
    expect([200, 201]).toContain(res.status);
    expect(res.data.trust_tier).toBe('verified_bcbp');
  });

  test('Aircraft layout validation identifies window (A) vs aisle (C) seats on 6E A320neo', async () => {
    const api = new SaathApiClient();
    const userWin = await api.loginWithOtp(uniquePhone('f08-win'), 'whatsapp');
    const userAisle = await api.loginWithOtp(uniquePhone('f08-aisle'), 'whatsapp');
    const travelDate = futureDateIso(7);

    const winBcbp = buildBcbpString({
      pnr: uniquePnrCode('W', 301),
      from: 'DEL',
      to: 'BOM',
      carrier: '6E',
      flightNo: '2134',
      julianDate: travelDate,
      seatNo: TEST_FLIGHTS.indigoA320neo.sampleWindowSeat,
    });
    const aisleBcbp = buildBcbpString({
      pnr: uniquePnrCode('A', 302),
      from: 'DEL',
      to: 'BOM',
      carrier: '6E',
      flightNo: '2134',
      julianDate: travelDate,
      seatNo: TEST_FLIGHTS.indigoA320neo.sampleAisleSeat,
    });

    const resWin = await api.verifyFlightBcbp<{
      seat_holders?: Array<{ seat_type?: string }>;
    }>(userWin.access, winBcbp);
    const resAisle = await api.verifyFlightBcbp<{
      seat_holders?: Array<{ seat_type?: string }>;
    }>(userAisle.access, aisleBcbp);

    expect(resWin.ok).toBe(true);
    expect(resAisle.ok).toBe(true);
    expect(resWin.data.seat_holders?.[0]?.seat_type).toMatch(/^W/i);
    expect(resAisle.data.seat_holders?.[0]?.seat_type).toMatch(/^A/i);
  });

  test('Web UI BoardingPassScanner decodes real PDF417 PNG on-device via zxing-wasm', async ({
    page,
  }) => {
    const bcbp = buildBcbpString({
      pnr: uniquePnrCode('P', 401),
      from: 'DEL',
      to: 'BOM',
      carrier: '6E',
      flightNo: '2134',
      julianDate: futureDateIso(8),
      seatNo: '15A',
    });
    const pngBuffer = await generateBcbpPng(bcbp, 'pdf417');

    await page.goto(E2E_ENV.webUrl, { waitUntil: 'domcontentloaded' });
    await page.getByRole('tab', { name: /flight/i }).click();

    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles({
      name: 'boarding-pass.png',
      mimeType: 'image/png',
      buffer: pngBuffer,
    });

    await expect(page).toHaveURL(/\/journeys\//, { timeout: 20_000 });
    await expect(page.getByText(/6E|2134|15A|verified/i).first()).toBeVisible();
  });

  test('Web UI BoardingPassScanner decodes real pdf-lib PDF via pdf.js + zxing-wasm and renders CabinMap', async ({
    page,
  }) => {
    const bcbp = buildBcbpString({
      pnr: uniquePnrCode('D', 501),
      from: 'DEL',
      to: 'BOM',
      carrier: 'AI',
      flightNo: '0865',
      julianDate: futureDateIso(9),
      seatNo: '12F',
    });
    const pdfBuffer = await generateBcbpPdf(bcbp, 'pdf417');

    await page.goto(E2E_ENV.webUrl, { waitUntil: 'domcontentloaded' });
    await page.getByRole('tab', { name: /flight/i }).click();

    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles({
      name: 'boarding-pass.pdf',
      mimeType: 'application/pdf',
      buffer: pdfBuffer,
    });

    await expect(page).toHaveURL(/\/journeys\//, { timeout: 20_000 });
    await expect(page.getByText(/AI\s*865|12F|Cabin\s*Map/i).first()).toBeVisible();
  });
});
