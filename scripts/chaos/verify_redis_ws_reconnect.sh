#!/usr/bin/env bash
set -euo pipefail

API_URL="${API_URL:-http://127.0.0.1:8000}"
WS_URL="${WS_URL:-ws://127.0.0.1:8000}"
ENV_MODE="${ENV:-${E2E_ENV:-development}}"
TURNSTILE_TEST_TOKEN="${TURNSTILE_TEST_TOKEN:-fake-turnstile-ok}"
E2E_TEST_OTP="${E2E_TEST_OTP:-123456}"
AUTH_TOKEN="${AUTH_TOKEN:-}"
REDIS_RESTART_CMD="${REDIS_RESTART_CMD:-}"

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

# 2. Tool & restart command preflight
for bin in python3 curl; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "ERROR: Required tool '$bin' is not installed or not in PATH." >&2
    exit 1
  fi
done

if [[ -z "$REDIS_RESTART_CMD" ]]; then
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    if docker compose ps --services 2>/dev/null | grep -qx "redis"; then
      REDIS_RESTART_CMD="docker compose restart redis"
    fi
  fi
fi

if [[ -z "$REDIS_RESTART_CMD" ]]; then
  echo "ERROR: Cannot determine how to restart Redis." >&2
  echo "Either start the Docker Compose stack (so 'docker compose restart redis' works) or set REDIS_RESTART_CMD (e.g. 'brew services restart redis')." >&2
  exit 1
fi

ready_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "${API_URL%/}/readyz" || true)"
if [[ "$ready_code" != "200" ]]; then
  echo "ERROR: Preflight failed: GET ${API_URL%/}/readyz returned HTTP ${ready_code:-000} (expected 200)." >&2
  exit 1
fi

echo "Running Chaos 2: Redis Restart & WebSocket Reconnect..."
echo "Restart command: $REDIS_RESTART_CMD"

python3 - "$API_URL" "$WS_URL" "$TURNSTILE_TEST_TOKEN" "$E2E_TEST_OTP" "$AUTH_TOKEN" "$REDIS_RESTART_CMD" <<'PY'
import base64
import hashlib
import json
import os
import socket
import ssl
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.request
from urllib.parse import urlparse

API_URL, WS_URL, TURNSTILE, TEST_OTP, AUTH_TOKEN, RESTART_CMD = sys.argv[1:7]
API_URL = API_URL.rstrip("/")
WS_URL = WS_URL.rstrip("/")


def http_json(method: str, path: str, body: dict | None = None, token: str | None = None, xff: str = "10.77.1.1"):
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


