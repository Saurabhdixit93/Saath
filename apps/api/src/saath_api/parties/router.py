from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, Request, status
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession

from saath_api.auth.dependencies import Actor, current_actor, get_request_settings
from saath_api.auth.router import _client_ip
from saath_api.core.config import YamlConfigBundle
from saath_api.core.db import get_db
from saath_api.core.errors import openapi_error_responses
from saath_api.core.redis import get_redis
from saath_api.journeys.schemas import JourneyHubResponse
from saath_api.parties.schemas import (
    DeleteGoalResponse,
    GoalMutationResponse,
    OrganiserSummaryResponse,
    PartyInviteResponse,
    PartyJoinRequest,
    PutGoalRequest,
)
from saath_api.parties.service import (
    create_party_invite,
    delete_party_goal,
    get_organiser_summary,
    join_party_via_invite,
    put_party_goal,
    remove_party_member,
)
from saath_api.providers.flight.schedule import FlightScheduleProvider
from saath_api.providers.rail.router import ProviderRouter

router = APIRouter(prefix="/v1", tags=["parties"])


def _get_yaml_configs(request: Request) -> YamlConfigBundle:
    return request.app.state.yaml_configs  # type: ignore[no-any-return]


def _get_rail_router(request: Request) -> ProviderRouter:
    return request.app.state.rail_router  # type: ignore[no-any-return]


def _get_flight_provider(request: Request) -> FlightScheduleProvider:
    return request.app.state.flight_schedule_provider  # type: ignore[no-any-return]


@router.post(
    "/journeys/{journey_id}/party/invite",
    response_model=PartyInviteResponse,
    responses=openapi_error_responses(
        status.HTTP_401_UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN,
        status.HTTP_404_NOT_FOUND,
    ),
)
async def post_v1_party_invite(
    journey_id: UUID,
    request: Request,
    actor: Actor = Depends(current_actor),
    db: AsyncSession = Depends(get_db),
) -> PartyInviteResponse:
    return await create_party_invite(
        settings=get_request_settings(request),
        db=db,
        actor=actor,
        journey_id=journey_id,
    )


@router.post(
    "/party/join",
    response_model=JourneyHubResponse,
    responses=openapi_error_responses(
        status.HTTP_401_UNAUTHORIZED,
        status.HTTP_402_PAYMENT_REQUIRED,
        status.HTTP_403_FORBIDDEN,
        status.HTTP_404_NOT_FOUND,
        status.HTTP_409_CONFLICT,
        status.HTTP_410_GONE,
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        status.HTTP_429_TOO_MANY_REQUESTS,
        status.HTTP_503_SERVICE_UNAVAILABLE,
    ),
)
async def post_v1_party_join(
    body: PartyJoinRequest,
    request: Request,
    actor: Actor = Depends(current_actor),
    db: AsyncSession = Depends(get_db),
    redis: Redis = Depends(get_redis),
) -> JourneyHubResponse:
    return await join_party_via_invite(
        settings=get_request_settings(request),
        yaml_configs=_get_yaml_configs(request),
        db=db,
        redis=redis,
        rail_router=_get_rail_router(request),
        flight_provider=_get_flight_provider(request),
        actor=actor,
        req=body,
        client_ip=_client_ip(request),
    )


@router.delete(
    "/party/{party_id}/members/{seat_holder_id}",
    response_model=JourneyHubResponse,
    responses=openapi_error_responses(
        status.HTTP_401_UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN,
        status.HTTP_404_NOT_FOUND,
        status.HTTP_422_UNPROCESSABLE_ENTITY,
    ),
)
async def delete_v1_party_member(
    party_id: UUID,
    seat_holder_id: UUID,
    request: Request,
    actor: Actor = Depends(current_actor),
    db: AsyncSession = Depends(get_db),
    redis: Redis = Depends(get_redis),
) -> JourneyHubResponse:
    return await remove_party_member(
        yaml_configs=_get_yaml_configs(request),
        db=db,
        redis=redis,
        actor=actor,
        party_id=party_id,
        seat_holder_id=seat_holder_id,
    )


@router.put(
    "/parties/{party_id}/goal",
    response_model=GoalMutationResponse,
    responses=openapi_error_responses(
        status.HTTP_401_UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN,
        status.HTTP_404_NOT_FOUND,
        status.HTTP_422_UNPROCESSABLE_ENTITY,
    ),
)
async def put_v1_party_goal(
    party_id: UUID,
    body: PutGoalRequest,
    actor: Actor = Depends(current_actor),
    db: AsyncSession = Depends(get_db),
    redis: Redis = Depends(get_redis),
) -> GoalMutationResponse:
    return await put_party_goal(
        db=db, redis=redis, actor=actor, party_id=party_id, req=body
    )


@router.delete(
    "/parties/{party_id}/goal",
    response_model=DeleteGoalResponse,
    responses=openapi_error_responses(
        status.HTTP_401_UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN,
        status.HTTP_404_NOT_FOUND,
    ),
)
async def delete_v1_party_goal(
    party_id: UUID,
    actor: Actor = Depends(current_actor),
    db: AsyncSession = Depends(get_db),
    redis: Redis = Depends(get_redis),
) -> DeleteGoalResponse:
    return await delete_party_goal(db=db, redis=redis, actor=actor, party_id=party_id)


@router.get(
    "/parties/{party_id}/organiser-summary",
    response_model=OrganiserSummaryResponse,
    responses=openapi_error_responses(
        status.HTTP_401_UNAUTHORIZED,
        status.HTTP_402_PAYMENT_REQUIRED,
        status.HTTP_403_FORBIDDEN,
        status.HTTP_404_NOT_FOUND,
    ),
)
async def get_v1_party_organiser_summary(
    party_id: UUID,
    request: Request,
    actor: Actor = Depends(current_actor),
    db: AsyncSession = Depends(get_db),
) -> OrganiserSummaryResponse:
    return await get_organiser_summary(
        yaml_configs=_get_yaml_configs(request),
        db=db,
        actor=actor,
        party_id=party_id,
    )
