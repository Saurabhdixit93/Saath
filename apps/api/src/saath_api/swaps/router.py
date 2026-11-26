from __future__ import annotations

from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request, Response, status
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession

from saath_api.auth.dependencies import Actor, current_actor, get_request_settings
from saath_api.core.config import YamlConfigBundle
from saath_api.core.db import get_db
from saath_api.core.errors import openapi_error_responses
from saath_api.core.redis import get_redis
from saath_api.swaps.cards import render_swap_card_png, render_swap_card_svg
from saath_api.swaps.schemas import (
    AcceptSwapRequest,
    ConfirmCompletionRequest,
    CreateSwapRequest,
    DeclineSwapRequest,
    PublicSwapCardVerifyResponse,
    SwapCardJsonResponse,
    SwapDetailDTO,
    SwapListResponse,
)
from saath_api.swaps.service import (
    accept_swap,
    cancel_swap,
    confirm_completion,
    create_swap_proposal,
    decline_swap,
    get_swap_card_payload,
    get_swap_detail,
    list_swaps,
    verify_public_swap_card,
)

router = APIRouter(prefix="/v1", tags=["swaps"])


def _get_yaml_configs(request: Request) -> YamlConfigBundle:
    return request.app.state.yaml_configs  # type: ignore[no-any-return]


@router.post(
    "/swaps",
    response_model=SwapDetailDTO,
    status_code=status.HTTP_201_CREATED,
    responses=openapi_error_responses(
        status.HTTP_401_UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN,
        status.HTTP_404_NOT_FOUND,
        status.HTTP_409_CONFLICT,
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        status.HTTP_429_TOO_MANY_REQUESTS,
    ),
)
async def post_v1_swaps(
    body: CreateSwapRequest,
    request: Request,
    actor: Actor = Depends(current_actor),
    db: AsyncSession = Depends(get_db),
    redis: Redis = Depends(get_redis),
) -> SwapDetailDTO:
    return await create_swap_proposal(
        yaml_configs=_get_yaml_configs(request),
        db=db,
        redis=redis,
        actor=actor,
        req=body,
    )


@router.get(
    "/swaps",
    response_model=SwapListResponse,
    responses=openapi_error_responses(status.HTTP_401_UNAUTHORIZED),
)
async def get_v1_swaps(
    state: Literal["active", "past", "all"] = Query(default="active"),
    actor: Actor = Depends(current_actor),
    db: AsyncSession = Depends(get_db),
) -> SwapListResponse:
    return await list_swaps(db=db, actor=actor, state=state)


@router.get(
    "/swaps/{swap_id}",
    response_model=SwapDetailDTO,
    responses=openapi_error_responses(
        status.HTTP_401_UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN,
        status.HTTP_404_NOT_FOUND,
    ),
)
async def get_v1_swap_detail(
    swap_id: UUID,
    actor: Actor = Depends(current_actor),
    db: AsyncSession = Depends(get_db),
) -> SwapDetailDTO:
    return await get_swap_detail(db=db, actor=actor, swap_id=swap_id)


@router.post(
    "/swaps/{swap_id}/accept",
    response_model=SwapDetailDTO,
    responses=openapi_error_responses(
        status.HTTP_401_UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN,
        status.HTTP_404_NOT_FOUND,
        status.HTTP_409_CONFLICT,
    ),
)
async def post_v1_swap_accept(
    swap_id: UUID,
    body: AcceptSwapRequest,
    request: Request,
    actor: Actor = Depends(current_actor),
    db: AsyncSession = Depends(get_db),
    redis: Redis = Depends(get_redis),
) -> SwapDetailDTO:
    return await accept_swap(
        settings=get_request_settings(request),
        db=db,
        redis=redis,
        actor=actor,
        swap_id=swap_id,
        req=body,
    )


