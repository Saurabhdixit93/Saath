from __future__ import annotations

from typing import cast

from fastapi import APIRouter, Depends, Request, status
from fastapi.responses import StreamingResponse
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession

from saath_api.ai.schemas import ConciergeRequest, DraftRequestBody, DraftRequestResponse
from saath_api.ai.service import create_concierge_stream_response, draft_swap_request
from saath_api.auth.dependencies import Actor, require_user_actor
from saath_api.core.config import YamlConfigBundle
from saath_api.core.db import get_db
from saath_api.core.errors import openapi_error_responses
from saath_api.core.redis import get_redis
from saath_api.providers.llm import LLMProvider

router = APIRouter(prefix="/v1", tags=["ai"])


def _get_yaml_configs(request: Request) -> YamlConfigBundle:
    return cast(YamlConfigBundle, request.app.state.yaml_configs)


def _get_llm_provider(request: Request) -> LLMProvider:
    return cast(LLMProvider, request.app.state.llm_provider)


@router.post(
    "/ai/concierge",
    responses={
        200: {
            "description": "Server-Sent Events stream of proposal, explanation, message, and done",
            "content": {"text/event-stream": {"schema": {"type": "string"}}},
        },
        **openapi_error_responses(
            status.HTTP_401_UNAUTHORIZED,
            status.HTTP_403_FORBIDDEN,
            status.HTTP_404_NOT_FOUND,
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            status.HTTP_429_TOO_MANY_REQUESTS,
            status.HTTP_503_SERVICE_UNAVAILABLE,
        ),
    },
)
async def post_v1_ai_concierge(
    body: ConciergeRequest,
    request: Request,
    actor: Actor = Depends(require_user_actor),
    db: AsyncSession = Depends(get_db),
    redis: Redis = Depends(get_redis),
) -> StreamingResponse:
    return await create_concierge_stream_response(
        db=db,
        session_factory=request.app.state.session_factory,
        redis=redis,
        yaml_configs=_get_yaml_configs(request),
        llm_provider=_get_llm_provider(request),
        actor=actor,
        req=body,
    )


@router.post(
    "/ai/draft-request",
    response_model=DraftRequestResponse,
    responses=openapi_error_responses(
        status.HTTP_401_UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN,
        status.HTTP_404_NOT_FOUND,
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        status.HTTP_429_TOO_MANY_REQUESTS,
        status.HTTP_503_SERVICE_UNAVAILABLE,
    ),
)
async def post_v1_ai_draft_request(
    body: DraftRequestBody,
    request: Request,
    actor: Actor = Depends(require_user_actor),
    db: AsyncSession = Depends(get_db),
    redis: Redis = Depends(get_redis),
) -> DraftRequestResponse:
    return await draft_swap_request(
        db=db,
        redis=redis,
        yaml_configs=_get_yaml_configs(request),
        llm_provider=_get_llm_provider(request),
        actor=actor,
        req=body,
    )
