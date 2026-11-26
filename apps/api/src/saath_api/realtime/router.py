from __future__ import annotations

from fastapi import APIRouter, Depends, Request, WebSocket, status
from fastapi.responses import StreamingResponse
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession

from saath_api.auth.dependencies import Actor, current_actor
from saath_api.core.db import get_db
from saath_api.core.errors import openapi_error_responses
from saath_api.core.redis import get_redis
from saath_api.realtime.sse import create_sse_response
from saath_api.realtime.ws import handle_websocket

router = APIRouter(prefix="/v1", tags=["realtime"])


@router.websocket("/ws")
async def ws_endpoint(websocket: WebSocket) -> None:
    await handle_websocket(websocket)


@router.get(
    "/events/stream",
    responses=openapi_error_responses(
        status.HTTP_401_UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN,
    ),
)
async def sse_events_stream(
    request: Request,
    actor: Actor = Depends(current_actor),
    db: AsyncSession = Depends(get_db),
    redis: Redis = Depends(get_redis),
) -> StreamingResponse:
    return await create_sse_response(
        request=request,
        actor=actor,
        db=db,
        redis=redis,
    )
