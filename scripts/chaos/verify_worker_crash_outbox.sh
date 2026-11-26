#!/usr/bin/env bash
set -euo pipefail

API_URL="${API_URL:-http://127.0.0.1:8000}"
ENV_MODE="${ENV:-${E2E_ENV:-development}}"
TURNSTILE_TEST_TOKEN="${TURNSTILE_TEST_TOKEN:-fake-turnstile-ok}"
E2E_TEST_OTP="${E2E_TEST_OTP:-123456}"
ADMIN_EMAIL="${ADMIN_EMAIL:-ops@saath.test}"
ADMIN_TOKEN="${ADMIN_TOKEN:-}"
AUTH_TOKEN="${AUTH_TOKEN:-}"
WORKER_KILL_CMD="${WORKER_KILL_CMD:-}"
WORKER_START_CMD="${WORKER_START_CMD:-}"
OUTBOX_POLL_TIMEOUT_SEC="${OUTBOX_POLL_TIMEOUT_SEC:-60}"

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

# 2. Tool & worker process control preflight
for bin in python3 curl; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "ERROR: Required tool '$bin' is not installed or not in PATH." >&2
    exit 1
  fi
done

USE_DOCKER_COMPOSE=0
if [[ -z "$WORKER_KILL_CMD" || -z "$WORKER_START_CMD" ]]; then
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    if docker compose ps --services 2>/dev/null | grep -qx "worker"; then
      USE_DOCKER_COMPOSE=1
      WORKER_KILL_CMD="${WORKER_KILL_CMD:-docker compose kill -s SIGKILL worker}"
      WORKER_START_CMD="${WORKER_START_CMD:-docker compose start worker}"
    fi
  fi
fi

if [[ -z "$WORKER_KILL_CMD" || -z "$WORKER_START_CMD" ]]; then
  echo "ERROR: Cannot determine how to SIGKILL/restart the Arq worker." >&2
  echo "Either start the Docker Compose stack (so 'docker compose kill -s SIGKILL worker' works) or set WORKER_KILL_CMD and WORKER_START_CMD." >&2
  exit 1
fi

ready_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "${API_URL%/}/readyz" || true)"
if [[ "$ready_code" != "200" ]]; then
  echo "ERROR: Preflight failed: GET ${API_URL%/}/readyz returned HTTP ${ready_code:-000} (expected 200)." >&2
  exit 1
fi

echo "Running Chaos 3: Worker SIGKILL & Outbox Recovery..."
echo "Kill command:  $WORKER_KILL_CMD"
echo "Start command: $WORKER_START_CMD"

python3 - "$API_URL" "$TURNSTILE_TEST_TOKEN" "$E2E_TEST_OTP" "$ADMIN_EMAIL" "$ADMIN_TOKEN" "$AUTH_TOKEN" "$WORKER_KILL_CMD" "$WORKER_START_CMD" "$OUTBOX_POLL_TIMEOUT_SEC" "$USE_DOCKER_COMPOSE" <<'PY'
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request

(
    API_URL,
    TURNSTILE,
    TEST_OTP,
    ADMIN_EMAIL,
    ADMIN_TOKEN,
    AUTH_TOKEN,
    KILL_CMD,
    START_CMD,
    POLL_TIMEOUT_RAW,
    USE_DOCKER_RAW,
) = sys.argv[1:11]

API_URL = API_URL.rstrip("/")
POLL_TIMEOUT = int(POLL_TIMEOUT_RAW)
USE_DOCKER = USE_DOCKER_RAW == "1"


def http_json(method: str, path: str, body: dict | None = None, token: str | None = None, xff: str = "10.66.1.1"):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {
        "Accept": "application/json, application/problem+json",
        "X-Forwarded-For": xff,
    }
    if data is not None:
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(f"{API_URL}{path}", data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            raw = resp.read().decode("utf-8")
            hdrs = {k.lower(): v for k, v in resp.headers.items()}
            return resp.status, json.loads(raw) if raw else {}, hdrs
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="ignore")
        try:
            parsed = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            parsed = {"raw": raw}
        return exc.code, parsed, {k.lower(): v for k, v in exc.headers.items()}


