import { test, expect, injectAuthSession } from '../../fixtures/multi-browser.js';
import { type MatchCardDto } from '../../helpers/api.js';
import {
  buildBcbpString,
  generateBcbpPdf,
  generateBcbpPng,
} from '../../helpers/bcbp.js';
import { TEST_FLIGHTS, futureDateIso, uniquePhone } from '../../helpers/env.js';
import { assertNoPiiLeak } from '../../helpers/pii.js';

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Expected object for ${label}`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Expected array for ${label}`);
  }
  return value;
}

function getString(obj: Record<string, unknown>, key: string): string {
  const val = obj[key];
  if (typeof val !== 'string' || val.length === 0) {
    throw new Error(`Expected string "${key}"`);
  }
  return val;
}

test.describe('S03: Flight BCBP PNG & PDF Upload -> CabinMap -> Pair Swap @tier4', () => {
  test('2 browsers decode real PDF417 PNG & PDF boarding passes via BoardingPassScanner, exclude declared from 3-cycles, and complete pair swap', async ({
    threePassengers,
  }) => {
    const { userA, userB, userC } = threePassengers;
    const travelDate = futureDateIso(7);
    const flight = TEST_FLIGHTS.indigoA320neo;

    const authA = await userA.api.loginWithOtp(uniquePhone(403_001));
    const authB = await userB.api.loginWithOtp(uniquePhone(403_002));
    const authC = await userC.api.loginWithOtp(uniquePhone(403_003));

    const bcbpA = buildBcbpString({
      passengerName: 'PATEL/AARAV',
      pnr: 'F403A1',
      from: flight.defaultFrom,
      to: flight.defaultTo,
      carrier: flight.airline,
      flightNo: flight.flightNo,
      julianDate: travelDate,
      seatNo: '14A',
      seqNo: '11',
    });

    const bcbpB = buildBcbpString({
      passengerName: 'NAIR/PRIYA',
      pnr: 'F403B2',
      from: flight.defaultFrom,
      to: flight.defaultTo,
      carrier: flight.airline,
      flightNo: flight.flightNo,
      julianDate: travelDate,
      seatNo: '14C',
      seqNo: '22',
    });

    const [pngBufferA, pdfBufferB] = await Promise.all([
      generateBcbpPng(bcbpA, 'pdf417'),
      generateBcbpPdf(bcbpB, 'pdf417'),
    ]);

    await Promise.all([
      injectAuthSession(userA.page, authA),
      injectAuthSession(userB.page, authB),
    ]);

    // Browser A uploads real PDF417 PNG to Flight BoardingPassScanner
    await userA.page.goto('/', { waitUntil: 'domcontentloaded' });
    await userA.page.getByRole('tab', { name: /Flight/i }).click();
    const fileInputA = userA.page.locator('input[type="file"]').first();
    await fileInputA.setInputFiles({
      name: 'boarding-pass-a.png',
      mimeType: 'image/png',
      buffer: pngBufferA,
    });
    await expect(userA.page).toHaveURL(/\/journeys\//, { timeout: 15_000 });
    await expect(userA.page.getByText(/14A/)).toBeVisible();

    // Browser B uploads real PDF boarding pass (pdf.js + zxing-wasm)
    await userB.page.goto('/', { waitUntil: 'domcontentloaded' });
    await userB.page.getByRole('tab', { name: /Flight/i }).click();
    const fileInputB = userB.page.locator('input[type="file"]').first();
    await fileInputB.setInputFiles({
      name: 'boarding-pass-b.pdf',
      mimeType: 'application/pdf',
      buffer: pdfBufferB,
    });
    await expect(userB.page).toHaveURL(/\/journeys\//, { timeout: 15_000 });
    await expect(userB.page.getByText(/14C/)).toBeVisible();

    // User C uses Declared fallback -> strictly excluded from 3-way cycles
    const decC = await userC.api.verifyFlightDeclared(authC.access, {
      flight_no: `${flight.airline}${flight.flightNo}`,
      date: travelDate,
      seat: '14B',
    });
    expect(decC.status).toBe(200);
    expect(decC.data.trust_tier).toBe('declared');

    const journeysA = await userA.api.getJourneys(authA.access);
    const journeysB = await userB.api.getJourneys(authB.access);
    const jAId = getString(asRecord(asArray(journeysA.data.items, 'jA')[0], 'jA0'), 'id');
    const jBId = getString(asRecord(asArray(journeysB.data.items, 'jB')[0], 'jB0'), 'id');

    const hubA = await userA.api.getJourney(authA.access, jAId);
    const hubB = await userB.api.getJourney(authB.access, jBId);
    const pAId = getString(asRecord(hubA.data.party, 'pA'), 'id');
    const pBId = getString(asRecord(hubB.data.party, 'pB'), 'id');

    await userA.api.setGoal(authA.access, pAId, {
      goal_type: 'aisle',
      movers: [getString(asRecord(asArray(hubA.data.seat_holders, 'hA')[0], 'hA0'), 'id')],
      preferred_seats: [],
      constraints: { women_only: false, no_middle: false, same_coach_only: false, verified_only: false },
    });
    await userB.api.setGoal(authB.access, pBId, {
      goal_type: 'window',
      movers: [getString(asRecord(asArray(hubB.data.seat_holders, 'hB')[0], 'hB0'), 'id')],
      preferred_seats: [],
      constraints: { women_only: false, no_middle: false, same_coach_only: false, verified_only: false },
    });

    // Verify CabinMap UI renders for flight
    await userA.page.goto(`/journeys/${jAId}/matches`, { waitUntil: 'domcontentloaded' });
    await userA.page.getByRole('tab', { name: /Cabin map|Map/i }).or(
      userA.page.getByRole('button', { name: /Cabin map|Map/i }),
    ).first().click();
    await expect(userA.page.locator('svg').first()).toBeVisible();

    // Verify declared User C never enters a 3-way cycle
    const hubC = await userC.api.getJourney(
      authC.access,
      getString(asRecord(decC.data.journey, 'jC'), 'id'),
    );
    const pCId = getString(asRecord(hubC.data.party, 'pC'), 'id');
    await userC.api.setGoal(authC.access, pCId, {
      goal_type: 'window',
      movers: [getString(asRecord(asArray(hubC.data.seat_holders, 'hC')[0], 'hC0'), 'id')],
      preferred_seats: [],
      constraints: { women_only: false, no_middle: false, same_coach_only: false, verified_only: false },
    });
    await expect(async () => {
      const matchesC = await userC.api.getMatches(authC.access, pCId, 'cycle');
      expect(matchesC.status).toBe(200);
      expect(Number(matchesC.data.match_version ?? 0)).toBeGreaterThanOrEqual(1);
      const cycle3Or4 = matchesC.data.items.filter(
        (m) => m.kind === 'cycle3' || m.kind === 'cycle4',
      );
      expect(cycle3Or4.length).toBe(0);
    }).toPass({ timeout: 12_000, intervals: [500, 1000, 1500] });

    // A & B complete pair swap -> Swap Card
    let pairCard: MatchCardDto | undefined;
    await expect(async () => {
      const matchesA = await userA.api.getMatches(authA.access, pAId, 'pair');
      expect(matchesA.status).toBe(200);
      expect(matchesA.data.items.length).toBeGreaterThanOrEqual(1);
      pairCard = matchesA.data.items[0];
    }).toPass({ timeout: 12_000, intervals: [500, 1000, 1500] });
    if (!pairCard) {
      throw new Error('Expected pair match card for flight BCBP swap');
    }

    const swapRes = await userA.api.createSwap(authA.access, pairCard.card_id);
    const swapId = getString(swapRes.data, 'id');
    const a1 = await userA.api.acceptSwap(authA.access, swapId, Number(swapRes.data.version ?? 0));
    const a2 = await userB.api.acceptSwap(authB.access, swapId, Number(a1.data.version ?? 1));
    expect(a2.data.status).toBe('confirmed');

    const card = await userA.api.getSwapCard(authA.access, swapId, 'json');
    const code = getString(card.data, 'public_code');
    const pub = await userA.api.verifyPublicSwapCard(code);
    expect(pub.data.valid).toBe(true);
    assertNoPiiLeak(pub.data, 's03-flight-swap-card', ['PATEL/AARAV', 'NAIR/PRIYA', 'F403A1', 'F403B2']);
  });
});
