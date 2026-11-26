from __future__ import annotations

import asyncio
import json
import secrets
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

from fastapi import status
from redis.asyncio import Redis
from redis.exceptions import ResponseError
from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from saath_api.auth.dependencies import Actor, authorize
from saath_api.auth.models import AuditLog, Device, RefreshToken, User
from saath_api.journeys.models import Booking, SeatHolder
from saath_api.parties.models import Party
from saath_api.auth.schemas import (
    AnonymousAuthResponse,
    OtpStartRequest,
    OtpStartResponse,
    OtpVerifyRequest,
    OtpVerifyResponse,
    TokenPairResponse,
    UpdateMeRequest,
    UserProfile,
)
from saath_api.core.config import Settings, YamlConfigBundle
from saath_api.core.crypto import (
    blind_index_phone,
    create_access_token,
    create_anon_token,
    encrypt_phone,
    hash_otp,
    hash_token,
    normalize_indian_phone,
    verify_otp_hash,
)
from saath_api.core.errors import ProblemDetailError
from saath_api.core.ids import generate_opaque_token, uuid7
from saath_api.core.redis import SlidingWindowRateLimiter
from saath_api.providers.base import ProviderError
from saath_api.providers.messaging import MessagingProvider
from saath_api.providers.turnstile import TurnstileVerifier

_RELEASE_LOCK_LUA = """
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
"""


@asynccontextmanager
async def _acquire_otp_lock(redis: Redis, request_id: str) -> AsyncIterator[None]:
    lock_key = f"otp:lock:{request_id}"
    lock_token = generate_opaque_token(12)
    acquired = False
    for _ in range(50):
        ok = await redis.set(lock_key, lock_token, nx=True, px=5000)
        if ok:
            acquired = True
            break
        await asyncio.sleep(0.02)

    if not acquired:
        raise ProblemDetailError(
            status_code=status.HTTP_409_CONFLICT,
            code="otp_verification_in_progress",
            title="Verification In Progress",
            detail="OTP verification is already in progress. Please wait a moment.",
        )

    try:
        yield
    finally:
        try:
            await redis.eval(_RELEASE_LOCK_LUA, 1, lock_key, lock_token)  # type: ignore[misc,no-untyped-call]
        except ResponseError:
            current = await redis.get(lock_key)
            if current == lock_token:
                await redis.delete(lock_key)


async def issue_anonymous_session(
    *,
    settings: Settings,
    yaml_configs: YamlConfigBundle,
    redis: Redis,
    turnstile_verifier: TurnstileVerifier,
    turnstile_token: str,
    client_ip: str,
) -> AnonymousAuthResponse:
    limiter = SlidingWindowRateLimiter(redis)
    allowed, retry_after = await limiter.allow(
        f"rl:anon:ip:{client_ip}",
        limit=yaml_configs.rate_limits.auth.anonymous_per_ip_per_minute,
        window_seconds=60,
    )
    if not allowed:
        raise ProblemDetailError(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            code="rate_limited",
            title="Too Many Requests",
            detail="Lots of people checking right now. Give us 30 seconds.",
            headers={"Retry-After": str(retry_after)},
        )

    ok = await turnstile_verifier.verify(turnstile_token, remote_ip=client_ip)
    if not ok:
        raise ProblemDetailError(
            status_code=status.HTTP_403_FORBIDDEN,
            code="turnstile_failed",
            title="Bot Check Failed",
            detail="Please complete the verification check and try again.",
        )

    token, expires_in = create_anon_token(settings)
    return AnonymousAuthResponse(access=token, expires_in=expires_in)


