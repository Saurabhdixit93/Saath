from __future__ import annotations

from fastapi import APIRouter, Depends, Header, Query, Request, Response, status
from fastapi.responses import PlainTextResponse
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession

from saath_api.auth.dependencies import Actor, get_request_settings, require_user_actor
from saath_api.auth.schemas import NotificationChannelsDTO, NotificationChannelsPatchDTO
from saath_api.core.config import YamlConfigBundle
from saath_api.core.db import get_db
from saath_api.core.errors import ProblemDetailError, openapi_error_responses
from saath_api.core.redis import get_redis
from saath_api.notifications.schemas import (
    PushSubscriptionRequest,
    PushSubscriptionResponse,
    WhatsAppWebhookResponse,
)
from saath_api.notifications.service import (
    get_notification_prefs,
    process_whatsapp_webhook,
    register_push_subscription,
    update_notification_prefs,
)
from saath_api.providers.flight.schedule import FlightScheduleProvider
from saath_api.providers.messaging import MessagingProvider
from saath_api.providers.rail.router import ProviderRouter

router = APIRouter(prefix="/v1", tags=["notifications"])


def _get_yaml_configs(request: Request) -> YamlConfigBundle:
    return request.app.state.yaml_configs  # type: ignore[no-any-return]


def _get_rail_router(request: Request) -> ProviderRouter:
    return request.app.state.rail_router  # type: ignore[no-any-return]


def _get_flight_provider(request: Request) -> FlightScheduleProvider:
    return request.app.state.flight_schedule_provider  # type: ignore[no-any-return]


def _get_messaging_provider(request: Request) -> MessagingProvider:
    return request.app.state.messaging_provider  # type: ignore[no-any-return]


@router.post(
    "/me/push-subscriptions",
    response_model=PushSubscriptionResponse,
    responses=openapi_error_responses(
        status.HTTP_401_UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN,
        status.HTTP_422_UNPROCESSABLE_ENTITY,
    ),
)
async def post_v1_me_push_subscriptions(
    body: PushSubscriptionRequest,
    actor: Actor = Depends(require_user_actor),
    db: AsyncSession = Depends(get_db),
) -> PushSubscriptionResponse:
    return await register_push_subscription(db=db, actor=actor, req=body)


@router.get(
    "/me/notification-prefs",
    response_model=NotificationChannelsDTO,
    responses=openapi_error_responses(
        status.HTTP_401_UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN,
    ),
)
async def get_v1_me_notification_prefs(
    actor: Actor = Depends(require_user_actor),
    db: AsyncSession = Depends(get_db),
) -> NotificationChannelsDTO:
    return await get_notification_prefs(db=db, actor=actor)


@router.patch(
    "/me/notification-prefs",
    response_model=NotificationChannelsDTO,
    responses=openapi_error_responses(
        status.HTTP_401_UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN,
        status.HTTP_422_UNPROCESSABLE_ENTITY,
    ),
)
async def patch_v1_me_notification_prefs(
    body: NotificationChannelsPatchDTO,
    actor: Actor = Depends(require_user_actor),
    db: AsyncSession = Depends(get_db),
) -> NotificationChannelsDTO:
    return await update_notification_prefs(db=db, actor=actor, req=body)


@router.get(
    "/webhooks/whatsapp",
    response_class=PlainTextResponse,
    responses=openapi_error_responses(status.HTTP_403_FORBIDDEN),
)
async def get_v1_webhooks_whatsapp(
    request: Request,
    hub_mode: str | None = Query(default=None, alias="hub.mode"),
    hub_verify_token: str | None = Query(default=None, alias="hub.verify_token"),
    hub_challenge: str = Query(default="", alias="hub.challenge"),
) -> Response:
    settings = get_request_settings(request)
    if (
        hub_mode != "subscribe"
        or not settings.whatsapp_verify_token
        or hub_verify_token != settings.whatsapp_verify_token
    ):
        raise ProblemDetailError(
            status_code=status.HTTP_403_FORBIDDEN,
            code="invalid_verify_token",
            title="Forbidden",
            detail="WhatsApp webhook verification token mismatch.",
        )
    return PlainTextResponse(content=hub_challenge, status_code=status.HTTP_200_OK)


@router.post(
    "/webhooks/whatsapp",
    response_model=WhatsAppWebhookResponse,
    responses=openapi_error_responses(
        status.HTTP_400_BAD_REQUEST,
        status.HTTP_403_FORBIDDEN,
    ),
)
async def post_v1_webhooks_whatsapp(
    request: Request,
    db: AsyncSession = Depends(get_db),
    redis: Redis = Depends(get_redis),
    x_hub_signature_256: str | None = Header(default=None),
) -> WhatsAppWebhookResponse:
    raw_body = await request.body()
    return await process_whatsapp_webhook(
        settings=get_request_settings(request),
        yaml_configs=_get_yaml_configs(request),
        db=db,
        redis=redis,
        rail_router=_get_rail_router(request),
        flight_provider=_get_flight_provider(request),
        messaging_provider=_get_messaging_provider(request),
        raw_body=raw_body,
        signature_header=x_hub_signature_256,
    )
