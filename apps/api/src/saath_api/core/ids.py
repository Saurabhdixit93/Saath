from __future__ import annotations

import os
import secrets
import threading
import time
import uuid

_UUID7_LOCK = threading.Lock()
_LAST_TIMESTAMP_MS = 0
_SEQUENCE = 0


def uuid7() -> uuid.UUID:
    """Generate a monotonic RFC 9562 UUIDv7.

    Layout: 48-bit Unix ms + 12-bit counter + 62 random bits.
    """
    global _LAST_TIMESTAMP_MS, _SEQUENCE

    with _UUID7_LOCK:
        timestamp_ms = time.time_ns() // 1_000_000
        if timestamp_ms <= _LAST_TIMESTAMP_MS:
            _SEQUENCE += 1
            if _SEQUENCE > 0x0FFF:
                _LAST_TIMESTAMP_MS += 1
                _SEQUENCE = 0
            timestamp_ms = _LAST_TIMESTAMP_MS
        else:
            _LAST_TIMESTAMP_MS = timestamp_ms
            _SEQUENCE = int.from_bytes(os.urandom(2), "big") & 0x03FF
        rand_a = _SEQUENCE & 0x0FFF

    rand_b = int.from_bytes(os.urandom(8), "big") & 0x3FFFFFFFFFFFFFFF

    value = (timestamp_ms & 0xFFFFFFFFFFFF) << 80
    value |= 0x7 << 76
    value |= rand_a << 64
    value |= 0b10 << 62
    value |= rand_b
    return uuid.UUID(int=value)


def generate_opaque_token(nbytes: int = 32) -> str:
    return secrets.token_urlsafe(nbytes)
