export const E2E_ENV = {
  webUrl: process.env.WEB_URL ?? 'http://localhost:3000',
  adminUrl: process.env.ADMIN_URL ?? 'http://localhost:3001',
  apiUrl: process.env.API_URL ?? 'http://localhost:8000',
  wsUrl: process.env.WS_URL ?? 'ws://localhost:8000',
  turnstileTestToken: process.env.TURNSTILE_TEST_TOKEN ?? 'fake-turnstile-ok',
  testOtpCode: process.env.E2E_TEST_OTP ?? '123456',
  adminTestEmail: process.env.E2E_ADMIN_EMAIL ?? 'ops@saath.test',
  whatsappWebhookSecret:
    process.env.WHATSAPP_APP_SECRET?.trim() || 'dev-whatsapp-secret',
  paymentWebhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET ?? 'dev-razorpay-secret',
  b2bApiKey: process.env.E2E_B2B_API_KEY ?? 'saath_test_b2b_key',
  envMode: process.env.ENV ?? 'test',
} as const;

function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Deterministic Indian 10-digit mobile number matching `/^[6-9]\d{9}$/`.
 */
export function uniquePhone(seed: number | string): string {
  const leadingDigits = ['6', '7', '8', '9'] as const;
  let hash: number;
  if (typeof seed === 'number') {
    const normalizedSeed = Number.isFinite(seed)
      ? Math.abs(Math.trunc(seed || 0))
      : 0;
    hash = Math.abs(Math.imul(normalizedSeed + 1, 2654435761)) >>> 0;
  } else {
    hash = fnv1a32(seed);
  }
  const first = leadingDigits[hash % leadingDigits.length] ?? '9';
  const tail = String((hash % 900_000_000) + 100_000_000).slice(0, 9);
  return `${first}${tail}`;
}

/**
 * Deterministic 10-digit PNR matching `/^\d{10}$/`.
 */
export function uniquePnr(seed: number | string): string {
  const hash =
    typeof seed === 'number'
      ? Math.abs(Math.imul(Math.trunc(seed) + 17, 2246822519)) >>> 0
      : fnv1a32(`pnr:${seed}`);
  const prefix = String((hash % 8) + 2); // 2..9
  const rest = String(hash).padStart(9, '0').slice(-9);
  return `${prefix}${rest}`;
}

export const TEST_PNRS = {
  /** 12951 Mumbai Rajdhani 3A */
  rajdhani3A: process.env.E2E_PNR_3A ?? '2415678901',
  /** Sleeper (SL) coach */
  sleeperSL: process.env.E2E_PNR_SL ?? '4512345678',
  /** Vande Bharat Chair Car (CC) */
  vandeBharatCC: process.env.E2E_PNR_CC ?? '6123456789',
  /** RAC / WL status PNR */
  racWL: process.env.E2E_PNR_RAC ?? '8234567890',
  /** 2A two-tier AC */
  twoTier2A: process.env.E2E_PNR_2A ?? '2712345678',
  /** 1A first AC */
  firstAC1A: process.env.E2E_PNR_1A ?? '2112345678',
  /** 3E economy AC */
  economy3E: process.env.E2E_PNR_3E ?? '2312345678',
  /** 2S second sitting */
  secondSitting2S: process.env.E2E_PNR_2S ?? '2912345678',
  /** 3-way cycle test PNRs on same journey instance */
  cycleA: process.env.E2E_PNR_CYCLE_A ?? '4111111111',
  cycleB: process.env.E2E_PNR_CYCLE_B ?? '4222222222',
  cycleC: process.env.E2E_PNR_CYCLE_C ?? '4333333333',
  /** Morning departure train (05:00-14:00 IST -> 20:00 prev day chart rule) */
  morningChart: process.env.E2E_PNR_MORNING ?? '6511111111',
  /** Afternoon/night departure train (14:01-04:59 IST -> -10h chart rule) */
  nightChart: process.env.E2E_PNR_NIGHT ?? '6522222222',
  /** Negative sentinels */
  invalid: '0000000000',
  flushed: '9999999991',
  cancelled: '9999999992',
} as const;

export interface FlightPreset {
  readonly airline: string;
  readonly airlineName: string;
  readonly flightNo: string;
  readonly aircraft: string;
  readonly totalSeats: number;
  readonly layout: string;
  readonly defaultFrom: string;
  readonly defaultTo: string;
  readonly sampleValidSeat: string;
  readonly sampleWindowSeat: string;
  readonly sampleAisleSeat: string;
  readonly sampleInvalidSeat: string;
}

