import { test, expect } from '@playwright/test';
import { SaathApiClient } from '../../helpers/api.js';
import {
  buildBcbpString,
  buildInvalidSeatBcbp,
  buildMalformedBcbp,
  type MalformedBcbpKind,
} from '../../helpers/bcbp.js';
import { E2E_ENV, TEST_FLIGHTS, futureDateIso, uniquePhone } from '../../helpers/env.js';

const MALFORMED_KINDS: MalformedBcbpKind[] = [
  'empty',
  'short',
  'bad_format',
  'bad_leg_count',
  'bad_hex_size',
  'bad_seat_format',
];

test.describe('@tier2 F08: Flight BCBP Negative, Layout & Duplicate Claim Cases', () => {
  test('Malformed IATA Res 792 BCBP vectors all return 422 problem+json', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone('f08-t2-mal'), 'whatsapp');

    for (const kind of MALFORMED_KINDS) {
      const badBcbp = buildMalformedBcbp(kind);
      const res = await api.verifyFlightBcbp(auth.access, badBcbp);
      const problem = api.assertProblemJson(res, 422);
      expect(problem.status).toBe(422);
    }
  });

  test('Invalid Julian dates (999, ABC) return 422 while Dec 31 / Jan 01 rollover succeeds', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone('f08-t2-julian'), 'whatsapp');

    const bad999 = await api.verifyFlightBcbp(auth.access, buildMalformedBcbp('bad_julian'));
    api.assertProblemJson(bad999, 422);

    const badAlpha = await api.verifyFlightBcbp(
      auth.access,
      buildMalformedBcbp('non_numeric_julian'),
    );
    api.assertProblemJson(badAlpha, 422);

    const jan01 = buildBcbpString({
      pnr: 'J1R2K9',
      from: 'DEL',
      to: 'BOM',
      carrier: '6E',
      flightNo: '2134',
      julianDate: 1,
      seatNo: '14C',
    });
    const rolloverRes = await api.verifyFlightBcbp(auth.access, jan01);
    expect([200, 201]).toContain(rolloverRes.status);
  });

  test('Seats outside aircraft layout (99Z on A320neo, 30F on ATR72-600) rejected with 422', async () => {
    const api = new SaathApiClient();
    const auth = await api.loginWithOtp(uniquePhone('f08-t2-seat'), 'whatsapp');

    const badA320 = buildInvalidSeatBcbp({
      carrier: TEST_FLIGHTS.indigoA320neo.airline,
      flightNo: TEST_FLIGHTS.indigoA320neo.flightNo,
      julianDate: futureDateIso(5),
      seatNo: TEST_FLIGHTS.indigoA320neo.sampleInvalidSeat,
    });
    const res1 = await api.verifyFlightBcbp(auth.access, badA320);
    api.assertProblemJson(res1, 422);

    const badAtr = buildInvalidSeatBcbp({
      carrier: TEST_FLIGHTS.indigoAtr72.airline,
      flightNo: TEST_FLIGHTS.indigoAtr72.flightNo,
      from: TEST_FLIGHTS.indigoAtr72.defaultFrom,
      to: TEST_FLIGHTS.indigoAtr72.defaultTo,
      julianDate: futureDateIso(5),
      seatNo: TEST_FLIGHTS.indigoAtr72.sampleInvalidSeat,
    });
    const res2 = await api.verifyFlightBcbp(auth.access, badAtr);
    const problem = api.assertProblemJson(res2, 422);
    expect(problem.status).toBe(422);
  });

  test('Duplicate active BCBP claim for same (pnr, flight, date, seat) by another user returns 409 Conflict', async () => {
    const api = new SaathApiClient();
    const userA = await api.loginWithOtp(uniquePhone('f08-t2-dup-a'), 'whatsapp');
    const userB = await api.loginWithOtp(uniquePhone('f08-t2-dup-b'), 'whatsapp');

    const bcbp = buildBcbpString({
      pnr: 'DUP991',
      from: 'DEL',
      to: 'BOM',
      carrier: '6E',
      flightNo: '2134',
      julianDate: futureDateIso(10),
      seatNo: '16A',
    });

    const resA = await api.verifyFlightBcbp(userA.access, bcbp);
    expect([200, 201]).toContain(resA.status);

    const resB = await api.verifyFlightBcbp(userB.access, bcbp);
    const problem = api.assertProblemJson(resB, 409);
    expect(problem.status).toBe(409);
  });

  test('Uploading corrupted non-barcode image to BoardingPassScanner shows clean error without crash', async ({
    page,
  }) => {
    await page.goto(E2E_ENV.webUrl, { waitUntil: 'domcontentloaded' });
    await page.getByRole('tab', { name: /flight/i }).click();

    const corruptedPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles({
      name: 'corrupted.png',
      mimeType: 'image/png',
      buffer: corruptedPng,
    });

    await expect(
      page.getByText(/could not decode|no barcode|unable to read|try again|manual/i).first(),
    ).toBeVisible();
  });
});