@router.post(
    "/swaps/{swap_id}/decline",
    response_model=SwapDetailDTO,
    responses=openapi_error_responses(
        status.HTTP_401_UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN,
        status.HTTP_404_NOT_FOUND,
        status.HTTP_409_CONFLICT,
    ),
)
async def post_v1_swap_decline(
    swap_id: UUID,
    body: DeclineSwapRequest,
    request: Request,
    actor: Actor = Depends(current_actor),
    db: AsyncSession = Depends(get_db),
    redis: Redis = Depends(get_redis),
) -> SwapDetailDTO:
    return await decline_swap(
        db=db,
        redis=redis,
        actor=actor,
        swap_id=swap_id,
        req=body,
        arq_pool=getattr(request.app.state, "arq_pool", None),
        settings=get_request_settings(request),
    )


@router.post(
    "/swaps/{swap_id}/cancel",
    response_model=SwapDetailDTO,
    responses=openapi_error_responses(
        status.HTTP_401_UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN,
        status.HTTP_404_NOT_FOUND,
        status.HTTP_409_CONFLICT,
    ),
)
async def post_v1_swap_cancel(
    swap_id: UUID,
    request: Request,
    actor: Actor = Depends(current_actor),
    db: AsyncSession = Depends(get_db),
    redis: Redis = Depends(get_redis),
) -> SwapDetailDTO:
    return await cancel_swap(
        db=db,
        redis=redis,
        actor=actor,
        swap_id=swap_id,
        arq_pool=getattr(request.app.state, "arq_pool", None),
        settings=get_request_settings(request),
    )


@router.post(
    "/swaps/{swap_id}/confirm-completion",
    response_model=SwapDetailDTO,
    responses=openapi_error_responses(
        status.HTTP_401_UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN,
        status.HTTP_404_NOT_FOUND,
        status.HTTP_409_CONFLICT,
        status.HTTP_422_UNPROCESSABLE_ENTITY,
    ),
)
async def post_v1_swap_confirm_completion(
    swap_id: UUID,
    body: ConfirmCompletionRequest,
    actor: Actor = Depends(current_actor),
    db: AsyncSession = Depends(get_db),
    redis: Redis = Depends(get_redis),
) -> SwapDetailDTO:
    return await confirm_completion(
        db=db,
        redis=redis,
        actor=actor,
        swap_id=swap_id,
        req=body,
    )


@router.get(
    "/swaps/{swap_id}/card",
    response_model=SwapCardJsonResponse,
    responses=openapi_error_responses(
        status.HTTP_401_UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN,
        status.HTTP_404_NOT_FOUND,
        status.HTTP_409_CONFLICT,
    ),
)
async def get_v1_swap_card(
    swap_id: UUID,
    request: Request,
    format: Literal["json", "svg", "png"] = Query(default="json"),
    actor: Actor = Depends(current_actor),
    db: AsyncSession = Depends(get_db),
) -> SwapCardJsonResponse | Response:
    dto, render_payload, qr_url = await get_swap_card_payload(
        settings=get_request_settings(request),
        db=db,
        actor=actor,
        swap_id=swap_id,
    )
    if format == "svg":
        svg = render_swap_card_svg(render_payload, qr_url)
        return Response(content=svg, media_type="image/svg+xml")
    if format == "png":
        png = render_swap_card_png(render_payload, qr_url)
        return Response(
            content=png,
            media_type="image/png",
            headers={
                "Content-Disposition": f'attachment; filename="saath-swap-{dto.public_code}.png"'
            },
        )
    return dto


@router.get(
    "/public/swap-cards/{code}",
    response_model=PublicSwapCardVerifyResponse,
    responses=openapi_error_responses(
        status.HTTP_404_NOT_FOUND,
        status.HTTP_422_UNPROCESSABLE_ENTITY,
    ),
)
async def get_v1_public_swap_card(
    code: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> PublicSwapCardVerifyResponse:
    return await verify_public_swap_card(
        settings=get_request_settings(request),
        db=db,
        code=code,
    )