export const TEST_FLIGHTS = {
  indigoA320neo: {
    airline: '6E',
    airlineName: 'IndiGo',
    flightNo: '2134',
    aircraft: 'A320neo',
    totalSeats: 186,
    layout: '3-3',
    defaultFrom: 'DEL',
    defaultTo: 'BOM',
    sampleValidSeat: '14C',
    sampleWindowSeat: '14A',
    sampleAisleSeat: '14C',
    sampleInvalidSeat: '99Z',
  },
  indigoA321neo: {
    airline: '6E',
    airlineName: 'IndiGo',
    flightNo: '5112',
    aircraft: 'A321neo',
    totalSeats: 222,
    layout: '3-3',
    defaultFrom: 'BOM',
    defaultTo: 'BLR',
    sampleValidSeat: '08A',
    sampleWindowSeat: '08A',
    sampleAisleSeat: '08C',
    sampleInvalidSeat: '99Z',
  },
  indigoAtr72: {
    airline: '6E',
    airlineName: 'IndiGo',
    flightNo: '7104',
    aircraft: 'ATR72-600',
    totalSeats: 78,
    layout: '2-2',
    defaultFrom: 'BLR',
    defaultTo: 'GOI',
    sampleValidSeat: '05A',
    sampleWindowSeat: '05A',
    sampleAisleSeat: '05C',
    sampleInvalidSeat: '30F',
  },
  akasa737Max8: {
    airline: 'QP',
    airlineName: 'Akasa Air',
    flightNo: '1102',
    aircraft: '737 MAX 8',
    totalSeats: 189,
    layout: '3-3',
    defaultFrom: 'BOM',
    defaultTo: 'DEL',
    sampleValidSeat: '12F',
    sampleWindowSeat: '12F',
    sampleAisleSeat: '12D',
    sampleInvalidSeat: '99Z',
  },
  airIndiaA320neo: {
    airline: 'AI',
    airlineName: 'Air India',
    flightNo: '0865',
    aircraft: 'A320neo',
    totalSeats: 186,
    layout: '3-3',
    defaultFrom: 'DEL',
    defaultTo: 'BOM',
    sampleValidSeat: '14D',
    sampleWindowSeat: '14A',
    sampleAisleSeat: '14D',
    sampleInvalidSeat: '99Z',
  },
  airIndiaExpress737: {
    airline: 'IX',
    airlineName: 'Air India Express',
    flightNo: '0341',
    aircraft: '737-8',
    totalSeats: 189,
    layout: '3-3',
    defaultFrom: 'COK',
    defaultTo: 'DXB',
    sampleValidSeat: '10A',
    sampleWindowSeat: '10A',
    sampleAisleSeat: '10C',
    sampleInvalidSeat: '99Z',
  },
  spiceJet737: {
    airline: 'SG',
    airlineName: 'SpiceJet',
    flightNo: '0157',
    aircraft: '737-800',
    totalSeats: 189,
    layout: '3-3',
    defaultFrom: 'DEL',
    defaultTo: 'PNQ',
    sampleValidSeat: '11C',
    sampleWindowSeat: '11A',
    sampleAisleSeat: '11C',
    sampleInvalidSeat: '99Z',
  },
} as const satisfies Record<string, FlightPreset>;

/**
 * Returns a deterministic future travel date (`YYYY-MM-DD`) relative to today in UTC.
 */
export function futureDateIso(daysAhead = 5): string {
  const now = new Date();
  const target = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysAhead),
  );
  return target.toISOString().slice(0, 10);
}

const IST_OFFSET_MS = 330 * 60_000;

/**
 * Computes the 1-based Julian day of year (1..366) for IATA Resolution 792 BCBP payloads.
 * Date-only `YYYY-MM-DD` strings are treated as that exact calendar date; timestamp strings
 * and `Date` instances use the requested timezone (`'utc'` by default, or `'ist'`).
 */
export function toJulianDay(
  date: Date | string,
  timeZone: 'utc' | 'ist' = 'utc',
): number {
  let year: number;
  let monthIndex: number;
  let day: number;

  if (typeof date === 'string') {
    const trimmed = date.trim();
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
    if (match?.[1] && match[2] && match[3]) {
      year = Number.parseInt(match[1], 10);
      monthIndex = Number.parseInt(match[2], 10) - 1;
      day = Number.parseInt(match[3], 10);
      const check = new Date(Date.UTC(year, monthIndex, day));
      if (
        check.getUTCFullYear() !== year ||
        check.getUTCMonth() !== monthIndex ||
        check.getUTCDate() !== day
      ) {
        throw new Error(`Invalid date passed to toJulianDay: ${date}`);
      }
    } else {
      const parsed = new Date(trimmed);
      if (Number.isNaN(parsed.getTime())) {
        throw new Error(`Invalid date passed to toJulianDay: ${date}`);
      }
      const shifted =
        timeZone === 'ist' ? new Date(parsed.getTime() + IST_OFFSET_MS) : parsed;
      year = shifted.getUTCFullYear();
      monthIndex = shifted.getUTCMonth();
      day = shifted.getUTCDate();
    }
  } else {
    if (Number.isNaN(date.getTime())) {
      throw new Error('Invalid Date passed to toJulianDay');
    }
    const shifted =
      timeZone === 'ist' ? new Date(date.getTime() + IST_OFFSET_MS) : date;
    year = shifted.getUTCFullYear();
    monthIndex = shifted.getUTCMonth();
    day = shifted.getUTCDate();
  }

  const startOfYear = Date.UTC(year, 0, 1);
  const targetDay = Date.UTC(year, monthIndex, day);
  return Math.floor((targetDay - startOfYear) / 86_400_000) + 1;
}
