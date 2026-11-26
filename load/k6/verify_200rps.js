import http from 'k6/http';
import exec from 'k6/execution';
import { check } from 'k6';
import { Rate, Trend } from 'k6/metrics';
import {
  authenticateSession,
  buildHeaders,
  getAuthConfig,
  phoneForIndex,
  resolveAuthMode,
  syntheticPnrForIndex,
  xffForIndex,
} from './lib/auth.js';

function parseDurationSeconds(raw) {
  const s = String(raw || '60s').trim().toLowerCase();
  if (s.endsWith('ms')) return Number.parseFloat(s) / 1000;
  if (s.endsWith('s')) return Number.parseFloat(s);
  if (s.endsWith('m')) return Number.parseFloat(s) * 60;
  if (s.endsWith('h')) return Number.parseFloat(s) * 3600;
  return Number.parseFloat(s) || 60;
}

const RATE = Number(__ENV.RATE || 200);
const DURATION = __ENV.DURATION || '60s';
const PREMINT_USERS = Number(__ENV.PREMINT_USERS || 500);
const PRE_ALLOCATED_VUS = Number(__ENV.PRE_ALLOCATED_VUS || 150);
const MAX_VUS = Number(__ENV.MAX_VUS || 500);
const CACHE_HIT_RATIO = Number(__ENV.CACHE_HIT_RATIO || 0.7);
const BATCH_SIZE = 50;

const verifySuccessRate = new Rate('verify_success_rate');
const cacheHitLatency = new Trend('verify_cache_hit_ms', true);
const cacheMissLatency = new Trend('verify_cache_miss_ms', true);

export const options = {
  setupTimeout: '180s',
  scenarios: {
    verify_200rps: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: PRE_ALLOCATED_VUS,
      maxVUs: MAX_VUS,
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{cache:hit}': ['p(95)<300'],
    http_req_duration: ['p(95)<4000'],
    verify_success_rate: ['rate>0.99'],
  },
};

