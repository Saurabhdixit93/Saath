from __future__ import annotations

import ipaddress

from fastapi import APIRouter, Depends, Request, status
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession

from saath_api.auth.dependencies import (
    Actor,
    get_request_settings,
    optional_anon_actor_for_merge,
    require_user_actor,
)
from saath_api.auth.schemas import (
    AnonymousAuthRequest,
    AnonymousAuthResponse,
    LogoutResponse,
    OtpStartRequest,
    OtpStartResponse,
    OtpVerifyRequest,
    OtpVerifyResponse,
    RefreshRequest,
    TokenPairResponse,
    UpdateMeRequest,
    UserProfile,
)
from saath_api.auth.service import (
    get_me,
    issue_anonymous_session,
    logout_session,
    refresh_session,
    start_otp,
    update_me,
    verify_otp,
)
from saath_api.core.config import YamlConfigBundle
from saath_api.core.db import get_db
from saath_api.core.errors import openapi_error_responses
from saath_api.core.redis import get_redis
from saath_api.providers.messaging import MessagingProvider
from saath_api.providers.turnstile import TurnstileVerifier

router = APIRouter(prefix="/v1", tags=["auth"])


def _is_trusted_proxy(ip_str: str, trusted_entries: list[str]) -> bool:
    try:
        addr = ipaddress.ip_address(ip_str)
    except ValueError:
        return False
    for entry in trusted_entries:
        try:
            if "/" in entry:
                if addr in ipaddress.ip_network(entry, strict=False):
                    return True
            elif addr == ipaddress.ip_address(entry):
                return True
        except ValueError:
            continue
    return False


def _client_ip(request: Request) -> str:
    peer_ip = request.client.host if request.client and request.client.host else "127.0.0.1"
    settings = get_request_settings(request)
    if not _is_trusted_proxy(peer_ip, settings.trusted_proxy_list):
        return peer_ip

    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        hops = [h.strip() for h in forwarded.split(",") if h.strip()]
        for hop in reversed(hops):
            try:
                ipaddress.ip_address(hop)
            except ValueError:
                continue
            if not _is_trusted_proxy(hop, settings.trusted_proxy_list):
                return hop
        if hops:
            return hops[-1]
    return peer_ip


def _get_yaml_configs(request: Request) -> YamlConfigBundle:
    return request.app.state.yaml_configs  # type: ignore[no-any-return]


def _get_turnstile(request: Request) -> TurnstileVerifier:
    return request.app.state.turnstile_verifier  # type: ignore[no-any-return]


def _get_messaging(request: Request) -> MessagingProvider:
    return request.app.state.messaging_provider  # type: ignore[no-any-return]


@router.post(
    "/auth/anonymous",
    response_model=AnonymousAuthResponse,
    responses=openapi_error_responses(
        status.HTTP_403_FORBIDDEN,
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        status.HTTP_429_TOO_MANY_REQUESTS,
    ),
)
async def post_auth_anonymous(
    body: AnonymousAuthRequest,
    request: Request,
    redis: Redis = Depends(get_redis),
) -> AnonymousAuthResponse:
    return await issue_anonymous_session(
        settings=get_request_settings(request),
        yaml_configs=_get_yaml_configs(request),
        redis=redis,
        turnstile_verifier=_get_turnstile(request),
        turnstile_token=body.turnstile,
        client_ip=_client_ip(request),
    )


@router.post(
    "/auth/otp/start",
    response_model=OtpStartResponse,
    responses=openapi_error_responses(
        status.HTTP_403_FORBIDDEN,
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        status.HTTP_429_TOO_MANY_REQUESTS,
        status.HTTP_503_SERVICE_UNAVAILABLE,
    ),
)
async def post_auth_otp_start(
    body: OtpStartRequest,
    request: Request,
    redis: Redis = Depends(get_redis),
) -> OtpStartResponse:
    return await start_otp(
        settings=get_request_settings(request),
        yaml_configs=_get_yaml_configs(request),
        redis=redis,
        turnstile_verifier=_get_turnstile(request),
        messaging_provider=_get_messaging(request),
        req=body,
        client_ip=_client_ip(request),
    )


@router.post(
    "/auth/otp/verify",
    response_model=OtpVerifyResponse,
    responses=openapi_error_responses(
        status.HTTP_401_UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN,
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        status.HTTP_429_TOO_MANY_REQUESTS,
    ),
)
async def post_auth_otp_verify(
    body: OtpVerifyRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    redis: Redis = Depends(get_redis),
    anon_actor: Actor | None = Depends(optional_anon_actor_for_merge),
) -> OtpVerifyResponse:
    return await verify_otp(
        settings=get_request_settings(request),
        yaml_configs=_get_yaml_configs(request),
        db=db,
        redis=redis,
        req=body,
        anon_actor=anon_actor,
        user_agent=request.headers.get("user-agent"),
    )


@router.post(
    "/auth/refresh",
    response_model=TokenPairResponse,
    responses=openapi_error_responses(
        status.HTTP_401_UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN,
        status.HTTP_422_UNPROCESSABLE_ENTITY,
    ),
)
async def post_auth_refresh(
    body: RefreshRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> TokenPairResponse:
    return await refresh_session(
        settings=get_request_settings(request),
        db=db,
        raw_refresh=body.refresh,
    )


@router.post(
    "/auth/logout",
    response_model=LogoutResponse,
    responses=openapi_error_responses(
        status.HTTP_401_UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN,
    ),
)
async def post_auth_logout(
    actor: Actor = Depends(require_user_actor),
    db: AsyncSession = Depends(get_db),
) -> LogoutResponse:
    await logout_session(db=db, actor=actor)
    return LogoutResponse(ok=True)


@router.get(
    "/me",
    response_model=UserProfile,
    tags=["profile"],
    responses=openapi_error_responses(
        status.HTTP_401_UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN,
        status.HTTP_404_NOT_FOUND,
    ),
)
async def get_v1_me(
    actor: Actor = Depends(require_user_actor),
    db: AsyncSession = Depends(get_db),
) -> UserProfile:
    return await get_me(db=db, actor=actor)


@router.patch(
    "/me",
    response_model=UserProfile,
    tags=["profile"],
    responses=openapi_error_responses(
        status.HTTP_401_UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN,
        status.HTTP_404_NOT_FOUND,
        status.HTTP_422_UNPROCESSABLE_ENTITY,
    ),
)
async def patch_v1_me(
    body: UpdateMeRequest,
    actor: Actor = Depends(require_user_actor),
    db: AsyncSession = Depends(get_db),
) -> UserProfile:
    return await update_me(db=db, actor=actor, req=body)
