from __future__ import annotations

from datetime import date
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from saath_api.auth.dependencies import Actor, current_actor, get_request_settings
from saath_api.core.config import YamlConfigBundle
from saath_api.core.db import get_db
from saath_api.core.errors import openapi_error_responses
from saath_api.journeys.schemas import PublicChartTimeResponse
from saath_api.providers.rail.router import ProviderRouter
from saath_api.public.schemas import (
    CreateSeatInviteRequest,
    PublicFlightLayoutsResponse,
    PublicPnrStatusResponse,
    PublicSeatInviteResponse,
    PublicStatsResponse,
    PublicTrainCompositionResponse,
    PublicTrainLiveResponse,
    SeatInviteResponse,
)
from saath_api.public.service import (
    create_seat_invite,
    get_public_flight_layouts,
    get_public_pnr_status,
    get_public_seat_invite,
    get_public_stats,
    get_public_train_chart_time,
    get_public_train_composition,
    get_public_train_live,
)

router = APIRouter(prefix="/v1", tags=["public"])


def _get_yaml_configs(request: Request) -> YamlConfigBundle:
    return request.app.state.yaml_configs  # type: ignore[no-any-return]


def _get_rail_router(request: Request) -> ProviderRouter:
    return request.app.state.rail_router  # type: ignore[no-any-return]


@router.post(
    "/journeys/{journey_id}/invite-seat",
    response_model=SeatInviteResponse,
    status_code=status.HTTP_201_CREATED,
    tags=["journeys"],
    responses=openapi_error_responses(
        status.HTTP_401_UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN,
        status.HTTP_404_NOT_FOUND,
        status.HTTP_422_UNPROCESSABLE_ENTITY,
    ),
)
async def post_v1_journey_invite_seat(
    journey_id: UUID,
    body: CreateSeatInviteRequest,
    request: Request,
    actor: Actor = Depends(current_actor),
    db: AsyncSession = Depends(get_db),
) -> SeatInviteResponse:
    return await create_seat_invite(
        settings=get_request_settings(request),
        db=db,
        actor=actor,
        journey_id=journey_id,
        req=body,
    )


@router.get(
    "/public/invites/{token}",
    response_model=PublicSeatInviteResponse,
    responses=openapi_error_responses(
        status.HTTP_404_NOT_FOUND,
        status.HTTP_410_GONE,
    ),
)
async def get_v1_public_invite(
    token: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> PublicSeatInviteResponse:
    return await get_public_seat_invite(
        settings=get_request_settings(request),
        db=db,
        token=token,
    )


@router.get(
    "/public/pnr-status/{pnr}",
    response_model=PublicPnrStatusResponse,
    responses=openapi_error_responses(
        status.HTTP_404_NOT_FOUND,
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        status.HTTP_503_SERVICE_UNAVAILABLE,
    ),
)
async def get_v1_public_pnr_status(
    pnr: str,
    request: Request,
    response: Response,
) -> PublicPnrStatusResponse:
    result = await get_public_pnr_status(
        pnr=pnr,
        rail_router=_get_rail_router(request),
        yaml_configs=_get_yaml_configs(request),
    )
    response.headers["Cache-Control"] = "public, max-age=60, s-maxage=60"
    return result


@router.get(
    "/public/train/{train_no}/live",
    response_model=PublicTrainLiveResponse,
    responses=openapi_error_responses(
        status.HTTP_404_NOT_FOUND,
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        status.HTTP_503_SERVICE_UNAVAILABLE,
    ),
)
async def get_v1_public_train_live(
    train_no: str,
    request: Request,
    response: Response,
    date_param: date | None = Query(default=None, alias="date"),
) -> PublicTrainLiveResponse:
    target_date = date_param or date.today()
    result = await get_public_train_live(
        train_no=train_no,
        service_date=target_date,
        rail_router=_get_rail_router(request),
        yaml_configs=_get_yaml_configs(request),
    )
    response.headers["Cache-Control"] = "public, max-age=60, s-maxage=60"
    return result


@router.get(
    "/public/train/{train_no}/composition",
    response_model=PublicTrainCompositionResponse,
    responses=openapi_error_responses(
        status.HTTP_404_NOT_FOUND,
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        status.HTTP_503_SERVICE_UNAVAILABLE,
    ),
)
async def get_v1_public_train_composition(
    train_no: str,
    request: Request,
    response: Response,
    date_param: date | None = Query(default=None, alias="date"),
) -> PublicTrainCompositionResponse:
    target_date = date_param or date.today()
    result = await get_public_train_composition(
        train_no=train_no,
        service_date=target_date,
        rail_router=_get_rail_router(request),
    )
    response.headers["Cache-Control"] = "public, max-age=3600, s-maxage=3600"
    return result


@router.get(
    "/public/train/{train_no}/chart-time",
    response_model=PublicChartTimeResponse,
    responses=openapi_error_responses(
        status.HTTP_404_NOT_FOUND,
        status.HTTP_422_UNPROCESSABLE_ENTITY,
    ),
)
async def get_v1_public_train_chart_time(
    train_no: str,
    request: Request,
    response: Response,
    date_param: date | None = Query(default=None, alias="date"),
) -> PublicChartTimeResponse:
    target_date = date_param or date.today()
    result = get_public_train_chart_time(
        train_no=train_no,
        service_date=target_date,
        yaml_configs=_get_yaml_configs(request),
    )
    response.headers["Cache-Control"] = "public, max-age=300, s-maxage=300"
    return result


@router.get(
    "/public/flight-layouts",
    response_model=PublicFlightLayoutsResponse,
)
async def get_v1_public_flight_layouts(
    response: Response,
    airline: str | None = Query(default=None, max_length=8),
    aircraft: str | None = Query(default=None, max_length=40),
) -> PublicFlightLayoutsResponse:
    result = get_public_flight_layouts(airline=airline, aircraft=aircraft)
    response.headers["Cache-Control"] = "public, max-age=3600, s-maxage=3600"
    return result


@router.get(
    "/public/stats",
    response_model=PublicStatsResponse,
)
async def get_v1_public_stats(
    response: Response,
    db: AsyncSession = Depends(get_db),
) -> PublicStatsResponse:
    result = await get_public_stats(db=db)
    response.headers["Cache-Control"] = "public, max-age=60, s-maxage=60"
    return result