export function setup() {
  const cfg = getAuthConfig(__ENV);
  const authMode = resolveAuthMode(cfg.apiUrl, cfg);
  const durationSec = parseDurationSeconds(DURATION);
  const estCallsPerUser = (RATE * durationSec) / Math.max(1, PREMINT_USERS) + 1;
  if (estCallsPerUser > 30) {
    console.warn(
      `WARNING: Estimated ${estCallsPerUser.toFixed(1)} verify calls/user exceeds verify.per_user_per_day (30) in rate_limits.yaml. Increase PREMINT_USERS to >= ${Math.ceil((RATE * durationSec) / 29)}.`,
    );
  }

  const runOffset = (Date.now() % 1000000) * 100;
  const users = [];

  if (authMode === 'otp') {
    for (let start = 0; start < PREMINT_USERS; start += BATCH_SIZE) {
      const count = Math.min(BATCH_SIZE, PREMINT_USERS - start);
      const startReqs = [];
      for (let j = 0; j < count; j += 1) {
        const idx = start + j;
        startReqs.push({
          method: 'POST',
          url: `${cfg.apiUrl}/v1/auth/otp/start`,
          body: JSON.stringify({
            phone: phoneForIndex(1000 + idx),
            channel: 'whatsapp',
            turnstile: cfg.turnstileToken,
            locale: 'en',
          }),
          params: {
            headers: buildHeaders(xffForIndex(1000 + idx)),
            tags: { endpoint: 'setup_otp_start' },
          },
        });
      }
      const startResps = http.batch(startReqs);
      const verifyReqs = [];
      for (let j = 0; j < startResps.length; j += 1) {
        const idx = start + j;
        const sr = startResps[j];
        if (sr.status !== 200) {
          throw new Error(`Failed OTP start at index ${idx}: status=${sr.status} body=${sr.body}`);
        }
        const sBody = sr.json();
        const hdrOtp =
          sr.headers['X-Dev-Otp'] ||
          sr.headers['x-dev-otp'] ||
          sr.headers['X-Sandbox-Otp'] ||
          sr.headers['x-sandbox-otp'];
        const code = (sBody && (sBody.dev_otp || sBody.otp)) || hdrOtp || cfg.testOtpCode;
        verifyReqs.push({
          method: 'POST',
          url: `${cfg.apiUrl}/v1/auth/otp/verify`,
          body: JSON.stringify({ request_id: sBody.request_id, code }),
          params: {
            headers: buildHeaders(xffForIndex(1000 + idx)),
            tags: { endpoint: 'setup_otp_verify' },
          },
        });
      }
      const verifyResps = http.batch(verifyReqs);
      for (let j = 0; j < verifyResps.length; j += 1) {
        const idx = start + j;
        const vr = verifyResps[j];
        if (vr.status !== 200) {
          const fallback = authenticateSession(cfg.apiUrl, 1000 + idx, 'otp', cfg);
          if (!fallback.ok || !fallback.access) {
            throw new Error(`Failed OTP verify at index ${idx}: status=${vr.status} body=${vr.body}`);
          }
          users.push({
            token: fallback.access,
            cachedPnr: syntheticPnrForIndex(runOffset + idx, 7),
          });
          continue;
        }
        users.push({
          token: vr.json().access,
          cachedPnr: syntheticPnrForIndex(runOffset + idx, 7),
        });
      }
    }
  } else {
    for (let start = 0; start < PREMINT_USERS; start += BATCH_SIZE) {
      const batchReqs = [];
      const count = Math.min(BATCH_SIZE, PREMINT_USERS - start);
      for (let j = 0; j < count; j += 1) {
        const idx = start + j;
        batchReqs.push({
          method: 'POST',
          url: `${cfg.apiUrl}/v1/auth/anonymous`,
          body: JSON.stringify({ turnstile: cfg.turnstileToken }),
          params: {
            headers: buildHeaders(xffForIndex(1000 + idx)),
            tags: { endpoint: 'setup_auth' },
          },
        });
      }
      const responses = http.batch(batchReqs);
      for (let j = 0; j < responses.length; j += 1) {
        const r = responses[j];
        if (r.status !== 200) {
          throw new Error(`Setup anonymous auth failed (${r.status}): ${r.body}`);
        }
        const parsed = r.json();
        users.push({
          token: parsed.access,
          cachedPnr: syntheticPnrForIndex(runOffset + start + j, 7),
        });
      }
    }
  }

  // Warm each user's dedicated PNR in Redis cache + Postgres booking ownership
  // (avoids 409 pnr_already_claimed while staying within 30/day/user verify cap)
  for (let start = 0; start < users.length; start += BATCH_SIZE) {
    const warmReqs = [];
    const end = Math.min(users.length, start + BATCH_SIZE);
    for (let idx = start; idx < end; idx += 1) {
      warmReqs.push({
        method: 'POST',
        url: `${cfg.apiUrl}/v1/journeys/verify`,
        body: JSON.stringify({ mode: 'train', pnr: users[idx].cachedPnr }),
        params: {
          headers: buildHeaders(xffForIndex(5000 + idx), users[idx].token),
          tags: { endpoint: 'setup_warm_pnr' },
        },
      });
    }
    const warmRes = http.batch(warmReqs);
    for (let j = 0; j < warmRes.length; j += 1) {
      if (warmRes[j].status !== 200) {
        throw new Error(`Setup warmup verify failed (${warmRes[j].status}): ${warmRes[j].body}`);
      }
    }
  }

  return {
    apiUrl: cfg.apiUrl,
    authMode,
    runOffset,
    users,
  };
}

export default function (data) {
  const iterIdx = exec.scenario.iterationInTest;
  const user = data.users[iterIdx % data.users.length];
  // Rotate X-Forwarded-For across 3,000+ virtual client IPs (< 10/min/IP limit)
  const xffIp = xffForIndex(20000 + (iterIdx % 4000));

  const isCacheHit = (iterIdx % 100) < Math.round(CACHE_HIT_RATIO * 100);
  const pnr = isCacheHit
    ? user.cachedPnr
    : syntheticPnrForIndex(data.runOffset + PREMINT_USERS + iterIdx + 1, 8);

  const res = http.post(
    `${data.apiUrl}/v1/journeys/verify`,
    JSON.stringify({ mode: 'train', pnr }),
    {
      headers: buildHeaders(xffIp, user.token),
      tags: {
        endpoint: 'journeys_verify',
        cache: isCacheHit ? 'hit' : 'miss',
      },
    },
  );

  let parsed = null;
  try {
    parsed = res.json();
  } catch (_) {
    parsed = null;
  }

  const ok = check(res, {
    'verify status is 200': (r) => r.status === 200,
    'verify returns party_id': () => Boolean(parsed && parsed.party_id),
    'verify returns journey': () => Boolean(parsed && parsed.journey && parsed.journey.service_no),
  });

  verifySuccessRate.add(ok);
  if (isCacheHit) {
    cacheHitLatency.add(res.timings.duration);
  } else {
    cacheMissLatency.add(res.timings.duration);
  }
}
