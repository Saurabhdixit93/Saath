#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

API_URL="${API_URL:-http://127.0.0.1:8000}"
ENV_MODE="${ENV:-${E2E_ENV:-development}}"
MOCK_HOST="${MOCK_HOST:-127.0.0.1}"
PORT_A="${PORT_A:-19101}"
PORT_B="${PORT_B:-19102}"
PROVIDER_A_URL="${PROVIDER_A_URL:-http://${MOCK_HOST}:${PORT_A}}"
PROVIDER_B_URL="${PROVIDER_B_URL:-http://${MOCK_HOST}:${PORT_B}}"
START_MOCK_SERVERS="${START_MOCK_SERVERS:-1}"
FAIL_MODE="${FAIL_MODE:-500}"
FAIL_DELAY_MS="${FAIL_DELAY_MS:-5000}"
REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379/0}"
TURNSTILE_TEST_TOKEN="${TURNSTILE_TEST_TOKEN:-fake-turnstile-ok}"
CB_KEY="${CB_KEY:-cb:rail:rail_provider_a:open}"

# 1. Production safety guard
if [[ "${ALLOW_PROD_CHAOS:-0}" != "1" ]]; then
  lower_env="$(printf '%s' "$ENV_MODE" | tr '[:upper:]' '[:lower:]')"
  if [[ "$lower_env" == "production" || "$lower_env" == "prod" ]]; then
    echo "ERROR: Refusing to run chaos verification when ENV=${ENV_MODE}." >&2
    exit 1
  fi
  if [[ "$API_URL" =~ https://.*saath\.(in|com|app) ]]; then
    echo "ERROR: API_URL ($API_URL) appears to be production. Refusing chaos test without ALLOW_PROD_CHAOS=1." >&2
    exit 1
  fi
fi

# 2. Tool preflight
for bin in python3 curl; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "ERROR: Required tool '$bin' is not installed or not in PATH." >&2
    exit 1
  fi
done

MOCK_PID=""
cleanup() {
  set +e
  curl -sf -X POST "${PROVIDER_A_URL%/}/__chaos/fail?mode=ok" >/dev/null 2>&1 || true
  if [[ -n "$MOCK_PID" ]] && kill -0 "$MOCK_PID" >/dev/null 2>&1; then
    kill "$MOCK_PID" >/dev/null 2>&1 || true
    wait "$MOCK_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# 3. Check /readyz
ready_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "${API_URL%/}/readyz" || true)"
if [[ "$ready_code" != "200" ]]; then
  echo "ERROR: Preflight failed: GET ${API_URL%/}/readyz returned HTTP ${ready_code:-000} (expected 200)." >&2
  echo "Start Saath API with RAIL_PROVIDER_MODE=live, PROVIDER_RAIL_A_BASE_URL=${PROVIDER_A_URL}, PROVIDER_RAIL_B_BASE_URL=${PROVIDER_B_URL}." >&2
  exit 1
fi

# 4. Start or verify mock rail providers
if [[ "$START_MOCK_SERVERS" == "1" ]]; then
  python3 "${SCRIPT_DIR}/mock_rail_providers.py" \
    --host "$MOCK_HOST" \
    --port-a "$PORT_A" \
    --port-b "$PORT_B" >/dev/null 2>&1 &
  MOCK_PID=$!

  for _ in $(seq 1 30); do
    if curl -sf "${PROVIDER_A_URL%/}/healthz" >/dev/null 2>&1 && curl -sf "${PROVIDER_B_URL%/}/healthz" >/dev/null 2>&1; then
      break
    fi
    sleep 0.2
  done
fi

if ! curl -sf "${PROVIDER_A_URL%/}/healthz" >/dev/null 2>&1 || ! curl -sf "${PROVIDER_B_URL%/}/healthz" >/dev/null 2>&1; then
  echo "ERROR: Mock rail providers unreachable at ${PROVIDER_A_URL} / ${PROVIDER_B_URL}." >&2
  exit 1
fi

curl -sf -X POST "${PROVIDER_A_URL%/}/__chaos/reset" >/dev/null
curl -sf -X POST "${PROVIDER_B_URL%/}/__chaos/reset" >/dev/null

# 5. Mint anonymous session token (works on /v1/journeys/verify)
auth_resp="$(curl -sf -X POST "${API_URL%/}/v1/auth/anonymous" \
  -H "Content-Type: application/json" \
  -H "X-Forwarded-For: 10.88.1.1" \
  -d "{\"turnstile\":\"${TURNSTILE_TEST_TOKEN}\"}")"

TOKEN="$(python3 -c 'import json, sys; print(json.load(sys.stdin)["access"])' <<< "$auth_resp")"
RUN_SEED="$(python3 -c 'import time; print(int(time.time() * 1000) % 100000000)')"

json_field() {
  local field="$1"
  python3 -c "import json, sys; data = json.load(sys.stdin); print(data['$field'])"
}

verify_pnr() {
  local pnr="$1"
  local xff="$2"
  local out_file
  out_file="$(mktemp)"
  local code
  code="$(curl -s -o "$out_file" -w '%{http_code}' -X POST "${API_URL%/}/v1/journeys/verify" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Content-Type: application/json" \
    -H "X-Forwarded-For: ${xff}" \
    -d "{\"mode\":\"train\",\"pnr\":\"${pnr}\"}")"
  if [[ "$code" != "200" ]]; then
    echo "ERROR: POST /v1/journeys/verify for PNR=${pnr} returned HTTP ${code}: $(cat "$out_file")" >&2
    rm -f "$out_file"
    return 1
  fi
  rm -f "$out_file"
  return 0
}

echo "Step 1: Verifying normal Provider A serving..."
PNR_BASE="$(printf '6%09d' "$((RUN_SEED + 1))")"
verify_pnr "$PNR_BASE" "10.88.2.1"

a_hits_1="$(curl -sf "${PROVIDER_A_URL%/}/__chaos/stats" | json_field pnr_hits)"
a_ok_1="$(curl -sf "${PROVIDER_A_URL%/}/__chaos/stats" | json_field ok_count)"
if [[ "$a_hits_1" -lt 1 || "$a_ok_1" -lt 1 ]]; then
  echo "ERROR: Provider A did not receive the PNR request (pnr_hits=${a_hits_1}, ok_count=${a_ok_1})." >&2
  echo "Ensure the API is configured with RAIL_PROVIDER_MODE=live, PROVIDER_RAIL_A_BASE_URL=${PROVIDER_A_URL}, PROVIDER_RAIL_B_BASE_URL=${PROVIDER_B_URL}." >&2
  exit 1
fi
echo "OK: Provider A served baseline PNR ${PNR_BASE} (pnr_hits=${a_hits_1})."

echo "Step 2: Injecting failure (${FAIL_MODE}) on Provider A..."
curl -sf -X POST "${PROVIDER_A_URL%/}/__chaos/fail?mode=${FAIL_MODE}&delay_ms=${FAIL_DELAY_MS}" >/dev/null

echo "Step 3: Verifying 5 distinct uncached PNRs succeed via Provider B fallback..."
b_ok_before="$(curl -sf "${PROVIDER_B_URL%/}/__chaos/stats" | json_field ok_count)"
for i in 1 2 3 4 5; do
  pnr="$(printf '6%09d' "$((RUN_SEED + 10 + i))")"
  verify_pnr "$pnr" "10.88.3.${i}"
done

b_ok_after="$(curl -sf "${PROVIDER_B_URL%/}/__chaos/stats" | json_field ok_count)"
if [[ $((b_ok_after - b_ok_before)) -lt 5 ]]; then
  echo "ERROR: Expected Provider B ok_count to increase by >=5, got $((b_ok_after - b_ok_before))." >&2
  exit 1
fi
echo "OK: All 5 PNRs served by Provider B (ok_count=${b_ok_after})."

echo "Step 4: Checking Redis circuit breaker key '${CB_KEY}'..."
cb_ttl="$(python3 - "$REDIS_URL" "$CB_KEY" <<'PY'
import socket
import sys
from urllib.parse import urlparse

redis_url = sys.argv[1]
key = sys.argv[2]
u = urlparse(redis_url)
host = u.hostname or "127.0.0.1"
port = u.port or 6379
db = int((u.path or "/0").lstrip("/") or "0")

def send_cmd(sock, *parts):
    buf = [f"*{len(parts)}\r\n".encode()]
    for p in parts:
        b = str(p).encode()
        buf.append(f"${len(b)}\r\n".encode() + b + b"\r\n")
    sock.sendall(b"".join(buf))
    line = b""
    while not line.endswith(b"\r\n"):
        chunk = sock.recv(1)
        if not chunk:
            raise RuntimeError("Redis closed connection")
        line += chunk
    if line.startswith(b":"):
        return int(line[1:-2])
    if line.startswith(b"+"):
        return line[1:-2].decode()
    if line.startswith(b"-"):
        raise RuntimeError(line[1:-2].decode())
    return line

with socket.create_connection((host, port), timeout=3) as s:
    if u.password:
        if u.username:
            send_cmd(s, "AUTH", u.username, u.password)
        else:
            send_cmd(s, "AUTH", u.password)
    if db:
        send_cmd(s, "SELECT", db)
    ttl = send_cmd(s, "TTL", key)
    print(ttl)
PY
)"

