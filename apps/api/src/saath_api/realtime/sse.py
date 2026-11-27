from __future__ import annotations

import asyncio
import contextlib
import json
import time
from collections.abc import AsyncIterator
from typing import Any
from uuid import UUID

from fastapi import Request, status
from fastapi.responses import StreamingResponse
from redis.asyncio import Redis
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from saath_api.auth.dependencies import Actor
from saath_api.auth.models import User
from saath_api.core.errors import ProblemDetailError
from saath_api.messaging.models import ConversationMember
from saath_api.realtime.pubsub import anon_channel, conversation_channel, user_channel


async def create_sse_response(
    *,
    request: Request,
    actor: Actor,
    db: AsyncSession,
    redis: Redis,
) -> StreamingResponse:
    channels: list[str] = []
    if actor.kind == "user" and actor.user_id is not None:
        user_status = (
            await db.execute(select(User.status).where(User.id == actor.user_id))
        ).scalar_one_or_none()
        if user_status is None:
            raise ProblemDetailError(
                status_code=status.HTTP_401_UNAUTHORIZED,
                code="user_not_found",
                title="Account Not Found",
                detail="Authenticated user account no longer exists.",
            )
        if user_status in ("banned", "deleted"):
            raise ProblemDetailError(
                status_code=status.HTTP_403_FORBIDDEN,
                code="account_disabled",
                title="Account Disabled",
                detail="This account is not permitted to perform this action.",
            )
        convo_ids = list(
            (
                await db.execute(
                    select(ConversationMember.conversation_id).where(
                        ConversationMember.user_id == actor.user_id
                    )
                )
            )
            .scalars()
            .all()
        )
        channels.append(user_channel(actor.user_id))
        channels.extend(conversation_channel(cid) for cid in convo_ids)
    elif actor.kind == "anon" and actor.anon_id is not None:
        channels.append(anon_channel(actor.anon_id))
    else:
        raise ProblemDetailError(
            status_code=status.HTTP_403_FORBIDDEN,
            code="forbidden",
            title="Forbidden",
            detail="Unsupported actor kind for event stream.",
        )

    session_factory = request.app.state.session_factory
    pubsub = redis.pubsub()
    await pubsub.subscribe(*channels)

    async def _event_generator() -> AsyncIterator[str]:
        # Flush initial bytes immediately so fetch() resolves HTTP 200 right away
        yield ": connected\n\n"
        last_keepalive = time.monotonic()
        try:
            while True:
                if await request.is_disconnected():
                    break
                msg = await pubsub.get_message(ignore_subscribe_messages=True, timeout=0.25)
                if msg is not None:
                    raw_data = msg.get("data")
                    if isinstance(raw_data, bytes):
                        raw_data = raw_data.decode("utf-8", errors="ignore")
                    payload: Any = None
                    if isinstance(raw_data, str):
                        with contextlib.suppress(json.JSONDecodeError):
                            payload = json.loads(raw_data)
                    elif isinstance(raw_data, dict):
                        payload = raw_data

                    if isinstance(payload, dict):
                        if payload.get("type") == "_sub":
                            chan = payload.get("channel")
                            if (
                                isinstance(chan, str)
                                and chan.startswith("conversation:")
                                and actor.user_id is not None
                            ):
                                raw_cid = chan.split("conversation:", 1)[1]
                                with contextlib.suppress(ValueError):
                                    cid = UUID(raw_cid)
                                    async with session_factory() as check_db:
                                        row = (
                                            await check_db.execute(
                                                select(ConversationMember.conversation_id).where(
                                                    ConversationMember.conversation_id == cid,
                                                    ConversationMember.user_id == actor.user_id,
                                                )
                                            )
                                        ).first()
                                    if row is not None:
                                        await pubsub.subscribe(chan)
                            continue
                        evt_type = str(payload.get("type") or "message")
                        yield f"event: {evt_type}\ndata: {json.dumps(payload)}\n\n"
                        last_keepalive = time.monotonic()
                        continue

                now = time.monotonic()
                if now - last_keepalive >= 15.0:
                    yield ": keepalive\n\n"
                    last_keepalive = now
                else:
                    await asyncio.sleep(0.05)
        finally:
            with contextlib.suppress(Exception):
                await pubsub.unsubscribe()
            # redis-py's PubSub.aclose() is unannotated.
            with contextlib.suppress(Exception):
                await pubsub.aclose()  # type: ignore[no-untyped-call]

    return StreamingResponse(
        _event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
