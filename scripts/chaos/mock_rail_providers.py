#!/usr/bin/env python3
"""Dual HTTP mock server for Saath Rail Provider A and Rail Provider B.

Implements the exact HTTP/JSON contract expected by
``saath_api.providers.rail.adapters._HttpRailAdapter``:
  - GET /pnr/{pnr}
  - GET /trains/{train_no}/composition?date=YYYY-MM-DD
  - GET /trains/{train_no}/status?date=YYYY-MM-DD

Plus chaos control & telemetry endpoints on each provider port:
  - GET|POST /__chaos/fail?mode=ok|500|timeout&delay_ms=5000
  - GET      /__chaos/stats
  - GET|POST /__chaos/reset
  - GET      /healthz
"""

from __future__ import annotations

import argparse
import json
import re
import signal
import sys
import threading
import time
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, time as dt_time, timedelta
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlparse
from zoneinfo import ZoneInfo

IST = ZoneInfo("Asia/Kolkata")
_PNR_PATH_RE = re.compile(r"^/pnr/([0-9]{10})$")
_COMP_PATH_RE = re.compile(r"^/trains/([A-Za-z0-9]+)/composition$")
_STATUS_PATH_RE = re.compile(r"^/trains/([A-Za-z0-9]+)/status$")

_FLUSHED_PNRS = frozenset({"0000000000", "9999999991", "9999999992", "9999999999"})
_NOT_FOUND_PNRS = frozenset({"1111111111"})


@dataclass
class ProviderState:
    name: str
    expected_api_key: str = ""
    mode: str = "ok"
    delay_ms: int = 5000
    pnr_hits: int = 0
    composition_hits: int = 0
    status_hits: int = 0
    ok_count: int = 0
    fail_count: int = 0
    last_pnr: str | None = None
    lock: threading.Lock = field(default_factory=threading.Lock)

    def snapshot(self) -> dict[str, Any]:
        with self.lock:
            return {
                "provider": self.name,
                "mode": self.mode,
                "delay_ms": self.delay_ms,
                "pnr_hits": self.pnr_hits,
                "composition_hits": self.composition_hits,
                "status_hits": self.status_hits,
                "ok_count": self.ok_count,
                "fail_count": self.fail_count,
                "last_pnr": self.last_pnr,
            }

    def set_chaos(self, *, mode: str, delay_ms: int | None = None) -> dict[str, Any]:
        if mode not in ("ok", "500", "timeout"):
            raise ValueError(f"Invalid chaos mode {mode!r}; expected ok, 500, or timeout")
        with self.lock:
            self.mode = mode
            if delay_ms is not None:
                self.delay_ms = max(0, int(delay_ms))
        return self.snapshot()

    def reset(self) -> dict[str, Any]:
        with self.lock:
            self.mode = "ok"
            self.delay_ms = 5000
            self.pnr_hits = 0
            self.composition_hits = 0
            self.status_hits = 0
            self.ok_count = 0
            self.fail_count = 0
            self.last_pnr = None
        return self.snapshot()


def build_pnr_payload(pnr: str) -> dict[str, Any]:
    seed = int(pnr)
    svc_date = datetime.now(IST).date() + timedelta(days=2)
    dep_ist = datetime.combine(svc_date, dt_time(16, 55), tzinfo=IST)
    arr_ist = dep_ist + timedelta(hours=15, minutes=40)
    coach = f"B{(seed % 5) + 1}"
    seat_one = str((seed % 72) + 1)
    seat_two = str(((seed + 17) % 72) + 1)

    return {
        "train_no": "12951",
        "train_name": "Mumbai Tejas Rajdhani Express",
        "service_date": svc_date.isoformat(),
        "travel_class": "3A",
        "from_code": "NDLS",
        "to_code": "MMCT",
        "from_seq": 1,
        "to_seq": 9,
        "departure_at": dep_ist.astimezone(UTC).isoformat(),
        "arrival_at": arr_ist.astimezone(UTC).isoformat(),
        "chart_state": "pending",
        "passengers": [
            {
                "pax_seq": 1,
                "booking_status": "CNF",
                "current_status": "CNF",
                "coach": coach,
                "seat_no": seat_one,
                "age": 34,
                "gender": "F" if seed % 2 == 0 else "M",
            },
            {
                "pax_seq": 2,
                "booking_status": "CNF",
                "current_status": "CNF",
                "coach": coach,
                "seat_no": seat_two,
                "age": 36,
                "gender": "M" if seed % 2 == 0 else "F",
            },
        ],
    }


