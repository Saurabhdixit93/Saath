from __future__ import annotations

import asyncio
import contextlib
import json
from typing import Any
from uuid import UUID

import structlog
from fastapi import WebSocket, WebSocketDisconnect
from redis.asyncio import Redis
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from saath_api.auth.dependencies import Actor, _parse_actor_from_token
from saath_api.auth.models import User
from saath_api.core.config import Settings
from saath_api.core.errors import ProblemDetailError
from saath_api.matching.models import Block
from saath_api.messaging.models import ConversationMember
from saath_api.realtime.presence import clear_presence, touch_presence
from saath_api.realtime.pubsub import (
    anon_channel,
    conversation_channel,
    publish_conversation_event,
    user_channel,
)

logger = structlog.get_logger(__name__)


async def _load_user_status_and_convos(
    session_factory: async_sessionmaker[AsyncSession],
    user_id: UUID,
) -> tuple[str | None, list[UUID]]:
    async with session_factory() as db:
        status_val = (
            await db.execute(select(User.status).where(User.id == user_id))
        ).scalar_one_or_none()
        if status_val in (None, "banned", "deleted"):
            return status_val, []
        convo_ids = list(
            (
                await db.execute(
                    select(ConversationMember.conversation_id).where(
                        ConversationMember.user_id == user_id
                    )
                )
            )
            .scalars()
            .all()
        )
        return status_val, convo_ids


async def _verify_convo_membership_and_not_blocked(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    user_id: UUID,
    conversation_id: UUID,
) -> str | None:
    async with session_factory() as db:
        members = list(
            (
                await db.execute(
                    select(ConversationMember).where(
                        ConversationMember.conversation_id == conversation_id
                    )
                )
            )
            .scalars()
            .all()
        )
        me = next((m for m in members if m.user_id == user_id), None)
        if me is None:
            return None
        other_ids = [m.user_id for m in members if m.user_id != user_id]
        if other_ids:
            blocked_row = (
                await db.execute(
                    select(Block.blocker).where(
                        ((Block.blocker == user_id) & Block.blocked.in_(other_ids))
                        | ((Block.blocked == user_id) & Block.blocker.in_(other_ids))
                    )
                )
            ).first()
            if blocked_row is not None:
                return None
        return me.alias


async def _is_convo_member(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    user_id: UUID,
    conversation_id: UUID,
) -> bool:
    async with session_factory() as db:
        row = (
            await db.execute(
                select(ConversationMember.conversation_id).where(
                    ConversationMember.conversation_id == conversation_id,
                    ConversationMember.user_id == user_id,
                )
            )
        ).first()
        return row is not None


