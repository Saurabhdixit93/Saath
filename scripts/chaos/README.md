# Saath Chaos Verification Suite (`scripts/chaos/`)

Prompt 16 chaos resilience verification scripts for Saath.

## Scenarios

1. **Rail Provider Failover & Redis Circuit Breaker (`verify_provider_failover.sh`)**
   - Uses `mock_rail_providers.py` (genuine HTTP mocks for Rail Provider A and Rail Provider B matching `_HttpRailAdapter` in `apps/api/src/saath_api/providers/rail/adapters.py`).
   - Verifies Provider A serves normal requests -> injects `500` (or `timeout`) via `/__chaos/fail` on Provider A -> verifies 5 uncached PNRs succeed via Provider B -> asserts Redis key `cb:rail:rail_provider_a:open` is set -> verifies a 6th PNR routes directly to Provider B without calling Provider A.
   - **Required API configuration**: API must run with `RAIL_PROVIDER_MODE=live`, `PROVIDER_RAIL_A_BASE_URL=http://127.0.0.1:19101`, `PROVIDER_RAIL_B_BASE_URL=http://127.0.0.1:19102` (or `host.docker.internal` when API is inside Docker).

2. **Redis Restart & WebSocket Reconnect (`verify_redis_ws_reconnect.sh`)**
   - Opens an authenticated `/v1/ws` WebSocket (`{"type":"auth","token":...}` -> `{"type":"ready"}`).
   - Restarts Redis (`docker compose restart redis` or custom `REDIS_RESTART_CMD`).
   - Polls `/readyz` back to `200`, reconnects a fresh `/v1/ws` client (`ready`), triggers `PUT /v1/parties/{pid}/goal`, and asserts `match.updated` arrives on the reconnected WebSocket.
   - Note: `realtime/ws.py:_pump_redis` exits on `redis.exceptions.ConnectionError`, so client-side reconnect + re-auth after Redis recovery is the expected contract.

3. **Arq Worker Crash & Outbox Idempotency (`verify_worker_crash_outbox.sh`)**
   - Records baseline outbox metrics from `GET /v1/admin/providers/health` (or Postgres `notifications_outbox` fallback).
   - Triggers an outbox notification (`PUT /v1/parties/{pid}/goal`), sends `SIGKILL` to the Arq worker (`docker compose kill -s SIGKILL worker` or `WORKER_KILL_CMD`), triggers another outbox event while worker is down, restarts the worker (`docker compose start worker` or `WORKER_START_CMD`), and polls until `outbox.queued == 0` with `outbox.sent` advancing cleanly and zero duplicate `idempotency_key` deliveries.

## Safety Guards

All scripts enforce a preflight guard refusing to run when `ENV=production` (or `E2E_ENV=production`) or when `API_URL` matches a production hostname, unless `ALLOW_PROD_CHAOS=1` is explicitly set.

## Modes & Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `API_URL` | `http://127.0.0.1:8000` | Saath API HTTP base URL |
| `WS_URL` | `ws://127.0.0.1:8000` | Saath API WS base URL |
| `ENV` / `E2E_ENV` | `development` | Environment guard (must not be `production`) |
| `REDIS_URL` | `redis://127.0.0.1:6379/0` | Redis URL for `cb:rail:*` inspection |
| `START_MOCK_SERVERS` | `1` | Set `0` in `verify_provider_failover.sh` if `mock_rail_providers.py` is already running externally |
| `FAIL_MODE` | `500` | Failure mode injected into Provider A (`500` or `timeout`) |
| `REDIS_RESTART_CMD` | `docker compose restart redis` | Override for local non-Docker Redis restart |
| `WORKER_KILL_CMD` | `docker compose kill -s SIGKILL worker` | Override for local Arq worker SIGKILL |
| `WORKER_START_CMD` | `docker compose start worker` | Override for local Arq worker restart |
| `ADMIN_EMAIL` | `ops@saath.test` | Allowlisted admin email for `POST /v1/admin/auth/session` |
| `AUTH_TOKEN` | _(auto)_ | Optional pre-minted user JWT (used if OTP is not static/echoed in dev) |
| `E2E_TEST_OTP` | `123456` | Test OTP code if enabled on target API |

## Quick Start

```bash
# 1. Start mock rail providers (if API is in Docker, bind 0.0.0.0 and point API to http://host.docker.internal:19101/19102)
python3 scripts/chaos/mock_rail_providers.py --host 0.0.0.0 --port-a 19101 --port-b 19102

# 2. Run Chaos 1 (against live-mode API)
START_MOCK_SERVERS=0 ./scripts/chaos/verify_provider_failover.sh

# 3. Run Chaos 2 & 3 (with Docker Compose stack up)
./scripts/chaos/verify_redis_ws_reconnect.sh
./scripts/chaos/verify_worker_crash_outbox.sh
```