async def start_otp(
    *,
    settings: Settings,
    yaml_configs: YamlConfigBundle,
    redis: Redis,
    turnstile_verifier: TurnstileVerifier,
    messaging_provider: MessagingProvider,
    req: OtpStartRequest,
    client_ip: str,
) -> OtpStartResponse:
    phone_e164 = normalize_indian_phone(req.phone)
    phone_bidx_hex = blind_index_phone(phone_e164, settings.phone_blind_index_key).hex()

    ok = await turnstile_verifier.verify(req.turnstile, remote_ip=client_ip)
    if not ok:
        raise ProblemDetailError(
            status_code=status.HTTP_403_FORBIDDEN,
            code="turnstile_failed",
            title="Bot Check Failed",
            detail="Please complete the verification check and try again.",
        )

    auth_limits = yaml_configs.rate_limits.auth
    cooldown_key = f"otp:cd:{phone_bidx_hex}"
    if await redis.exists(cooldown_key):
        ttl_left = await redis.ttl(cooldown_key)
        wait_seconds = max(int(ttl_left), 1)
        raise ProblemDetailError(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            code="otp_resend_cooldown",
            title="Please Wait Before Resending",
            detail=f"Please wait {wait_seconds} seconds before requesting another OTP.",
            headers={"Retry-After": str(wait_seconds)},
        )

    limiter = SlidingWindowRateLimiter(redis)
    ip_allowed, ip_retry = await limiter.allow(
        f"rl:otp:ip:{client_ip}",
        limit=auth_limits.otp_start_per_ip_per_minute,
        window_seconds=60,
    )
    if not ip_allowed:
        raise ProblemDetailError(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            code="rate_limited",
            title="Too Many Requests",
            detail="Lots of people checking right now. Give us 30 seconds.",
            headers={"Retry-After": str(ip_retry)},
        )

    phone_allowed, phone_retry = await limiter.allow(
        f"rl:otp:phone:{phone_bidx_hex}",
        limit=auth_limits.otp_start_per_phone_per_hour,
        window_seconds=3600,
    )
    if not phone_allowed:
        raise ProblemDetailError(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            code="rate_limited",
            title="Too Many OTP Requests",
            detail="Too many OTP requests for this number. Please try again later.",
            headers={"Retry-After": str(phone_retry)},
        )

    code = f"{secrets.randbelow(1_000_000):06d}"
    otp_hash = hash_otp(code)
    request_id = str(uuid7())

    payload = json.dumps(
        {
            "otp_hash": otp_hash,
            "phone_e164": phone_e164,
            "phone_bidx_hex": phone_bidx_hex,
            "channel": req.channel,
            "locale": req.locale,
            "attempts": 0,
        }
    )

    otp_key = f"otp:req:{request_id}"
    await redis.set(
        otp_key,
        payload,
        ex=auth_limits.otp_ttl_seconds,
    )

    try:
        await messaging_provider.send_otp(
            phone_e164=phone_e164,
            code=code,
            locale=req.locale,
            channel=req.channel,
        )
    except ProviderError as exc:
        await redis.delete(otp_key)
        raise ProblemDetailError(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            code="messaging_unavailable",
            title="Messaging Unavailable",
            detail="Unable to send verification code right now. Please try again shortly.",
        ) from exc

    await redis.set(
        cooldown_key,
        "1",
        ex=auth_limits.otp_resend_cooldown_seconds,
    )

    return OtpStartResponse(
        request_id=request_id,
        resend_after=auth_limits.otp_resend_cooldown_seconds,
    )


async def merge_anonymous_identity(
    *,
    db: AsyncSession,
    redis: Redis,
    anon_id: str,
    user_id: UUID,
) -> None:
    """Hook invoked on OTP verify when caller holds an anonymous JWT.

    Reassigns anonymous bookings, party leadership, and lead passenger linkage
    in PostgreSQL, records the merge audit event, and sets the Redis marker.
    """
    claimed_booking_ids_result = await db.execute(
        select(Booking.id).where(Booking.owner_anon_id == anon_id)
    )
    claimed_booking_ids = list(claimed_booking_ids_result.scalars().all())

    if claimed_booking_ids:
        await db.execute(
            update(Booking)
            .where(Booking.owner_anon_id == anon_id)
            .values(owner_user_id=user_id, owner_anon_id=None)
        )
        await db.execute(
            update(SeatHolder)
            .where(
                SeatHolder.booking_id.in_(claimed_booking_ids),
                SeatHolder.pax_seq == 1,
                SeatHolder.linked_user_id.is_(None),
            )
            .values(linked_user_id=user_id)
        )

    await db.execute(
        update(Party)
        .where(Party.leader_anon_id == anon_id)
        .values(leader_user_id=user_id, leader_anon_id=None)
    )

    await redis.set(f"anon:merged:{anon_id}", str(user_id), ex=86400)
    db.add(
        AuditLog(
            actor=f"user:{user_id}",
            action="auth.anon_merged",
            resource=f"user:{user_id}",
            meta={
                "anon_id": anon_id,
                "merged_booking_count": len(claimed_booking_ids),
            },
        )
    )


