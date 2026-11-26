from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request, status
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession

from saath_api.auth.dependencies import Actor, get_request_settings, require_user_actor
from saath_api.core.config import YamlConfigBundle
from saath_api.core.db import get_db
from saath_api.core.errors import openapi_error_responses
from saath_api.core.redis import get_redis
from saath_api.messaging.schemas import (
    BlockUserRequest,
    BlockUserResponse,
    ConversationDTO,
    ConversationListResponse,
    CreateConversationRequest,
    CreateReportRequest,
    CreateReportResponse,
    MessageDTO,
    MessagesResponse,
    SendMessageRequest,
    TranslateMessageRequest,
    TranslateMessageResponse,
)
from saath_api.messaging.service import (
    block_user_by_alias_ref,
    create_or_get_conversation,
    create_report,
    list_conversations,
    list_messages,
    send_message,
    translate_message,
)
from saath_api.providers.llm import LLMProvider

router = APIRouter(prefix="/v1", tags=["messaging"])


def _get_yaml_configs(request: Request) -> YamlConfigBundle:
    return request.app.state.yaml_configs  # type: ignore[no-any-return]


def _get_llm_provider(request: Request) -> LLMProvider:
    return request.app.state.llm_provider  # type: ignore[no-any-return]


@router.get(
    "/conversations",
    response_model=ConversationListResponse,
    responses=openapi_error_responses(
        status.HTTP_401_UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN,
    ),
)
async def get_v1_conversations(
    actor: Actor = Depends(require_user_actor),
    db: AsyncSession = Depends(get_db),
) -> ConversationListResponse:
    return await list_conversations(db=db, actor=actor)


@router.post(
    "/conversations",
    response_model=ConversationDTO,
    responses=openapi_error_responses(
        status.HTTP_401_UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN,
        status.HTTP_404_NOT_FOUND,
        status.HTTP_409_CONFLICT,
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        status.HTTP_429_TOO_MANY_REQUESTS,
    ),
)
async def post_v1_conversations(
    body: CreateConversationRequest,
    request: Request,
    actor: Actor = Depends(require_user_actor),
    db: AsyncSession = Depends(get_db),
    redis: Redis = Depends(get_redis),
) -> ConversationDTO:
    return await create_or_get_conversation(
        settings=get_request_settings(request),
        yaml_configs=_get_yaml_configs(request),
        db=db,
        redis=redis,
        actor=actor,
        card_id=body.card_id,
    )


@router.get(
    "/conversations/{conversation_id}/messages",
    response_model=MessagesResponse,
    responses=openapi_error_responses(
        status.HTTP_401_UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN,
        status.HTTP_404_NOT_FOUND,
    ),
)
async def get_v1_conversation_messages(
    conversation_id: UUID,
    before: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=100),
    actor: Actor = Depends(require_user_actor),
    db: AsyncSession = Depends(get_db),
) -> MessagesResponse:
    return await list_messages(
        db=db,
        actor=actor,
        conversation_id=conversation_id,
        before=before,
        limit=limit,
    )


@router.post(
    "/conversations/{conversation_id}/messages",
    response_model=MessageDTO,
    responses=openapi_error_responses(
        status.HTTP_401_UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN,
        status.HTTP_404_NOT_FOUND,
        status.HTTP_422_UNPROCESSABLE_ENTITY,
    ),
)
async def post_v1_conversation_messages(
    conversation_id: UUID,
    body: SendMessageRequest,
    request: Request,
    actor: Actor = Depends(require_user_actor),
    db: AsyncSession = Depends(get_db),
    redis: Redis = Depends(get_redis),
) -> MessageDTO:
    return await send_message(
        db=db,
        redis=redis,
        llm_provider=_get_llm_provider(request),
        actor=actor,
        conversation_id=conversation_id,
        req=body,
    )


@router.post(
    "/conversations/{conversation_id}/translate",
    response_model=TranslateMessageResponse,
    responses=openapi_error_responses(
        status.HTTP_401_UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN,
        status.HTTP_404_NOT_FOUND,
        status.HTTP_422_UNPROCESSABLE_ENTITY,
    ),
)
async def post_v1_conversation_translate(
    conversation_id: UUID,
    body: TranslateMessageRequest,
    request: Request,
    actor: Actor = Depends(require_user_actor),
    db: AsyncSession = Depends(get_db),
) -> TranslateMessageResponse:
    return await translate_message(
        db=db,
        llm_provider=_get_llm_provider(request),
        actor=actor,
        conversation_id=conversation_id,
        req=body,
    )


@router.post(
    "/users/block",
    response_model=BlockUserResponse,
    responses=openapi_error_responses(
        status.HTTP_401_UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN,
        status.HTTP_404_NOT_FOUND,
        status.HTTP_409_CONFLICT,
        status.HTTP_422_UNPROCESSABLE_ENTITY,
    ),
)
async def post_v1_users_block(
    body: BlockUserRequest,
    request: Request,
    actor: Actor = Depends(require_user_actor),
    db: AsyncSession = Depends(get_db),
    redis: Redis = Depends(get_redis),
) -> BlockUserResponse:
    return await block_user_by_alias_ref(
        settings=get_request_settings(request),
        db=db,
        redis=redis,
        actor=actor,
        alias_ref=body.alias_ref,
        arq_pool=getattr(request.app.state, "arq_pool", None),
    )


@router.post(
    "/reports",
    response_model=CreateReportResponse,
    responses=openapi_error_responses(
        status.HTTP_401_UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN,
        status.HTTP_404_NOT_FOUND,
        status.HTTP_422_UNPROCESSABLE_ENTITY,
    ),
)
async def post_v1_reports(
    body: CreateReportRequest,
    actor: Actor = Depends(require_user_actor),
    db: AsyncSession = Depends(get_db),
) -> CreateReportResponse:
    return await create_report(db=db, actor=actor, req=body)