if [[ "$cb_ttl" -le 0 ]]; then
  echo "ERROR: Expected Redis key '${CB_KEY}' to exist with positive TTL, got TTL=${cb_ttl}." >&2
  exit 1
fi
echo "OK: Redis circuit breaker '${CB_KEY}' is OPEN (TTL=${cb_ttl}s)."

echo "Step 5: Verifying 6th PNR routes directly to Provider B without hitting Provider A..."
a_hits_before="$(curl -sf "${PROVIDER_A_URL%/}/__chaos/stats" | json_field pnr_hits)"
b_ok_before_6="$(curl -sf "${PROVIDER_B_URL%/}/__chaos/stats" | json_field ok_count)"

PNR_6="$(printf '6%09d' "$((RUN_SEED + 99))")"
verify_pnr "$PNR_6" "10.88.4.1"

a_hits_after="$(curl -sf "${PROVIDER_A_URL%/}/__chaos/stats" | json_field pnr_hits)"
b_ok_after_6="$(curl -sf "${PROVIDER_B_URL%/}/__chaos/stats" | json_field ok_count)"

if [[ "$a_hits_after" -ne "$a_hits_before" ]]; then
  echo "ERROR: Provider A was hit while circuit breaker was open (before=${a_hits_before}, after=${a_hits_after})." >&2
  exit 1
fi
if [[ "$b_ok_after_6" -le "$b_ok_before_6" ]]; then
  echo "ERROR: Provider B did not serve the 6th PNR while circuit breaker was open." >&2
  exit 1
fi

echo "PASS: Provider failover verified (Provider A bypassed while CB open, Provider B served PNR ${PNR_6})."
