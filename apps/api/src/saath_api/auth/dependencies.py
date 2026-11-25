from __future__ import annotations

from dataclasses import dataclass
from typing import Literal
from uuid import UUID

import jwt
import structlog
from fastapi import Depends, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from saath_api.auth.models import User
from saath_api.core.config import Settings, get_settings
from saath_api.core.crypto import decode_jwt
from saath_api.core.db import get_db
from saath_api.core.errors import ProblemDetailError

logger = structlog.get_logger(__name__)

_bearer_scheme = HTTPBearer(auto_error=False)


@dataclass(frozen=True)
class Actor:
    kind: Literal["anon", "user", "admin"]
    user_id: UUID | None
    anon_id: str | None
    device_id: UUID | None
    scopes: frozenset[str]


def _parse_actor_from_token(token: str, settings: Settings) -> Actor:
    try:
        claims = decode_jwt(token, settings.jwt_public_key)
    except jwt.ExpiredSignatureError as exc:
        raise ProblemDetailError(
            status_code=status.HTTP_401_UNAUTHORIZED,
            code="token_expired",
            title="Token Expired",
            detail="Authentication token has expired.",
        ) from exc
    except jwt.InvalidTokenError as exc:
        raise ProblemDetailError(
            status_code=status.HTTP_401_UNAUTHORIZED,
            code="invalid_token",
            title="Invalid Token",
            detail="Authentication token is invalid.",
        ) from exc

    kind = claims.get("kind")
    sub = claims.get("sub")
    raw_scopes = claims.get("scopes", [])
    scopes = frozenset(str(s) for s in raw_scopes) if isinstance(raw_scopes, list) else frozenset()

    if kind == "anon" and isinstance(sub, str) and sub.startswith("anon:"):
        return Actor(
            kind="anon",
            user_id=None,
            anon_id=sub,
            device_id=None,
            scopes=scopes,
        )

    if kind == "user" and isinstance(sub, str):
        try:
            user_uuid = UUID(sub)
            raw_dev = claims.get("device_id")
            device_uuid = UUID(str(raw_dev)) if raw_dev else None
        except ValueError as exc:
            raise ProblemDetailError(
                status_code=status.HTTP_401_UNAUTHORIZED,
                code="invalid_token",
                title="Invalid Token",
                detail="Malformed subject or device claim.",
            ) from exc
        return Actor(
            kind="user",
            user_id=user_uuid,
            anon_id=None,
            device_id=device_uuid,
            scopes=scopes,
        )

    if kind == "admin" and isinstance(sub, str):
        return Actor(
            kind="admin",
            user_id=None,
            anon_id=None,
            device_id=None,
            scopes=scopes,
        )

    raise ProblemDetailError(
        status_code=status.HTTP_401_UNAUTHORIZED,
        code="invalid_token",
        title="Invalid Token",
        detail="Unsupported actor kind.",
    )


def get_request_settings(request: Request) -> Settings:
    settings: Settings | None = getattr(request.app.state, "settings", None)
    return settings or get_settings()


async def current_actor(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer_scheme),
) -> Actor:
    if credentials is None or not credentials.credentials:
        raise ProblemDetailError(
            status_code=status.HTTP_401_UNAUTHORIZED,
            code="missing_authorization",
            title="Authentication Required",
            detail="Bearer authentication token is required.",
        )
    return _parse_actor_from_token(credentials.credentials, get_request_settings(request))


async def optional_actor(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer_scheme),
) -> Actor | None:
    if credentials is None or not credentials.credentials:
        return None
    return _parse_actor_from_token(credentials.credentials, get_request_settings(request))


async def optional_anon_actor_for_merge(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer_scheme),
) -> Actor | None:
    """Resolve optional anonymous actor for OTP merge, ignoring expired anon JWTs."""
    if credentials is None or not credentials.credentials:
        return None
    settings = get_request_settings(request)
    try:
        actor = _parse_actor_from_token(credentials.credentials, settings)
        return actor if actor.kind == "anon" else None
    except ProblemDetailError as exc:
        if exc.code == "token_expired":
            try:
                claims = decode_jwt(
                    credentials.credentials,
                    settings.jwt_public_key,
                    verify_exp=False,
                )
                if claims.get("kind") == "anon":
                    logger.info("expired_anon_token_ignored_on_otp_verify")
                    return None
            except jwt.InvalidTokenError:
                pass
        raise


async def require_user_actor(
    actor: Actor = Depends(current_actor),
    db: AsyncSession = Depends(get_db),
) -> Actor:
    if actor.kind != "user" or actor.user_id is None:
        raise ProblemDetailError(
            status_code=status.HTTP_403_FORBIDDEN,
            code="user_auth_required",
            title="Phone Verification Required",
            detail="This action requires a verified user session.",
        )

    result = await db.execute(select(User.status).where(User.id == actor.user_id))
    user_status = result.scalar_one_or_none()
    if user_status is None:
        raise ProblemDetailError(
            status_code=status.HTTP_401_UNAUTHORIZED,
            code="user_not_found",
            title="Account Not Found",
            detail="Authenticated user account no longer exists.",
        )
    if user_status in ("banned", "deleted"):
        raise ProblemDetailError(
            status_code=status.HTTP_403_FORBIDDEN,
            code="account_disabled",
            title="Account Disabled",
            detail="This account is not permitted to perform this action.",
        )
    return actor


def authorize(
    actor: Actor,
    action: str,
    *,
    resource_owner_id: UUID | None = None,
) -> None:
    _ = action
    if actor.kind == "admin":
        return
    if actor.kind != "user" or actor.user_id is None:
        raise ProblemDetailError(
            status_code=status.HTTP_403_FORBIDDEN,
            code="forbidden",
            title="Forbidden",
            detail="You are not allowed to perform this action.",
        )
    if resource_owner_id is not None and actor.user_id != resource_owner_id:
        raise ProblemDetailError(
            status_code=status.HTTP_403_FORBIDDEN,
            code="forbidden",
            title="Forbidden",
            detail="You do not have access to this resource.",
        )


def authorize_resource_owner(
    actor: Actor,
    action: str,
    *,
    owner_user_id: UUID | None = None,
    owner_anon_id: str | None = None,
) -> None:
    """Enforce ownership for dual-owned resources (anonymous or authenticated user)."""
    _ = action
    if actor.kind == "admin":
        return
    if actor.kind == "user" and actor.user_id is not None:
        if owner_user_id is not None and actor.user_id == owner_user_id:
            return
        raise ProblemDetailError(
            status_code=status.HTTP_403_FORBIDDEN,
            code="forbidden",
            title="Forbidden",
            detail="You do not have access to this resource.",
        )
    if actor.kind == "anon" and actor.anon_id is not None:
        if owner_anon_id is not None and actor.anon_id == owner_anon_id:
            return
        raise ProblemDetailError(
            status_code=status.HTTP_403_FORBIDDEN,
            code="forbidden",
            title="Forbidden",
            detail="You do not have access to this resource.",
        )
    raise ProblemDetailError(
        status_code=status.HTTP_403_FORBIDDEN,
        code="forbidden",
        title="Forbidden",
        detail="You are not allowed to perform this action.",
    )
