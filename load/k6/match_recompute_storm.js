import http from 'k6/http';
import exec from 'k6/execution';
import { check } from 'k6';
import { Rate } from 'k6/metrics';
import {
  authenticateSession,
  buildHeaders,
  getAuthConfig,
  resolveAuthMode,
  syntheticPnrForIndex,
  xffForIndex,
} from './lib/auth.js';

const PASSENGER_COUNT = Number(__ENV.PASSENGER_COUNT || 200);
const PEAK_RATE = Number(__ENV.PEAK_RATE || 50);
const HOLD_DURATION = __ENV.DURATION || '30s';
const BATCH_SIZE = 40;

const GOAL_TYPES = ['lower', 'upper', 'open_to_help'];

const matchVersionMonotonic = new Rate('match_version_monotonic');
const stormSuccessRate = new Rate('storm_success_rate');

export const options = {
  setupTimeout: '240s',
  scenarios: {
    match_recompute_storm: {
      executor: 'ramping-arrival-rate',
      startRate: 10,
      timeUnit: '1s',
      preAllocatedVUs: 60,
      maxVUs: 250,
      stages: [
        { duration: '15s', target: PEAK_RATE },
        { duration: HOLD_DURATION, target: PEAK_RATE },
        { duration: '10s', target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<2000'],
    match_version_monotonic: ['rate==1'],
    storm_success_rate: ['rate>0.99'],
  },
};

export function setup() {
  const cfg = getAuthConfig(__ENV);
  const authMode = resolveAuthMode(cfg.apiUrl, cfg);
  const runOffset = (Date.now() % 1000000) * 100;
  const passengers = [];

  if (authMode === 'otp') {
    for (let i = 0; i < PASSENGER_COUNT; i += 1) {
      const session = authenticateSession(cfg.apiUrl, 200000 + i, 'otp', cfg);
      if (!session.ok || !session.access) {
        throw new Error(`Storm OTP auth failed at ${i}: ${session.status} ${session.raw}`);
      }
      passengers.push({
        token: session.access,
        xffIp: xffForIndex(200000 + i),
        pnr: syntheticPnrForIndex(runOffset + i, 7),
      });
    }
  } else {
    for (let start = 0; start < PASSENGER_COUNT; start += BATCH_SIZE) {
      const reqs = [];
      const end = Math.min(PASSENGER_COUNT, start + BATCH_SIZE);
      for (let i = start; i < end; i += 1) {
        const xffIp = xffForIndex(200000 + i);
        reqs.push({
          method: 'POST',
          url: `${cfg.apiUrl}/v1/auth/anonymous`,
          body: JSON.stringify({ turnstile: cfg.turnstileToken }),
          params: {
            headers: buildHeaders(xffIp),
            tags: { endpoint: 'storm_setup_auth' },
          },
        });
      }
      const resps = http.batch(reqs);
      for (let j = 0; j < resps.length; j += 1) {
        const idx = start + j;
        if (resps[j].status !== 200) {
          throw new Error(`Storm setup auth failed (${resps[j].status}): ${resps[j].body}`);
        }
        passengers.push({
          token: resps[j].json().access,
          xffIp: xffForIndex(200000 + idx),
          pnr: syntheticPnrForIndex(runOffset + idx, 7),
        });
      }
    }
  }

  let journeyId = null;
  for (let start = 0; start < passengers.length; start += BATCH_SIZE) {
    const verifyReqs = [];
    const end = Math.min(passengers.length, start + BATCH_SIZE);
    for (let i = start; i < end; i += 1) {
      verifyReqs.push({
        method: 'POST',
        url: `${cfg.apiUrl}/v1/journeys/verify`,
        body: JSON.stringify({ mode: 'train', pnr: passengers[i].pnr }),
        params: {
          headers: buildHeaders(passengers[i].xffIp, passengers[i].token),
          tags: { endpoint: 'storm_setup_verify' },
        },
      });
    }
    const verifyResps = http.batch(verifyReqs);
    for (let j = 0; j < verifyResps.length; j += 1) {
      const idx = start + j;
      const r = verifyResps[j];
      if (r.status !== 200) {
        throw new Error(`Storm setup verify failed (${r.status}): ${r.body}`);
      }
      const body = r.json();
      if (!journeyId) {
        journeyId = body.journey.id;
      }
      passengers[idx].partyId = body.party_id;
      passengers[idx].seatHolderIds = (body.seat_holders || []).map((sh) => sh.id);
      if (!passengers[idx].partyId || passengers[idx].seatHolderIds.length === 0) {
        throw new Error(`Storm setup verify missing party_id/seat_holders: ${r.body}`);
      }
    }
  }

  return {
    apiUrl: cfg.apiUrl,
    journeyId,
    passengers,
  };
}

let lastObservedMatchVersion = 0;

export default function (data) {
  const iterIdx = exec.scenario.iterationInTest;
  const pax = data.passengers[iterIdx % data.passengers.length];
  const goalType = GOAL_TYPES[iterIdx % GOAL_TYPES.length];

  const putRes = http.put(
    `${data.apiUrl}/v1/parties/${pax.partyId}/goal`,
    JSON.stringify({
      goal_type: goalType,
      movers: pax.seatHolderIds,
      preferred_seats: [],
      constraints: {
        women_only: false,
        no_middle: false,
        same_coach_only: false,
        verified_only: false,
      },
    }),
    {
      headers: buildHeaders(pax.xffIp, pax.token),
      tags: { endpoint: 'parties_put_goal' },
    },
  );

  let putBody = null;
  try {
    putBody = putRes.json();
  } catch (_) {
    putBody = null;
  }

  const getRes = http.get(
    `${data.apiUrl}/v1/parties/${pax.partyId}/matches`,
    {
      headers: buildHeaders(pax.xffIp, pax.token),
      tags: { endpoint: 'parties_get_matches' },
    },
  );

  let getBody = null;
  try {
    getBody = getRes.json();
  } catch (_) {
    getBody = null;
  }

  const putVersion = putBody && typeof putBody.match_version === 'number' ? putBody.match_version : -1;
  const getVersion = getBody && typeof getBody.match_version === 'number' ? getBody.match_version : -1;

  const isMonotonic =
    putVersion >= 1 &&
    getVersion >= putVersion &&
    getVersion >= lastObservedMatchVersion;

  if (getVersion > lastObservedMatchVersion) {
    lastObservedMatchVersion = getVersion;
  }

  matchVersionMonotonic.add(isMonotonic ? 1 : 0);

  const ok = check(
    { putRes, getRes },
    {
      'PUT /goal status 200': () => putRes.status === 200,
      'GET /matches status 200': () => getRes.status === 200,
      'GET /matches has items array': () => Boolean(getBody && Array.isArray(getBody.items)),
      'match_version non-decreasing': () => isMonotonic,
    },
  );
  stormSuccessRate.add(ok);
}
