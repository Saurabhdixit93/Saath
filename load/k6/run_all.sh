#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

API_URL="${API_URL:-http://127.0.0.1:8000}"
WS_URL="${WS_URL:-ws://127.0.0.1:8000}"
ENV_MODE="${ENV:-${E2E_ENV:-development}}"
VERIFY_MAX_VUS="${VERIFY_MAX_VUS:-500}"
WS_MAX_VUS="${WS_MAX_VUS:-${MAX_VUS:-5000}}"

RUN_VERIFY=0
RUN_WS=0
RUN_STORM=0

usage() {
  cat <<EOF
Usage: $(basename "$0") [--verify] [--ws] [--storm] [--all]

Runs the Saath Prompt 16 k6 load test suite.

Flags:
  --verify    Run verify_200rps.js (200 verifies/s for 60s)
  --ws        Run ws_5000_concurrent.js (5,000 concurrent /v1/ws connections)
  --storm     Run match_recompute_storm.js (200 passengers bursting goal+match)
  --all       Run all 3 scenarios sequentially (default if no flag specified)
  -h, --help  Show this help message

Environment variables:
  API_URL     Target API HTTP base URL (default: http://127.0.0.1:8000)
  WS_URL      Target API WebSocket base URL (default: ws://127.0.0.1:8000)
  ENV         Must not be 'production' (unless ALLOW_PROD_LOAD_TEST=1)
EOF
}

if [[ $# -eq 0 ]]; then
  RUN_VERIFY=1
  RUN_WS=1
  RUN_STORM=1
else
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --verify)
        RUN_VERIFY=1
        ;;
      --ws)
        RUN_WS=1
        ;;
      --storm)
        RUN_STORM=1
        ;;
      --all)
        RUN_VERIFY=1
        RUN_WS=1
        RUN_STORM=1
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        echo "ERROR: Unknown option '$1'" >&2
        usage >&2
        exit 2
        ;;
    esac
    shift
  done
fi

