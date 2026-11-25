from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, Header, Request, status
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession

from saath_api.auth.dependencies import Actor, current_actor, get_request_settings
from saath_api.auth.router import _client_ip
from saath_api.core.config import YamlConfigBundle
from saath_api.core.db import get_db
from saath_api.core.errors import openapi_error_responses
from saath_api.core.redis import get_redis
from saath_api.journeys.schemas import (
    DeleteJourneyResponse,
    FlightLayoutsResponse,
    JourneyHubResponse,
    JourneyListResponse,
    VerifyJourneyRequest,
    VerifyJourneyResponse,
)
from saath_api.journeys.service import (
    delete_journey_booking,
    get_journey_hub,
    list_flight_layouts,
    list_journeys,
    reverify_journey,
    verify_journey,
)
from saath_api.providers.flight.schedule import FlightScheduleProvider
from saath_api.providers.rail.router import ProviderRouter

router = APIRouter(prefix="/v1", tags=["journeys"])


def _get_yaml_configs(request: Request) -> YamlConfigBundle:
    return request.app.state.yaml_configs  # type: ignore[no-any-return]


def _get_rail_router(request: Request) -> ProviderRouter:
    return request.app.state.rail_router  # type: ignore[no-any-return]


def _get_flight_provider(request: Request) -> FlightScheduleProvider:
    return request.app.state.flight_schedule_provider  # type: ignore[no-any-return]


@router.get(
    "/flights/layouts",
    response_model=FlightLayoutsResponse,
)
async def get_v1_flight_layouts() -> FlightLayoutsResponse:
    return FlightLayoutsResponse(layouts=list_flight_layouts())


@router.post(
    "/journeys/verify",
    response_model=VerifyJourneyResponse,
    responses=openapi_error_responses(
        status.HTTP_401_UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN,
        status.HTTP_404_NOT_FOUND,
        status.HTTP_409_CONFLICT,
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        status.HTTP_429_TOO_MANY_REQUESTS,
        status.HTTP_503_SERVICE_UNAVAILABLE,
    ),
)
async def post_v1_journeys_verify(
    body: VerifyJourneyRequest,
    request: Request,
    actor: Actor = Depends(current_actor),
    db: AsyncSession = Depends(get_db),
    redis: Redis = Depends(get_redis),
    x_simulate_provider_failure: str | None = Header(default=None),
) -> VerifyJourneyResponse:
    simulate_failure = (x_simulate_provider_failure or "").strip().lower() == "true"
    return await verify_journey(
        settings=get_request_settings(request),
        yaml_configs=_get_yaml_configs(request),
        db=db,
        redis=redis,
        rail_router=_get_rail_router(request),
        flight_provider=_get_flight_provider(request),
        actor=actor,
        req=body,
        client_ip=_client_ip(request),
        simulate_provider_failure=simulate_failure,
    )


@router.get(
    "/journeys",
    response_model=JourneyListResponse,
    responses=openapi_error_responses(status.HTTP_401_UNAUTHORIZED),
)
async def get_v1_journeys(
    actor: Actor = Depends(current_actor),
    db: AsyncSession = Depends(get_db),
) -> JourneyListResponse:
    return await list_journeys(db=db, actor=actor)


@router.get(
    "/journeys/{journey_id}",
    response_model=JourneyHubResponse,
    responses=openapi_error_responses(
        status.HTTP_401_UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN,
        status.HTTP_404_NOT_FOUND,
    ),
)
async def get_v1_journey_detail(
    journey_id: UUID,
    request: Request,
    actor: Actor = Depends(current_actor),
    db: AsyncSession = Depends(get_db),
) -> JourneyHubResponse:
    return await get_journey_hub(
        db=db,
        yaml_configs=_get_yaml_configs(request),
        actor=actor,
        journey_id=journey_id,
    )


@router.post(
    "/journeys/{journey_id}/reverify",
    response_model=JourneyHubResponse,
    responses=openapi_error_responses(
        status.HTTP_401_UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN,
        status.HTTP_404_NOT_FOUND,
        status.HTTP_429_TOO_MANY_REQUESTS,
    ),
)
async def post_v1_journey_reverify(
    journey_id: UUID,
    request: Request,
    actor: Actor = Depends(current_actor),
    db: AsyncSession = Depends(get_db),
    redis: Redis = Depends(get_redis),
    x_simulate_chart_change: str | None = Header(default=None),
) -> JourneyHubResponse:
    simulate_change = (x_simulate_chart_change or "").strip().lower() == "true"
    return await reverify_journey(
        settings=get_request_settings(request),
        yaml_configs=_get_yaml_configs(request),
        db=db,
        redis=redis,
        actor=actor,
        journey_id=journey_id,
        simulate_chart_change=simulate_change,
    )


@router.delete(
    "/journeys/{journey_id}",
    response_model=DeleteJourneyResponse,
    responses=openapi_error_responses(
        status.HTTP_401_UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN,
        status.HTTP_404_NOT_FOUND,
    ),
)
async def delete_v1_journey(
    journey_id: UUID,
    actor: Actor = Depends(current_actor),
    db: AsyncSession = Depends(get_db),
) -> DeleteJourneyResponse:
    return await delete_journey_booking(db=db, actor=actor, journey_id=journey_id)
