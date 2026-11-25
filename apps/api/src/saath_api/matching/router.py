from __future__ import annotations

from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request, status
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession

from saath_api.auth.dependencies import Actor, current_actor
from saath_api.core.config import YamlConfigBundle
from saath_api.core.db import get_db
from saath_api.core.errors import openapi_error_responses
from saath_api.core.redis import get_redis
from saath_api.matching.schemas import CoachMapResponse, MatchesResponse
from saath_api.matching.service import get_coach_map, get_party_matches
from saath_api.providers.rail.router import ProviderRouter

router = APIRouter(prefix="/v1", tags=["matching"])


def _get_yaml_configs(request: Request) -> YamlConfigBundle:
    return request.app.state.yaml_configs  # type: ignore[no-any-return]


def _get_rail_router(request: Request) -> ProviderRouter:
    return request.app.state.rail_router  # type: ignore[no-any-return]


@router.get(
    "/parties/{party_id}/matches",
    response_model=MatchesResponse,
    responses=openapi_error_responses(
        status.HTTP_401_UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN,
        status.HTTP_404_NOT_FOUND,
    ),
)
async def get_v1_party_matches(
    party_id: UUID,
    request: Request,
    kind: Literal["pair", "cycle", "plan"] | None = Query(default=None),
    actor: Actor = Depends(current_actor),
    db: AsyncSession = Depends(get_db),
    redis: Redis = Depends(get_redis),
) -> MatchesResponse:
    return await get_party_matches(
        db=db,
        redis=redis,
        yaml_configs=_get_yaml_configs(request),
        actor=actor,
        party_id=party_id,
        kind=kind,
    )


@router.get(
    "/journeys/{journey_id}/coach-map",
    response_model=CoachMapResponse,
    responses=openapi_error_responses(
        status.HTTP_401_UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN,
        status.HTTP_404_NOT_FOUND,
        status.HTTP_422_UNPROCESSABLE_ENTITY,
    ),
)
async def get_v1_journey_coach_map(
    journey_id: UUID,
    request: Request,
    coach: str | None = Query(default=None),
    actor: Actor = Depends(current_actor),
    db: AsyncSession = Depends(get_db),
    redis: Redis = Depends(get_redis),
) -> CoachMapResponse:
    return await get_coach_map(
        db=db,
        redis=redis,
        rail_router=_get_rail_router(request),
        actor=actor,
        journey_id=journey_id,
        coach=coach,
    )
