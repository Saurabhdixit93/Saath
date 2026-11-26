import http from 'k6/http';
import { check } from 'k6';

export function xffForIndex(index) {
  const n = Math.max(1, Math.floor(Math.abs(index)) + 1);
  const b = (n >> 16) & 255;
  const c = (n >> 8) & 255;
  const d = (n % 250) + 1;
  return `10.${b}.${c}.${d}`;
}

export function phoneForIndex(index) {
  const n = Math.floor(Math.abs(index)) % 900000000;
  const leading = ['9', '8', '7', '6'][Math.floor(Math.abs(index) / 900000000) % 4];
  return `${leading}${String(100000000 + n).padStart(9, '0')}`;
}

const RESERVED_PNRS = new Set([
  '0000000000',
  '1111111111',
  '9999999991',
  '9999999992',
  '9999999999',
  '2415678971',
  '2415678972',
  '2415678981',
  '4111111111',
  '4222222222',
  '4333333333',
  '4512890341',
]);

/**
 * Generates a 10-digit synthetic PNR that FakeRailProvider maps deterministically
 * onto train 12951 (Mumbai Tejas Rajdhani Express, 3A).
 */
export function syntheticPnrForIndex(index, prefix = 7) {
  const safePrefix = Math.min(8, Math.max(6, Math.floor(prefix)));
  let offset = Math.floor(Math.abs(index)) % 999999999;
  for (let tries = 0; tries < 5; tries += 1) {
    const candidate = `${safePrefix}${String(offset).padStart(9, '0')}`;
    if (!RESERVED_PNRS.has(candidate)) {
      return candidate;
    }
    offset = (offset + 1) % 999999999;
  }
  return `${safePrefix}000000001`;
}

export function buildHeaders(xffIp, token = null, extra = {}) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, application/problem+json',
    'X-Forwarded-For': xffIp,
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const keys = Object.keys(extra);
  for (let i = 0; i < keys.length; i += 1) {
    headers[keys[i]] = extra[keys[i]];
  }
  return headers;
}

export function getAuthConfig(env = __ENV) {
  return {
    apiUrl: (env.API_URL || 'http://127.0.0.1:8000').replace(/\/+$/, ''),
    wsUrl: (env.WS_URL || 'ws://127.0.0.1:8000').replace(/\/+$/, ''),
    turnstileToken: env.TURNSTILE_TEST_TOKEN || 'fake-turnstile-ok',
    testOtpCode: env.E2E_TEST_OTP || '123456',
    authMode: (env.AUTH_MODE || 'auto').toLowerCase(),
  };
}

export function issueAnonymousToken(apiUrl, xffIp, turnstileToken = 'fake-turnstile-ok') {
  const res = http.post(
    `${apiUrl}/v1/auth/anonymous`,
    JSON.stringify({ turnstile: turnstileToken }),
    {
      headers: buildHeaders(xffIp),
      tags: { endpoint: 'auth_anonymous' },
    },
  );
  let body = null;
  try {
    body = res.json();
  } catch (_) {
    body = null;
  }
  const ok = check(res, {
    'anon auth status 200': (r) => r.status === 200,
    'anon auth has access token': () => Boolean(body && typeof body.access === 'string' && body.access.length > 0),
  });
  return {
    ok,
    status: res.status,
    access: body && body.access ? body.access : null,
    kind: 'anon',
    xffIp,
    raw: res.body,
  };
}

export function startOtp(
  apiUrl,
  phone,
  xffIp,
  channel = 'whatsapp',
  turnstileToken = 'fake-turnstile-ok',
  locale = 'en',
) {
  const res = http.post(
    `${apiUrl}/v1/auth/otp/start`,
    JSON.stringify({
      phone,
      channel,
      turnstile: turnstileToken,
      locale,
    }),
    {
      headers: buildHeaders(xffIp),
      tags: { endpoint: 'auth_otp_start' },
    },
  );
  let body = null;
  try {
    body = res.json();
  } catch (_) {
    body = null;
  }
  const headerOtp =
    res.headers['X-Dev-Otp'] ||
    res.headers['x-dev-otp'] ||
    res.headers['X-Sandbox-Otp'] ||
    res.headers['x-sandbox-otp'] ||
    null;
  const resolvedOtp = (body && (body.dev_otp || body.otp)) || headerOtp || null;
  return {
    ok: res.status === 200,
    status: res.status,
    requestId: body && body.request_id ? body.request_id : null,
    resolvedOtp,
    body,
    raw: res.body,
  };
}

export function verifyOtp(apiUrl, requestId, code, xffIp, anonToken = null) {
  const res = http.post(
    `${apiUrl}/v1/auth/otp/verify`,
    JSON.stringify({
      request_id: requestId,
      code,
    }),
    {
      headers: buildHeaders(xffIp, anonToken),
      tags: { endpoint: 'auth_otp_verify' },
    },
  );
  let body = null;
  try {
    body = res.json();
  } catch (_) {
    body = null;
  }
  return {
    ok: res.status === 200 && Boolean(body && body.access),
    status: res.status,
    access: body && body.access ? body.access : null,
    refresh: body && body.refresh ? body.refresh : null,
    user: body && body.user ? body.user : null,
    body,
    raw: res.body,
  };
}

export function loginWithOtp(
  apiUrl,
  phone,
  xffIp,
  fallbackOtpCode = '123456',
  anonToken = null,
  turnstileToken = 'fake-turnstile-ok',
) {
  const started = startOtp(apiUrl, phone, xffIp, 'whatsapp', turnstileToken, 'en');
  if (!started.ok || !started.requestId) {
    return {
      ok: false,
      status: started.status,
      access: null,
      refresh: null,
      user: null,
      kind: 'user',
      xffIp,
      raw: started.raw,
    };
  }
  const code = started.resolvedOtp || fallbackOtpCode;
  const verified = verifyOtp(apiUrl, started.requestId, code, xffIp, anonToken);
  return {
    ok: verified.ok,
    status: verified.status,
    access: verified.access,
    refresh: verified.refresh,
    user: verified.user,
    kind: 'user',
    xffIp,
    raw: verified.raw,
  };
}

export function resolveAuthMode(apiUrl, config) {
  if (config.authMode === 'otp' || config.authMode === 'anon') {
    return config.authMode;
  }
  const probe = loginWithOtp(
    apiUrl,
    phoneForIndex(9900001),
    xffForIndex(9900001),
    config.testOtpCode,
    null,
    config.turnstileToken,
  );
  if (probe.ok && probe.access) {
    return 'otp';
  }
  return 'anon';
}

export function authenticateSession(apiUrl, index, authMode, config) {
  const xffIp = xffForIndex(index);
  if (authMode === 'otp') {
    const phone = phoneForIndex(index);
    return loginWithOtp(
      apiUrl,
      phone,
      xffIp,
      config.testOtpCode,
      null,
      config.turnstileToken,
    );
  }
  return issueAnonymousToken(apiUrl, xffIp, config.turnstileToken);
}