def query_outbox_via_psql() -> dict[str, int] | None:
    if not USE_DOCKER:
        return None
    sql = (
        "SELECT "
        "COALESCE(SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END),0), "
        "COALESCE(SUM(CASE WHEN status='sent' THEN 1 ELSE 0 END),0), "
        "COALESCE(SUM(CASE WHEN status='dead_letter' THEN 1 ELSE 0 END),0), "
        "COUNT(*) - COUNT(DISTINCT idempotency_key) "
        "FROM notifications_outbox;"
    )
    proc = subprocess.run(
        ["docker", "compose", "exec", "-T", "postgres", "psql", "-U", "saath", "-d", "saath", "-t", "-A", "-F", ",", "-c", sql],
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        return None
    parts = [p.strip() for p in proc.stdout.strip().split(",")]
    if len(parts) != 4:
        return None
    return {
        "queued": int(parts[0]),
        "sent": int(parts[1]),
        "dead_letter": int(parts[2]),
        "duplicates": int(parts[3]),
    }


def resolve_admin_token() -> str | None:
    if ADMIN_TOKEN.strip():
        return ADMIN_TOKEN.strip()
    st, data, _ = http_json("POST", "/v1/admin/auth/session", {"email": ADMIN_EMAIL})
    if st == 200:
        return data.get("access") or data.get("token")
    return None


def read_outbox_stats(admin_tok: str | None) -> dict[str, int]:
    if admin_tok:
        st, data, _ = http_json("GET", "/v1/admin/providers/health", token=admin_tok)
        if st == 200 and isinstance(data.get("outbox"), dict):
            outbox = data["outbox"]
            psql_extra = query_outbox_via_psql()
            return {
                "queued": int(outbox.get("queued", 0)),
                "sent": int(outbox.get("sent", 0)),
                "dead_letter": int(outbox.get("dead_letter", 0)),
                "duplicates": psql_extra["duplicates"] if psql_extra else 0,
            }
    psql_stats = query_outbox_via_psql()
    if psql_stats is not None:
        return psql_stats
    raise SystemExit(
        "ERROR: Unable to read outbox health via GET /v1/admin/providers/health or Postgres psql."
    )


# 1. Authenticate user/anon session
token = AUTH_TOKEN.strip()
if not token:
    phone = f"9{(int(time.time() * 1000) % 899999999) + 100000000}"
    st, start_data, start_hdrs = http_json(
        "POST",
        "/v1/auth/otp/start",
        {"phone": phone, "channel": "whatsapp", "turnstile": TURNSTILE, "locale": "en"},
        xff="10.66.1.2",
    )
    if st == 200:
        code = (
            start_data.get("dev_otp")
            or start_data.get("otp")
            or start_hdrs.get("x-dev-otp")
            or start_hdrs.get("x-sandbox-otp")
            or TEST_OTP
        )
        vst, vdata, _ = http_json(
            "POST",
            "/v1/auth/otp/verify",
            {"request_id": start_data["request_id"], "code": code},
            xff="10.66.1.2",
        )
        if vst == 200 and vdata.get("access"):
            token = vdata["access"]

    if not token:
        ast, adata, _ = http_json(
            "POST",
            "/v1/auth/anonymous",
            {"turnstile": TURNSTILE},
            xff="10.66.1.2",
        )
        if ast != 200 or not adata.get("access"):
            raise SystemExit(f"ERROR: Session auth failed ({ast}): {adata}")
        token = adata["access"]

admin_tok = resolve_admin_token()
baseline = read_outbox_stats(admin_tok)
print(f"Baseline outbox stats: {baseline}")

# 2. Verify a train journey
pnr = f"7{(int(time.time() * 1000) % 899999999) + 100000000}"
jst, jdata, _ = http_json(
    "POST",
    "/v1/journeys/verify",
    {"mode": "train", "pnr": pnr},
    token=token,
    xff="10.66.1.3",
)
if jst != 200:
    raise SystemExit(f"ERROR: Journey verify failed ({jst}): {jdata}")
party_id = jdata["party_id"]
seat_holder_ids = [sh["id"] for sh in jdata["seat_holders"]]

# 3. Trigger Event #1 (creates NotificationsOutbox row)
g1_st, g1_data, _ = http_json(
    "PUT",
    f"/v1/parties/{party_id}/goal",
    {"goal_type": "lower", "movers": seat_holder_ids},
    token=token,
    xff="10.66.1.4",
)
if g1_st != 200:
    raise SystemExit(f"ERROR: Event #1 PUT /goal failed ({g1_st}): {g1_data}")

# 4. SIGKILL the Arq worker mid-run
print("Sending SIGKILL to worker...")
kill_res = subprocess.run(KILL_CMD, shell=True, check=False, capture_output=True, text=True)
if kill_res.returncode != 0:
    raise SystemExit(f"ERROR: Worker kill command failed ({kill_res.returncode}): {kill_res.stderr}")

# 5. Trigger Event #2 while worker is down
g2_st, g2_data, _ = http_json(
    "PUT",
    f"/v1/parties/{party_id}/goal",
    {"goal_type": "upper", "movers": seat_holder_ids},
    token=token,
    xff="10.66.1.5",
)
if g2_st != 200:
    subprocess.run(START_CMD, shell=True, check=False)
    raise SystemExit(f"ERROR: Event #2 PUT /goal failed ({g2_st}): {g2_data}")

mid = read_outbox_stats(admin_tok)
print(f"Mid-crash outbox stats (worker killed): {mid}")

# 6. Restart the worker
print("Restarting worker...")
start_res = subprocess.run(START_CMD, shell=True, check=False, capture_output=True, text=True)
if start_res.returncode != 0:
    raise SystemExit(f"ERROR: Worker start command failed ({start_res.returncode}): {start_res.stderr}")

# 7. Poll until outbox.queued == 0 and sent advances by >= 2 without duplicates
deadline = time.monotonic() + POLL_TIMEOUT
final_stats = None
while time.monotonic() < deadline:
    curr = read_outbox_stats(admin_tok)
    if curr["queued"] == 0 and curr["sent"] >= baseline["sent"] + 2:
        final_stats = curr
        break
    time.sleep(2.0)

if final_stats is None:
    curr = read_outbox_stats(admin_tok)
    raise SystemExit(
        f"ERROR: Outbox did not drain within {POLL_TIMEOUT}s after worker restart. "
        f"baseline={baseline}, current={curr}"
    )

if final_stats["duplicates"] != 0:
    raise SystemExit(f"ERROR: Detected duplicate outbox idempotency keys: {final_stats}")

print(f"PASS: Worker crash outbox recovery verified: baseline={baseline}, final={final_stats}")
PY