async def verify_otp(
    *,
    settings: Settings,
    yaml_configs: YamlConfigBundle,
    db: AsyncSession,
    redis: Redis,
    req: OtpVerifyRequest,
    anon_actor: Actor | None,
    user_agent: str | None,
) -> OtpVerifyResponse:
    otp_key = f"otp:req:{req.request_id}"
    async with _acquire_otp_lock(redis, req.request_id):
        raw_record = await redis.get(otp_key)
        if raw_record is None:
            raise ProblemDetailError(
                status_code=status.HTTP_401_UNAUTHORIZED,
                code="otp_expired",
                title="OTP Expired",
                detail="Your verification code has expired or is invalid. Request a new one.",
            )

        record: dict[str, Any] = json.loads(raw_record)
        attempts = int(record.get("attempts", 0))
        max_attempts = yaml_configs.rate_limits.auth.otp_max_attempts

        if attempts >= max_attempts:
            await redis.delete(otp_key)
            raise ProblemDetailError(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                code="otp_max_attempts",
                title="Too Many Incorrect Attempts",
                detail="Maximum OTP attempts reached. Please request a new code.",
            )

        otp_hash = str(record["otp_hash"])
        if not verify_otp_hash(otp_hash, req.code):
            record["attempts"] = attempts + 1
            pttl_ms = await redis.pttl(otp_key)
            if pttl_ms > 0:
                await redis.set(otp_key, json.dumps(record), xx=True, px=int(pttl_ms))
            raise ProblemDetailError(
                status_code=status.HTTP_401_UNAUTHORIZED,
                code="otp_invalid",
                title="Incorrect OTP",
                detail="That 6-digit code doesn't match. Please check and try again.",
            )

        deleted = await redis.delete(otp_key)
        if deleted == 0:
            raise ProblemDetailError(
                status_code=status.HTTP_401_UNAUTHORIZED,
                code="otp_expired",
                title="OTP Expired",
                detail="Your verification code has expired or is invalid. Request a new one.",
            )

    phone_e164 = str(record["phone_e164"])
    phone_bidx = bytes.fromhex(str(record["phone_bidx_hex"]))
    locale = str(record.get("locale", "en"))

    result = await db.execute(select(User).where(User.phone_bidx == phone_bidx))
    user = result.scalar_one_or_none()

    if user is None:
        upsert_stmt = (
            pg_insert(User)
            .values(
                id=uuid7(),
                phone_enc=encrypt_phone(phone_e164, settings.phone_aes_key),
                phone_bidx=phone_bidx,
                locale=locale if locale in ("en", "hi") else "en",
                gender_self="undisclosed",
                women_only_default=False,
                status="active",
            )
            .on_conflict_do_nothing(index_elements=[User.phone_bidx])
        )
        await db.execute(upsert_stmt)
        user_result = await db.execute(select(User).where(User.phone_bidx == phone_bidx))
        user = user_result.scalar_one()

    if user.status in ("banned", "deleted"):
        raise ProblemDetailError(
            status_code=status.HTTP_403_FORBIDDEN,
            code="account_disabled",
            title="Account Disabled",
            detail="This account cannot be signed in.",
        )

    now = datetime.now(UTC)
    device = Device(
        id=uuid7(),
        user_id=user.id,
        user_agent=user_agent[:512] if user_agent else None,
        last_seen_at=now,
    )
    db.add(device)
    await db.flush()

    raw_refresh = generate_opaque_token(32)
    refresh_row = RefreshToken(
        id=uuid7(),
        user_id=user.id,
        device_id=device.id,
        family_id=uuid7(),
        token_hash=hash_token(raw_refresh),
        expires_at=now + timedelta(days=settings.refresh_token_ttl_days),
    )
    db.add(refresh_row)

    if anon_actor is not None and anon_actor.kind == "anon" and anon_actor.anon_id:
        await merge_anonymous_identity(
            db=db,
            redis=redis,
            anon_id=anon_actor.anon_id,
            user_id=user.id,
        )

    db.add(
        AuditLog(
            actor=f"user:{user.id}",
            action="auth.otp_verified",
            resource=f"user:{user.id}",
            meta={"channel": record.get("channel"), "device_id": str(device.id)},
        )
    )

    await db.commit()
    await db.refresh(user)

    access, expires_in = create_access_token(settings, user_id=user.id, device_id=device.id)
    return OtpVerifyResponse(
        access=access,
        refresh=raw_refresh,
        expires_in=expires_in,
        user=UserProfile.model_validate(user),
    )


