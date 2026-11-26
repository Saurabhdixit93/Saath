import ws from 'k6/ws';
import { check } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import {
  authenticateSession,
  getAuthConfig,
  resolveAuthMode,
} from './lib/auth.js';

const MAX_VUS = Number(__ENV.MAX_VUS || 5000);
const HEARTBEAT_INTERVAL_SEC = Number(__ENV.HEARTBEAT_INTERVAL_SEC || 15);
const HOLD_SECONDS = Number(__ENV.HOLD_SECONDS || 60);

const wsErrorRate = new Rate('ws_error_rate');
const wsReadyMs = new Trend('ws_ready_ms', true);
const wsPingPongMs = new Trend('ws_ping_pong_ms', true);
const wsConnectedTotal = new Counter('ws_connected_total');
const wsPongTotal = new Counter('ws_pong_total');

const stage1 = Math.max(1, Math.round(MAX_VUS * 0.2));
const stage2 = Math.max(1, Math.round(MAX_VUS * 0.6));

export const options = {
  setupTimeout: '60s',
  scenarios: {
    ws_5000_concurrent: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '15s', target: stage1 },
        { duration: '20s', target: stage2 },
        { duration: '25s', target: MAX_VUS },
        { duration: `${HOLD_SECONDS}s`, target: MAX_VUS },
        { duration: '15s', target: 0 },
      ],
      gracefulRampDown: '10s',
      gracefulStop: '10s',
    },
  },
  thresholds: {
    ws_error_rate: ['rate<0.02'],
    ws_ready_ms: ['p(95)<500'],
    ws_ping_pong_ms: ['p(95)<500'],
  },
};

let vuToken = null;

export function setup() {
  const cfg = getAuthConfig(__ENV);
  // Default to fast anonymous auth for 5k WS unless AUTH_MODE=otp is explicitly requested
  const authMode = __ENV.AUTH_MODE ? resolveAuthMode(cfg.apiUrl, cfg) : 'anon';
  return {
    apiUrl: cfg.apiUrl,
    wsUrl: cfg.wsUrl,
    turnstileToken: cfg.turnstileToken,
    testOtpCode: cfg.testOtpCode,
    authMode,
  };
}

export default function (data) {
  if (!vuToken) {
    const session = authenticateSession(data.apiUrl, 100000 + __VU, data.authMode, data);
    if (!session.ok || !session.access) {
      wsErrorRate.add(1);
      return;
    }
    vuToken = session.access;
  }

  const wsEndpoint = `${data.wsUrl}/v1/ws`;
  let readyReceived = false;
  let hadError = false;
  let authSentAt = 0;
  let lastPingAt = 0;

  const res = ws.connect(wsEndpoint, {}, function (socket) {
    socket.on('open', function () {
      authSentAt = Date.now();
      socket.send(JSON.stringify({ type: 'auth', token: vuToken }));
    });

    socket.on('message', function (raw) {
      let msg = null;
      try {
        msg = JSON.parse(raw);
      } catch (_) {
        return;
      }
      if (!msg || typeof msg !== 'object') {
        return;
      }
      if (msg.type === 'ready') {
        readyReceived = true;
        wsConnectedTotal.add(1);
        if (authSentAt > 0) {
          wsReadyMs.add(Date.now() - authSentAt);
        }
        lastPingAt = Date.now();
        socket.send(JSON.stringify({ type: 'ping' }));

        socket.setInterval(function () {
          lastPingAt = Date.now();
          socket.send(JSON.stringify({ type: 'ping' }));
        }, HEARTBEAT_INTERVAL_SEC * 1000);
      } else if (msg.type === 'pong') {
        wsPongTotal.add(1);
        if (lastPingAt > 0) {
          wsPingPongMs.add(Date.now() - lastPingAt);
          lastPingAt = 0;
        }
      }
    });

    socket.on('error', function () {
      hadError = true;
    });

    socket.setTimeout(function () {
      socket.close();
    }, HOLD_SECONDS * 1000);
  });

  const ok = check(res, {
    'ws handshake 101': (r) => Boolean(r && r.status === 101),
    'ws auth ready received': () => readyReceived,
    'ws no socket error': () => !hadError,
  });

  wsErrorRate.add(ok ? 0 : 1);
}