class MinimalWsClient:
    """RFC 6455 WebSocket client using Python stdlib sockets."""

    def __init__(self, url: str, timeout: float = 10.0) -> None:
        u = urlparse(url)
        self.scheme = u.scheme
        self.host = u.hostname or "127.0.0.1"
        self.port = u.port or (443 if u.scheme == "wss" else 80)
        self.path = u.path or "/"
        if u.query:
            self.path += f"?{u.query}"

        raw_sock = socket.create_connection((self.host, self.port), timeout=timeout)
        if self.scheme == "wss":
            ctx = ssl.create_default_context()
            raw_sock = ctx.wrap_socket(raw_sock, server_hostname=self.host)
        self.sock = raw_sock
        self.sock.settimeout(timeout)
        self._buf = bytearray()
        self._handshake()

    def _handshake(self) -> None:
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        req = (
            f"GET {self.path} HTTP/1.1\r\n"
            f"Host: {self.host}:{self.port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        )
        self.sock.sendall(req.encode("ascii"))
        header_buf = b""
        while b"\r\n\r\n" not in header_buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise RuntimeError("WebSocket handshake failed: EOF")
            header_buf += chunk
        status_line = header_buf.split(b"\r\n", 1)[0].decode("latin1")
        if "101" not in status_line:
            raise RuntimeError(f"WebSocket handshake rejected: {status_line}")
        idx = header_buf.index(b"\r\n\r\n") + 4
        if len(header_buf) > idx:
            self._buf.extend(header_buf[idx:])

    def _recv_exact(self, n: int) -> bytes:
        while len(self._buf) < n:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise EOFError("WebSocket connection closed")
            self._buf.extend(chunk)
        out = bytes(self._buf[:n])
        del self._buf[:n]
        return out

    def send_text(self, text: str) -> None:
        payload = text.encode("utf-8")
        mask = os.urandom(4)
        length = len(payload)
        header = bytearray([0x81])
        if length < 126:
            header.append(0x80 | length)
        elif length < 65536:
            header.append(0x80 | 126)
            header.extend(struct.pack("!H", length))
        else:
            header.append(0x80 | 127)
            header.extend(struct.pack("!Q", length))
        header.extend(mask)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(bytes(header) + masked)

    def recv_json(self, timeout: float = 10.0) -> dict | None:
        self.sock.settimeout(timeout)
        while True:
            b1, b2 = self._recv_exact(2)
            opcode = b1 & 0x0F
            masked = bool(b2 & 0x80)
            length = b2 & 0x7F
            if length == 126:
                length = struct.unpack("!H", self._recv_exact(2))[0]
            elif length == 127:
                length = struct.unpack("!Q", self._recv_exact(8))[0]
            mask_key = self._recv_exact(4) if masked else b""
            data = self._recv_exact(length) if length else b""
            if masked:
                data = bytes(b ^ mask_key[i % 4] for i, b in enumerate(data))
            if opcode == 0x8:  # close frame
                raise EOFError("WebSocket close frame received")
            if opcode == 0x9:  # ping -> send masked pong
                pong_hdr = bytearray([0x8A, 0x80 | len(data)])
                pmask = os.urandom(4)
                pong_hdr.extend(pmask)
                self.sock.sendall(bytes(pong_hdr) + bytes(b ^ pmask[i % 4] for i, b in enumerate(data)))
                continue
            if opcode == 0x1:
                return json.loads(data.decode("utf-8"))

    def close(self) -> None:
        try:
            self.sock.close()
        except OSError:
            pass


# Step 1: Obtain verified user token (required for user:{uid} match.updated pubsub)
token = AUTH_TOKEN.strip()
if not token:
    phone = f"9{(int(time.time() * 1000) % 899999999) + 100000000}"
    st, start_data, start_hdrs = http_json(
        "POST",
        "/v1/auth/otp/start",
        {"phone": phone, "channel": "whatsapp", "turnstile": TURNSTILE, "locale": "en"},
        xff="10.77.1.2",
    )
    if st != 200:
        raise SystemExit(f"ERROR: OTP start failed ({st}): {start_data}")
    otp_code = (
        start_data.get("dev_otp")
        or start_data.get("otp")
        or start_hdrs.get("x-dev-otp")
        or start_hdrs.get("x-sandbox-otp")
        or TEST_OTP
    )
    vst, vdata, _ = http_json(
        "POST",
        "/v1/auth/otp/verify",
        {"request_id": start_data["request_id"], "code": otp_code},
        xff="10.77.1.2",
    )
    if vst != 200 or not vdata.get("access"):
        raise SystemExit(
            "ERROR: Could not authenticate a verified user session via /v1/auth/otp/verify "
            f"(HTTP {vst}: {vdata}). Supply AUTH_TOKEN=<user_jwt> or enable E2E_TEST_OTP."
        )
    token = vdata["access"]

# Step 2: Verify a train journey so we have party_id and seat_holder_id
pnr = f"7{(int(time.time() * 1000) % 899999999) + 100000000}"
jst, jdata, _ = http_json(
    "POST",
    "/v1/journeys/verify",
    {"mode": "train", "pnr": pnr},
    token=token,
    xff="10.77.1.3",
)
if jst != 200:
    raise SystemExit(f"ERROR: Journey verify failed ({jst}): {jdata}")
party_id = jdata["party_id"]
seat_holder_ids = [sh["id"] for sh in jdata["seat_holders"]]

# Step 3: Connect WS #1 and authenticate
ws1 = MinimalWsClient(f"{WS_URL}/v1/ws", timeout=10.0)
ws1.send_text(json.dumps({"type": "auth", "token": token}))
frame1 = ws1.recv_json(timeout=10.0)
if not frame1 or frame1.get("type") != "ready":
    raise SystemExit(f"ERROR: WS1 expected ready frame, got {frame1}")
print("OK: WS1 connected and received ready frame.")

# Step 4: Restart Redis
print("Triggering Redis restart...")
res = subprocess.run(RESTART_CMD, shell=True, check=False, capture_output=True, text=True)
if res.returncode != 0:
    raise SystemExit(f"ERROR: Redis restart command failed ({res.returncode}): {res.stderr}")

# Step 5: Poll /readyz back to 200 (logging transient 503 if observed)
saw_503 = False
ready_ok = False
deadline = time.monotonic() + 30.0
while time.monotonic() < deadline:
    st, _, _ = http_json("GET", "/readyz")
    if st == 503:
        saw_503 = True
    elif st == 200:
        ready_ok = True
        break
    time.sleep(0.3)

if not ready_ok:
    raise SystemExit("ERROR: /readyz did not recover to 200 within 30s after Redis restart.")
print(f"OK: /readyz recovered to 200 (saw_transient_503={saw_503}).")

# Verify old WS1 drops cleanly after Redis restart (ws.py:_pump_redis exits on ConnectionError)
ws1_dropped = False
try:
    ws1.send_text(json.dumps({"type": "ping"}))
    for _ in range(3):
        ws1.recv_json(timeout=2.0)
except (EOFError, OSError, TimeoutError):
    ws1_dropped = True
finally:
    ws1.close()
print(f"OK: WS1 post-restart state checked (dropped={ws1_dropped}).")

# Step 6: Reconnect WS #2 and re-authenticate
ws2 = MinimalWsClient(f"{WS_URL}/v1/ws", timeout=10.0)
ws2.send_text(json.dumps({"type": "auth", "token": token}))
frame2 = ws2.recv_json(timeout=10.0)
if not frame2 or frame2.get("type") != "ready":
    ws2.close()
    raise SystemExit(f"ERROR: WS2 expected ready frame after reconnect, got {frame2}")
print("OK: WS2 reconnected and received ready frame.")

# Step 7: Trigger PUT /v1/parties/{pid}/goal and assert match.updated arrives on WS2
gst, gdata, _ = http_json(
    "PUT",
    f"/v1/parties/{party_id}/goal",
    {"goal_type": "open_to_help", "movers": seat_holder_ids},
    token=token,
    xff="10.77.1.4",
)
if gst != 200:
    ws2.close()
    raise SystemExit(f"ERROR: PUT /v1/parties/{party_id}/goal failed ({gst}): {gdata}")

match_event = None
event_deadline = time.monotonic() + 15.0
while time.monotonic() < event_deadline:
    try:
        remaining = max(0.5, event_deadline - time.monotonic())
        msg = ws2.recv_json(timeout=min(2.0, remaining))
        if msg and msg.get("type") == "match.updated" and msg.get("party_id") == party_id:
            match_event = msg
            break
    except TimeoutError:
        ws2.send_text(json.dumps({"type": "ping"}))
    except EOFError:
        break

ws2.close()
if not match_event:
    raise SystemExit("ERROR: Did not receive match.updated event on reconnected WS2 within 15s.")

print(f"PASS: Received match.updated on reconnected WS2: {json.dumps(match_event)}")
PY
