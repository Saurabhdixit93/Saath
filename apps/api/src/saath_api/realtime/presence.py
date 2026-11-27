from __future__ import annotations

import contextlib
from uuid import UUID

from redis.asyncio import Redis

_PRESENCE_PREFIX = "presence:user:"


async def touch_presence(
    redis: Redis | None,
    user_id: UUID | str,
    *,
    ttl_seconds: int = 60,
) -> None:
    if redis is None:
        return
    with contextlib.suppress(Exception):
        await redis.set(f"{_PRESENCE_PREFIX}{user_id}", "1", ex=ttl_seconds)


async def clear_presence(redis: Redis | None, user_id: UUID | str) -> None:
    if redis is None:
        return
    with contextlib.suppress(Exception):
        await redis.delete(f"{_PRESENCE_PREFIX}{user_id}")


async def is_user_online(redis: Redis | None, user_id: UUID | str) -> bool:
    if redis is None:
        return False
    try:
        return bool(await redis.exists(f"{_PRESENCE_PREFIX}{user_id}"))
    except Exception:
        return False