def make_handler(state: ProviderState) -> type[BaseHTTPRequestHandler]:
    class ChaosRailHandler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, format: str, *args: Any) -> None:
            # Structured single-line stderr logging
            sys.stderr.write(f"[{state.name}] {self.address_string()} - {format % args}\n")

        def _send_json(self, status_code: int, payload: Any) -> None:
            raw = json.dumps(payload).encode("utf-8")
            try:
                self.send_response(status_code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(raw)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def _read_json_body(self) -> dict[str, Any]:
            length_hdr = self.headers.get("Content-Length")
            if not length_hdr:
                return {}
            try:
                length = int(length_hdr)
            except ValueError:
                return {}
            if length <= 0:
                return {}
            raw = self.rfile.read(length)
            try:
                parsed = json.loads(raw.decode("utf-8"))
                return parsed if isinstance(parsed, dict) else {}
            except (UnicodeDecodeError, json.JSONDecodeError):
                return {}

        def _handle_chaos_fail(self, query: dict[str, list[str]]) -> None:
            body = self._read_json_body()
            mode = (
                (query.get("mode") or [None])[0]
                or body.get("mode")
                or "500"
            )
            delay_raw = (query.get("delay_ms") or [None])[0] or body.get("delay_ms")
            delay_ms = int(delay_raw) if delay_raw is not None else None
            try:
                snap = state.set_chaos(mode=str(mode).strip().lower(), delay_ms=delay_ms)
            except ValueError as exc:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
                return
            self._send_json(HTTPStatus.OK, snap)

        def _check_api_key(self) -> bool:
            if not state.expected_api_key:
                return True
            provided = self.headers.get("X-API-Key", "")
            return provided == state.expected_api_key

        def _apply_chaos_mode(self) -> bool:
            with state.lock:
                mode = state.mode
                delay_ms = state.delay_ms
            if mode == "500":
                with state.lock:
                    state.fail_count += 1
                self._send_json(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    {"error": "chaos_injected_500", "provider": state.name},
                )
                return False
            if mode == "timeout":
                time.sleep(delay_ms / 1000.0)
                with state.lock:
                    state.fail_count += 1
                self._send_json(
                    HTTPStatus.GATEWAY_TIMEOUT,
                    {"error": "chaos_injected_timeout", "provider": state.name},
                )
                return False
            return True

        def do_GET(self) -> None:  # noqa: N802
            parsed = urlparse(self.path)
            path = parsed.path
            query = parse_qs(parsed.query)

            if path == "/healthz":
                self._send_json(HTTPStatus.OK, {"status": "ok", "provider": state.name})
                return
            if path == "/__chaos/stats":
                self._send_json(HTTPStatus.OK, state.snapshot())
                return
            if path == "/__chaos/fail":
                self._handle_chaos_fail(query)
                return
            if path == "/__chaos/reset":
                self._send_json(HTTPStatus.OK, state.reset())
                return

            if not self._check_api_key():
                self._send_json(HTTPStatus.UNAUTHORIZED, {"error": "invalid_api_key"})
                return

            pnr_match = _PNR_PATH_RE.fullmatch(path)
            if pnr_match:
                pnr = pnr_match.group(1)
                with state.lock:
                    state.pnr_hits += 1
                    state.last_pnr = pnr
                if not self._apply_chaos_mode():
                    return
                if pnr in _FLUSHED_PNRS:
                    self._send_json(HTTPStatus.GONE, {"error": "pnr_flushed"})
                    return
                if pnr in _NOT_FOUND_PNRS:
                    self._send_json(HTTPStatus.NOT_FOUND, {"error": "pnr_not_found"})
                    return
                with state.lock:
                    state.ok_count += 1
                self._send_json(HTTPStatus.OK, build_pnr_payload(pnr))
                return

            comp_match = _COMP_PATH_RE.fullmatch(path)
            if comp_match:
                with state.lock:
                    state.composition_hits += 1
                if not self._apply_chaos_mode():
                    return
                with state.lock:
                    state.ok_count += 1
                coaches = [
                    {"coach": f"B{i}", "travel_class": "3A", "position": i, "capacity": 72}
                    for i in range(1, 6)
                ]
                self._send_json(HTTPStatus.OK, coaches)
                return

            status_match = _STATUS_PATH_RE.fullmatch(path)
            if status_match:
                train_no = status_match.group(1)
                svc_date = (query.get("date") or [date.today().isoformat()])[0]
                with state.lock:
                    state.status_hits += 1
                if not self._apply_chaos_mode():
                    return
                with state.lock:
                    state.ok_count += 1
                self._send_json(
                    HTTPStatus.OK,
                    {
                        "train_no": train_no,
                        "service_date": svc_date,
                        "current_station": "NDLS",
                        "delay_minutes": 0,
                        "chart_state": "pending",
                    },
                )
                return

            self._send_json(HTTPStatus.NOT_FOUND, {"error": "not_found"})

        def do_POST(self) -> None:  # noqa: N802
            parsed = urlparse(self.path)
            path = parsed.path
            query = parse_qs(parsed.query)

            if path == "/__chaos/fail":
                self._handle_chaos_fail(query)
                return
            if path == "/__chaos/reset":
                self._read_json_body()
                self._send_json(HTTPStatus.OK, state.reset())
                return

            self._send_json(HTTPStatus.NOT_FOUND, {"error": "not_found"})

    return ChaosRailHandler


class DualMockRailServers:
    def __init__(
        self,
        *,
        host: str = "127.0.0.1",
        port_a: int = 19101,
        port_b: int = 19102,
        api_key_a: str = "",
        api_key_b: str = "",
    ) -> None:
        self.state_a = ProviderState(name="rail_provider_a", expected_api_key=api_key_a)
        self.state_b = ProviderState(name="rail_provider_b", expected_api_key=api_key_b)
        ThreadingHTTPServer.allow_reuse_address = True
        self.server_a = ThreadingHTTPServer((host, port_a), make_handler(self.state_a))
        self.server_b = ThreadingHTTPServer((host, port_b), make_handler(self.state_b))
        self.port_a = int(self.server_a.server_address[1])
        self.port_b = int(self.server_b.server_address[1])
        self._thread_a = threading.Thread(target=self.server_a.serve_forever, daemon=True)
        self._thread_b = threading.Thread(target=self.server_b.serve_forever, daemon=True)

    def start(self) -> None:
        self._thread_a.start()
        self._thread_b.start()

    def stop(self) -> None:
        self.server_a.shutdown()
        self.server_b.shutdown()
        self.server_a.server_close()
        self.server_b.server_close()
        self._thread_a.join(timeout=3)
        self._thread_b.join(timeout=3)


def main() -> int:
    parser = argparse.ArgumentParser(description="Saath Chaos Dual Rail Provider Mock")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port-a", type=int, default=19101)
    parser.add_argument("--port-b", type=int, default=19102)
    parser.add_argument("--api-key-a", default="")
    parser.add_argument("--api-key-b", default="")
    args = parser.parse_args()

    servers = DualMockRailServers(
        host=args.host,
        port_a=args.port_a,
        port_b=args.port_b,
        api_key_a=args.api_key_a,
        api_key_b=args.api_key_b,
    )
    servers.start()

    stop_event = threading.Event()

    def _handle_sig(_signum: int, _frame: Any) -> None:
        stop_event.set()

    signal.signal(signal.SIGINT, _handle_sig)
    signal.signal(signal.SIGTERM, _handle_sig)

    print(
        json.dumps(
            {
                "status": "listening",
                "provider_a": f"http://{args.host}:{servers.port_a}",
                "provider_b": f"http://{args.host}:{servers.port_b}",
            }
        ),
        flush=True,
    )

    try:
        while not stop_event.is_set():
            stop_event.wait(0.5)
    finally:
        servers.stop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