async def handle_websocket(websocket: WebSocket) -> None:
    settings: Settings = websocket.app.state.settings
    redis: Redis = websocket.app.state.redis
    session_factory: async_sessionmaker[AsyncSession] = websocket.app.state.session_factory

    await websocket.accept()

    try:
        raw_auth = await asyncio.wait_for(websocket.receive_text(), timeout=10.0)
        auth_frame = json.loads(raw_auth)
    except (TimeoutError, WebSocketDisconnect, json.JSONDecodeError, ValueError):
        with contextlib.suppress(Exception):
            await websocket.close(code=1008, reason="auth_frame_required")
        return

    if not isinstance(auth_frame, dict) or auth_frame.get("type") != "auth":
        with contextlib.suppress(Exception):
            await websocket.close(code=1008, reason="auth_frame_required")
        return

    token = auth_frame.get("token")
    if not isinstance(token, str) or not token.strip():
        with contextlib.suppress(Exception):
            await websocket.close(code=1008, reason="auth_frame_required")
        return

    try:
        actor: Actor = _parse_actor_from_token(token.strip(), settings)
    except ProblemDetailError:
        with contextlib.suppress(Exception):
            await websocket.close(code=4001, reason="unauthorized")
        return

    channels: list[str] = []
    if actor.kind == "user" and actor.user_id is not None:
        user_status, convo_ids = await _load_user_status_and_convos(session_factory, actor.user_id)
        if user_status in (None, "banned", "deleted"):
            with contextlib.suppress(Exception):
                await websocket.close(code=4001, reason="unauthorized")
            return
        channels.append(user_channel(actor.user_id))
        channels.extend(conversation_channel(cid) for cid in convo_ids)
        await touch_presence(redis, actor.user_id)
    elif actor.kind == "anon" and actor.anon_id is not None:
        channels.append(anon_channel(actor.anon_id))
    else:
        with contextlib.suppress(Exception):
            await websocket.close(code=4001, reason="unauthorized")
        return

    pubsub = redis.pubsub()
    await pubsub.subscribe(*channels)
    await websocket.send_json({"type": "ready"})

    stop_event = asyncio.Event()

    async def _pump_redis() -> None:
        while not stop_event.is_set():
            msg = await pubsub.get_message(ignore_subscribe_messages=True, timeout=0.2)
            if msg is None:
                await asyncio.sleep(0.05)
                continue
            raw_data = msg.get("data")
            if raw_data is None:
                continue
            if isinstance(raw_data, bytes):
                raw_data = raw_data.decode("utf-8", errors="ignore")
            try:
                payload: Any = json.loads(raw_data) if isinstance(raw_data, str) else raw_data
            except json.JSONDecodeError:
                continue
            if not isinstance(payload, dict):
                continue
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
                        if await _is_convo_member(
                            session_factory, user_id=actor.user_id, conversation_id=cid
                        ):
                            await pubsub.subscribe(chan)
                continue
            await websocket.send_json(payload)

    async def _read_client() -> None:
        while not stop_event.is_set():
            raw_text = await websocket.receive_text()
            try:
                frame = json.loads(raw_text)
            except json.JSONDecodeError:
                continue
            if not isinstance(frame, dict):
                continue
            ftype = frame.get("type")
            if ftype == "ping":
                if actor.user_id is not None:
                    await touch_presence(redis, actor.user_id)
                await websocket.send_json({"type": "pong"})
            elif ftype == "typing" and actor.kind == "user" and actor.user_id is not None:
                raw_cid = frame.get("conversation_id")
                if isinstance(raw_cid, str):
                    with contextlib.suppress(ValueError):
                        cid = UUID(raw_cid)
                        my_alias = await _verify_convo_membership_and_not_blocked(
                            session_factory,
                            user_id=actor.user_id,
                            conversation_id=cid,
                        )
                        if my_alias is not None:
                            await publish_conversation_event(
                                redis,
                                cid,
                                {
                                    "type": "typing",
                                    "conversation_id": str(cid),
                                    "alias": my_alias,
                                },
                            )
            elif ftype == "subscribe" and actor.kind == "user" and actor.user_id is not None:
                raw_cid = frame.get("conversation_id")
                if isinstance(raw_cid, str):
                    with contextlib.suppress(ValueError):
                        cid = UUID(raw_cid)
                        if await _is_convo_member(
                            session_factory, user_id=actor.user_id, conversation_id=cid
                        ):
                            await pubsub.subscribe(conversation_channel(cid))

    pump_task = asyncio.create_task(_pump_redis())
    reader_task = asyncio.create_task(_read_client())
    try:
        done, pending = await asyncio.wait(
            {pump_task, reader_task},
            return_when=asyncio.FIRST_COMPLETED,
        )
        stop_event.set()
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        for task in done:
            with contextlib.suppress(WebSocketDisconnect, asyncio.CancelledError):
                exc = task.exception()
                if exc is not None and not isinstance(exc, WebSocketDisconnect):
                    logger.debug("ws_task_ended", error=str(exc))
    except WebSocketDisconnect:
        pass
    finally:
        stop_event.set()
        for task in (pump_task, reader_task):
            if not task.done():
                task.cancel()
        with contextlib.suppress(Exception):
            await pubsub.unsubscribe()
        # redis-py's PubSub.aclose() is unannotated.
        with contextlib.suppress(Exception):
            await pubsub.aclose()  # type: ignore[no-untyped-call]
        if actor.kind == "user" and actor.user_id is not None:
            await clear_presence(redis, actor.user_id)
