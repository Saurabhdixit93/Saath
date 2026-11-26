from __future__ import annotations

import json
from typing import Any
from uuid import UUID

import structlog
from redis.asyncio import Redis

logger = structlog.get_logger(__name__)


def user_channel(user_id: UUID | str) -> str:
    return f"user:{user_id}"


def anon_channel(anon_id: str) -> str:
    return f"anon:{anon_id}"


def conversation_channel(conversation_id: UUID | str) -> str:
    return f"conversation:{conversation_id}"


async def publish_user_event(
    redis: Redis | None,
    user_id: UUID | str,
    event: dict[str, Any],
) -> None:
    if redis is None:
        return
    try:
        await redis.publish(user_channel(user_id), json.dumps(event))
    except Exception:
        logger.warning(
            "realtime_publish_user_failed",
            user_id=str(user_id),
            event_type=event.get("type"),
        )


async def publish_conversation_event(
    redis: Redis | None,
    conversation_id: UUID | str,
    event: dict[str, Any],
) -> None:
    if redis is None:
        return
    try:
        await redis.publish(conversation_channel(conversation_id), json.dumps(event))
    except Exception:
        logger.warning(
            "realtime_publish_conversation_failed",
            conversation_id=str(conversation_id),
            event_type=event.get("type"),
        )


async def publish_subscribe_control(
    redis: Redis | None,
    user_id: UUID | str,
    conversation_id: UUID | str,
) -> None:
    await publish_user_event(
        redis,
        user_id,
        {
            "type": "_sub",
            "channel": conversation_channel(conversation_id),
        },
    )