# 1. Production safety guard
if [[ "${ALLOW_PROD_LOAD_TEST:-0}" != "1" ]]; then
  lower_env="$(printf '%s' "$ENV_MODE" | tr '[:upper:]' '[:lower:]')"
  if [[ "$lower_env" == "production" || "$lower_env" == "prod" ]]; then
    echo "ERROR: Refusing to run load tests when ENV=${ENV_MODE}. Set ALLOW_PROD_LOAD_TEST=1 only if intentionally targeting staging/canary." >&2
    exit 1
  fi
  if [[ "$API_URL" =~ https://.*saath\.(in|com|app) ]]; then
    echo "ERROR: API_URL ($API_URL) looks like a production endpoint. Refusing to run load test without ALLOW_PROD_LOAD_TEST=1." >&2
    exit 1
  fi
fi

# 2. Detect k6 binary or Docker grafana/k6 fallback
RUNNER=""
if command -v k6 >/dev/null 2>&1; then
  RUNNER="k6"
elif command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  RUNNER="docker"
else
  echo "ERROR: Neither 'k6' nor a running 'docker' daemon was found." >&2
  echo "Install k6 (e.g., 'brew install k6' on macOS or see https://grafana.com/docs/k6/latest/set-up/install-k6/)" >&2
  echo "or start Docker Desktop so 'grafana/k6' can be used as a fallback." >&2
  exit 1
fi

# 3. Check file descriptor limit for WebSocket concurrency test
if [[ "$RUN_WS" -eq 1 ]]; then
  open_files="$(ulimit -n 2>/dev/null || echo 0)"
  if [[ "$open_files" =~ ^[0-9]+$ ]] && [[ "$open_files" -lt 16384 ]]; then
    echo "WARNING: 'ulimit -n' is $open_files (< 16384). High-concurrency WS tests (WS_MAX_VUS=${WS_MAX_VUS}) may hit EMFILE." >&2
    echo "         Run 'ulimit -n 16384' or set WS_MAX_VUS=1000 for local smoke runs." >&2
  fi
fi

# 4. Preflight /readyz check
check_readyz() {
  local url="${API_URL%/}/readyz"
  local code=""
  if command -v curl >/dev/null 2>&1; then
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$url" || true)"
  elif command -v python3 >/dev/null 2>&1; then
    code="$(python3 -c "import urllib.request, sys
try:
    with urllib.request.urlopen('$url', timeout=5) as r:
        print(r.status)
except Exception:
    print(0)" 2>/dev/null || echo 0)"
  else
    echo "ERROR: Neither 'curl' nor 'python3' found to verify $url." >&2
    exit 1
  fi

  if [[ "$code" != "200" ]]; then
    echo "ERROR: Preflight check failed: GET $url returned HTTP ${code:-000} (expected 200)." >&2
    echo "Ensure Saath API, Postgres, and Redis are running before executing k6 load tests." >&2
    exit 1
  fi
}

check_readyz
echo "Preflight passed: $API_URL/readyz returned 200 (runner=$RUNNER)."

run_k6_script() {
  local script_rel="$1"
  local script_max_vus="$VERIFY_MAX_VUS"
  if [[ "$script_rel" == "ws_5000_concurrent.js" ]]; then
    script_max_vus="$WS_MAX_VUS"
  fi

  echo ""
  echo "============================================================"
  echo "Running k6 scenario: ${script_rel}"
  echo "============================================================"

  if [[ "$RUNNER" == "k6" ]]; then
    API_URL="$API_URL" WS_URL="$WS_URL" MAX_VUS="$script_max_vus" k6 run "${SCRIPT_DIR}/${script_rel}"
  else
    local docker_api_url="$API_URL"
    local docker_ws_url="$WS_URL"
    local net_args=()
    if [[ "$(uname -s)" == "Linux" ]]; then
      net_args+=(--network host)
    else
      net_args+=(--add-host=host.docker.internal:host-gateway)
      docker_api_url="${docker_api_url//127.0.0.1/host.docker.internal}"
      docker_api_url="${docker_api_url//localhost/host.docker.internal}"
      docker_ws_url="${docker_ws_url//127.0.0.1/host.docker.internal}"
      docker_ws_url="${docker_ws_url//localhost/host.docker.internal}"
    fi
    docker run --rm -i \
      "${net_args[@]}" \
      -v "${SCRIPT_DIR}:/scripts:ro" \
      -e "API_URL=${docker_api_url}" \
      -e "WS_URL=${docker_ws_url}" \
      -e "ENV=${ENV_MODE}" \
      -e "AUTH_MODE=${AUTH_MODE:-auto}" \
      -e "E2E_TEST_OTP=${E2E_TEST_OTP:-123456}" \
      -e "TURNSTILE_TEST_TOKEN=${TURNSTILE_TEST_TOKEN:-fake-turnstile-ok}" \
      -e "RATE=${RATE:-200}" \
      -e "DURATION=${DURATION:-60s}" \
      -e "PREMINT_USERS=${PREMINT_USERS:-500}" \
      -e "PRE_ALLOCATED_VUS=${PRE_ALLOCATED_VUS:-150}" \
      -e "CACHE_HIT_RATIO=${CACHE_HIT_RATIO:-0.7}" \
      -e "MAX_VUS=${script_max_vus}" \
      -e "HEARTBEAT_INTERVAL_SEC=${HEARTBEAT_INTERVAL_SEC:-15}" \
      -e "HOLD_SECONDS=${HOLD_SECONDS:-60}" \
      -e "PASSENGER_COUNT=${PASSENGER_COUNT:-200}" \
      -e "PEAK_RATE=${PEAK_RATE:-50}" \
      grafana/k6:latest run "/scripts/${script_rel}"
  fi
}

if [[ "$RUN_VERIFY" -eq 1 ]]; then
  run_k6_script "verify_200rps.js"
fi

if [[ "$RUN_WS" -eq 1 ]]; then
  run_k6_script "ws_5000_concurrent.js"
fi

if [[ "$RUN_STORM" -eq 1 ]]; then
  run_k6_script "match_recompute_storm.js"
fi

echo ""
echo "All selected k6 load test scenarios completed successfully."
