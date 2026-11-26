# Saath k6 Load Test Suite (`load/k6/`)

Load testing suite for Prompt 16 non-functional & SLO verification using [Grafana k6](https://k6.io/).

## Scenarios & SLO Thresholds

| Script | Workload | Key SLO Thresholds |
|---|---|---|
| `verify_200rps.js` | `constant-arrival-rate` at **200 req/s** for **60s** (12,000 reqs; 70% Redis cache hits / 30% unique synthetic PNRs via `FakeRailProvider`) | `http_req_failed < 1%`, `http_req_duration{cache:hit} p95 < 300ms`, `http_req_duration p95 < 4000ms` |
| `ws_5000_concurrent.js` | `ramping-vus` scaling up to **5,000 concurrent** `/v1/ws` WebSocket connections (`auth` -> `ready` -> periodic `ping`/`pong`) | `ws_error_rate < 2%`, `ws_ready_ms p95 < 500ms`, `ws_ping_pong_ms p95 < 500ms` |
| `match_recompute_storm.js` | **200 active passengers** on train `12951` bursting `PUT /v1/parties/{id}/goal` + `GET /v1/parties/{id}/matches` | `http_req_failed < 1%`, `http_req_duration p95 < 2000ms`, `match_version` strictly non-decreasing |

## Prerequisites & Host Tuning

1. **Install k6** (or have Docker running for automatic `grafana/k6` fallback):
   - macOS: `brew install k6`
   - Linux: see <https://grafana.com/docs/k6/latest/set-up/install-k6/>
2. **Raise open file descriptors** before running 5,000 concurrent WebSockets (`ws_5000_concurrent.js`):
   ```bash
   ulimit -n 16384
   ```
   On macOS, if `ulimit -n 16384` fails, raise system limits (`sudo launchctl limit maxfiles 65536 200000`) or pass `MAX_VUS=1000` for smaller local smoke runs.
3. **Run API with multiple Uvicorn workers** (avoid single-worker event-loop saturation at 200 req/s and 5,000 WS):
   ```bash
   uvicorn saath_api.main:app --host 0.0.0.0 --port 8000 --workers 4
   ```
4. **Why `X-Forwarded-For` multiplexing is used (`TRUSTED_PROXIES=127.0.0.1,::1`)**:
   - `apps/api/config/rate_limits.yaml` enforces `verify: 10/min/IP`, `verify: 30/day/user`, `auth.anonymous_per_ip_per_minute: 20`, and `auth.otp_start_per_ip_per_minute: 5`.
   - `Settings.trusted_proxies` defaults to `127.0.0.1,::1`, and `auth/router.py:_client_ip` parses `X-Forwarded-For` from right to left when the TCP peer is a trusted proxy.
   - `lib/auth.js` sends distinct `10.x.y.z` `X-Forwarded-For` headers per VU/iteration and `verify_200rps.js` pre-mints `500` distinct sessions in `setup()` (`500 * 29 = 14,500 > 12,000` calls), exercising genuine Redis sliding-window rate limits, Postgres writes, and cache/provider paths without tripping single-IP `429` self-DoS.
   - Note: Each user in `verify_200rps.js` owns its own warmed cached PNR (`7100000000 + idx`) because `journeys/service.py` returns `409 pnr_already_claimed` if a different user verifies an already-claimed PNR.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `API_URL` | `http://127.0.0.1:8000` | Base HTTP URL for `saath_api` |
| `WS_URL` | `ws://127.0.0.1:8000` | Base WebSocket URL for `saath_api` (`/v1/ws` appended automatically) |
| `ENV` / `E2E_ENV` | `development` | Must NOT be `production` (preflight aborts if production unless `ALLOW_PROD_LOAD_TEST=1`) |
| `AUTH_MODE` | `auto` | `auto` (probes OTP, falls back to anonymous JWT if OTP code isn't echoed), `otp`, or `anon` |
| `E2E_TEST_OTP` | `123456` | Test OTP code used when `AUTH_MODE=otp` or `auto` probe |
| `TURNSTILE_TEST_TOKEN` | `fake-turnstile-ok` | Turnstile token sent to `/v1/auth/anonymous` and `/v1/auth/otp/start` |
| `RATE` | `200` | Target req/s for `verify_200rps.js` |
| `DURATION` | `60s` | Steady-state duration for `verify_200rps.js` |
| `PREMINT_USERS` | `500` | Number of pre-minted sessions/warmed PNRs in `verify_200rps.js` |
| `MAX_VUS` | `5000` | Peak concurrent WS connections in `ws_5000_concurrent.js` |
| `PASSENGER_COUNT` | `200` | Active passengers created on train `12951` in `match_recompute_storm.js` |

## Usage

```bash
# Run all 3 scenarios sequentially
./load/k6/run_all.sh --all

# Run individual scenarios
./load/k6/run_all.sh --verify
./load/k6/run_all.sh --ws
./load/k6/run_all.sh --storm

# Scaled-down local smoke test
MAX_VUS=250 RATE=50 DURATION=15s PASSENGER_COUNT=40 ./load/k6/run_all.sh --all
```

### Docker `grafana/k6` Fallback

If `k6` is not installed locally, `run_all.sh` automatically falls back to `docker run --rm -i grafana/k6` (using `--network host` on Linux, or `host.docker.internal` mapping on macOS/Docker Desktop).