async def refresh_session(
    *,
    settings: Settings,
    db: AsyncSession,
    raw_refresh: str,
) -> TokenPairResponse:
    token_digest = hash_token(raw_refresh)
    result = await db.execute(
        select(RefreshToken)
        .where(RefreshToken.token_hash == token_digest)
        .with_for_update()
    )
    token_row = result.scalar_one_or_none()
    if token_row is None:
        raise ProblemDetailError(
            status_code=status.HTTP_401_UNAUTHORIZED,
            code="invalid_refresh_token",
            title="Invalid Refresh Token",
            detail="Session is invalid. Please sign in again.",
        )

    now = datetime.now(UTC)

    if token_row.revoked_at is not None:
        await db.execute(
            update(RefreshToken)
            .where(
                RefreshToken.family_id == token_row.family_id,
                RefreshToken.revoked_at.is_(None),
            )
            .values(revoked_at=now)
        )
        db.add(
            AuditLog(
                actor=f"user:{token_row.user_id}",
                action="auth.refresh_reuse_detected",
                resource=f"refresh_family:{token_row.family_id}",
                meta={"token_id": str(token_row.id), "device_id": str(token_row.device_id)},
            )
        )
        await db.commit()
        raise ProblemDetailError(
            status_code=status.HTTP_401_UNAUTHORIZED,
            code="refresh_token_reused",
            title="Session Revoked",
            detail="Suspicious session reuse detected. Please sign in again.",
        )

    if token_row.expires_at <= now:
        token_row.revoked_at = now
        await db.commit()
        raise ProblemDetailError(
            status_code=status.HTTP_401_UNAUTHORIZED,
            code="refresh_token_expired",
            title="Session Expired",
            detail="Your session has expired. Please sign in again.",
        )

    user_result = await db.execute(select(User.status).where(User.id == token_row.user_id))
    user_status = user_result.scalar_one_or_none()
    if user_status in (None, "banned", "deleted"):
        raise ProblemDetailError(
            status_code=status.HTTP_403_FORBIDDEN,
            code="account_disabled",
            title="Account Disabled",
            detail="Account is not active.",
        )

    new_raw_refresh = generate_opaque_token(32)
    new_id = uuid7()
    new_row = RefreshToken(
        id=new_id,
        user_id=token_row.user_id,
        device_id=token_row.device_id,
        family_id=token_row.family_id,
        token_hash=hash_token(new_raw_refresh),
        expires_at=now + timedelta(days=settings.refresh_token_ttl_days),
    )
    db.add(new_row)
    await db.flush()

    token_row.revoked_at = now
    token_row.replaced_by = new_id

    await db.execute(
        update(Device).where(Device.id == token_row.device_id).values(last_seen_at=now)
    )
    await db.commit()

    access, expires_in = create_access_token(
        settings, user_id=token_row.user_id, device_id=token_row.device_id
    )
    return TokenPairResponse(access=access, refresh=new_raw_refresh, expires_in=expires_in)


async def logout_session(*, db: AsyncSession, actor: Actor) -> None:
    authorize(actor, "auth.logout", resource_owner_id=actor.user_id)
    now = datetime.now(UTC)
    stmt = update(RefreshToken).where(
        RefreshToken.user_id == actor.user_id,
        RefreshToken.revoked_at.is_(None),
    )
    if actor.device_id is not None:
        stmt = stmt.where(RefreshToken.device_id == actor.device_id)
    await db.execute(stmt.values(revoked_at=now))
    db.add(
        AuditLog(
            actor=f"user:{actor.user_id}",
            action="auth.logout",
            resource=f"user:{actor.user_id}",
            meta={"device_id": str(actor.device_id) if actor.device_id else None},
        )
    )
    await db.commit()


async def get_me(*, db: AsyncSession, actor: Actor) -> UserProfile:
    authorize(actor, "user.read_me", resource_owner_id=actor.user_id)
    result = await db.execute(select(User).where(User.id == actor.user_id))
    user = result.scalar_one_or_none()
    if user is None:
        raise ProblemDetailError(
            status_code=status.HTTP_404_NOT_FOUND,
            code="user_not_found",
            title="User Not Found",
            detail="User profile not found.",
        )
    return UserProfile.model_validate(user)


async def update_me(*, db: AsyncSession, actor: Actor, req: UpdateMeRequest) -> UserProfile:
    authorize(actor, "user.update_me", resource_owner_id=actor.user_id)
    result = await db.execute(select(User).where(User.id == actor.user_id))
    user = result.scalar_one_or_none()
    if user is None:
        raise ProblemDetailError(
            status_code=status.HTTP_404_NOT_FOUND,
            code="user_not_found",
            title="User Not Found",
            detail="User profile not found.",
        )

    if req.locale is not None:
        user.locale = req.locale
    if req.women_only_default is not None:
        user.women_only_default = req.women_only_default
    if "display_alias" in req.model_fields_set:
        cleaned_alias = req.display_alias.strip() if req.display_alias is not None else None
        user.display_alias = cleaned_alias or None
    if req.gender_self is not None:
        user.gender_self = req.gender_self
    if req.notification_channels is not None:
        merged = dict(user.notification_channels)
        patch = req.notification_channels
        if patch.push is not None:
            merged["push"] = patch.push
        if patch.whatsapp is not None:
            merged["whatsapp"] = patch.whatsapp
        if patch.sms is not None:
            merged["sms"] = patch.sms
        if patch.quiet_hours_enabled is not None:
            merged["quiet_hours_enabled"] = patch.quiet_hours_enabled
        user.notification_prefs = merged

    await db.commit()
    await db.refresh(user)
    return UserProfile.model_validate(user)
