from __future__ import annotations

import asyncio
import time
import uuid
from typing import cast

from fastapi import Request
from redis.asyncio import Redis
from redis.exceptions import ResponseError

from saath_api.core.config import Settings

_SLIDING_WINDOW_LUA = """
local key = KEYS[1]
local now_ms = tonumber(ARGV[1])
local cutoff_ms = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local window_seconds = tonumber(ARGV[4])
local member = ARGV[5]

redis.call('ZREMRANGEBYSCORE', key, 0, cutoff_ms)
local current = redis.call('ZCARD', key)
if current >= limit then
  return {0, window_seconds}
end
redis.call('ZADD', key, now_ms, member)
redis.call('EXPIRE', key, window_seconds + 1)
return {1, 0}
"""

_FALLBACK_LOCKS: dict[str, asyncio.Lock] = {}


def _lock_for_key(key: str) -> asyncio.Lock:
    lock = _FALLBACK_LOCKS.get(key)
    if lock is None:
        lock = asyncio.Lock()
        _FALLBACK_LOCKS[key] = lock
    return lock


def create_redis_client(settings: Settings) -> Redis:
    return Redis.from_url(settings.redis_url, decode_responses=True)


def get_redis(request: Request) -> Redis:
    return cast(Redis, request.app.state.redis)


async def check_redis_ready(redis: Redis) -> bool:
    try:
        pong = await redis.ping()
        return bool(pong)
    except Exception:
        return False


class SlidingWindowRateLimiter:
    """Atomic Redis sorted-set sliding window rate limiter."""

    def __init__(self, redis: Redis) -> None:
        self._redis = redis

    async def allow(self, key: str, *, limit: int, window_seconds: int) -> tuple[bool, int]:
        now_ms = int(time.time() * 1000)
        cutoff_ms = now_ms - (window_seconds * 1000)
        member = f"{now_ms}:{uuid.uuid4().hex[:8]}"

        try:
            raw = await self._redis.eval(  # type: ignore[misc,no-untyped-call]
                _SLIDING_WINDOW_LUA,
                1,
                key,
                str(now_ms),
                str(cutoff_ms),
                str(limit),
                str(window_seconds),
                member,
            )
            allowed = bool(int(raw[0]))
            retry_after = int(raw[1])
            return allowed, retry_after
        except ResponseError as exc:
            # fakeredis without optional `lupa` raises ResponseError on EVAL;
            # fall back to an in-process per-key asyncio lock for unit tests.
            if "lupa" not in str(exc).lower() and "unknown command" not in str(exc).lower():
                raise

        async with _lock_for_key(key):
            pipe = self._redis.pipeline()
            pipe.zremrangebyscore(key, 0, cutoff_ms)
            pipe.zcard(key)
            results = await pipe.execute()
            current_count = int(results[1])
            if current_count >= limit:
                return False, window_seconds
            pipe2 = self._redis.pipeline()
            pipe2.zadd(key, {member: float(now_ms)})
            pipe2.expire(key, window_seconds + 1)
            await pipe2.execute()
            return True, 0
