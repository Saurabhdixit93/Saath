from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any, cast
from uuid import UUID

import structlog
from arq import cron
from arq.connections import RedisSettings
from sqlalchemy import CursorResult, delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from saath_api.auth.models import AuditLog, Device, RefreshToken, User
from saath_api.core.config import get_settings, load_yaml_configs
from saath_api.core.db import create_db_engine, create_session_factory
from saath_api.core.logging import configure_logging
from saath_api.core.redis import create_redis_client
from saath_api.journeys.chart_watcher import run_chart_watcher_tick
from saath_api.journeys.models import Booking
from saath_api.matching.service import recompute_journey_matches
from saath_api.notifications.service import deliver_outbox_batch
from saath_api.providers.messaging import build_messaging_provider
from saath_api.providers.push import build_web_push_provider
from saath_api.providers.rail import build_rail_router
from saath_api.public.models import SeatInvite
from saath_api.swaps.service import (
    expire_pending_swaps,
    transition_awaiting_confirmations,
)

logger = structlog.get_logger(__name__)


async def heartbeat_job(_ctx: dict[str, Any]) -> str:
    logger.info("arq_worker_heartbeat")
    return "ok"


async def recompute_matches_job(ctx: dict[str, Any], journey_instance_id: str) -> int:
    session_factory = ctx.get("session_factory")
    redis = ctx.get("redis")
    if session_factory is None:
        settings = get_settings()
        engine = create_db_engine(settings)
        session_factory = create_session_factory(engine)
        redis_client = create_redis_client(settings)
        try:
            async with session_factory() as db:
                return await recompute_journey_matches(
                    db=db,
                    redis=redis_client,
                    journey_instance_id=UUID(journey_instance_id),
                    publish_events=True,
                )
        finally:
            await redis_client.aclose()
            await engine.dispose()

    async with session_factory() as db:
        return await recompute_journey_matches(
            db=db,
            redis=redis,
            journey_instance_id=UUID(journey_instance_id),
            publish_events=True,
        )


async def deliver_outbox_tick(ctx: dict[str, Any]) -> dict[str, int]:
    session_factory = ctx.get("session_factory")
    redis = ctx.get("redis")
    settings = ctx.get("settings") or get_settings()
    web_push = ctx.get("web_push_provider") or build_web_push_provider(settings)
    messaging = ctx.get("messaging_provider") or build_messaging_provider(settings)

    if session_factory is None:
        engine = create_db_engine(settings)
        session_factory = create_session_factory(engine)
        redis_client = create_redis_client(settings)
        try:
            async with session_factory() as db:
                return await deliver_outbox_batch(
                    settings=settings,
                    db=db,
                    redis=redis_client,
                    web_push_provider=web_push,
                    messaging_provider=messaging,
                )
        finally:
            await redis_client.aclose()
            await engine.dispose()

    async with session_factory() as db:
        return await deliver_outbox_batch(
            settings=settings,
            db=db,
            redis=redis,
            web_push_provider=web_push,
            messaging_provider=messaging,
        )


async def deliver_outbox_job(ctx: dict[str, Any]) -> dict[str, int]:
    return await deliver_outbox_tick(ctx)


async def chart_watcher_tick(ctx: dict[str, Any]) -> int:
    session_factory = ctx.get("session_factory")
    redis = ctx.get("redis")
    settings = ctx.get("settings") or get_settings()
    yaml_configs = ctx.get("yaml_configs") or load_yaml_configs(settings.config_dir)

    if session_factory is None:
        engine = create_db_engine(settings)
        session_factory = create_session_factory(engine)
        redis_client = create_redis_client(settings)
        rail_router = build_rail_router(settings, redis_client)
        try:
            async with session_factory() as db:
                return await run_chart_watcher_tick(
                    settings=settings,
                    yaml_configs=yaml_configs,
                    db=db,
                    redis=redis_client,
                    rail_router=rail_router,
                )
        finally:
            await redis_client.aclose()
            await engine.dispose()

    if ctx.get("rail_router") is not None:
        rail_router = ctx["rail_router"]
    elif redis is not None:
        rail_router = build_rail_router(settings, redis)
    else:
        raise RuntimeError("chart_watcher_tick requires ctx['redis'] to build a rail router")
    async with session_factory() as db:
        return await run_chart_watcher_tick(
            settings=settings,
            yaml_configs=yaml_configs,
            db=db,
            redis=redis,
            rail_router=rail_router,
        )


async def expire_swaps_tick(ctx: dict[str, Any]) -> int:
    session_factory = ctx.get("session_factory")
    redis = ctx.get("redis")
    if session_factory is None:
        settings = get_settings()
        engine = create_db_engine(settings)
        session_factory = create_session_factory(engine)
        redis_client = create_redis_client(settings)
        try:
            async with session_factory() as db:
                return await expire_pending_swaps(db=db, redis=redis_client)
        finally:
            await redis_client.aclose()
            await engine.dispose()

    async with session_factory() as db:
        return await expire_pending_swaps(db=db, redis=redis)


async def post_journey_confirm_tick(ctx: dict[str, Any]) -> int:
    session_factory = ctx.get("session_factory")
    if session_factory is None:
        settings = get_settings()
        engine = create_db_engine(settings)
        session_factory = create_session_factory(engine)
        try:
            async with session_factory() as db:
                return await transition_awaiting_confirmations(db=db)
        finally:
            await engine.dispose()

    async with session_factory() as db:
        return await transition_awaiting_confirmations(db=db)


async def _run_retention_purge(db: AsyncSession) -> dict[str, int]:
    now = datetime.now(UTC)
    # 1. Purge expired seat invites
    invites_stmt = delete(SeatInvite).where(SeatInvite.expires_at < now)
    invites_res = cast(CursorResult[Any], await db.execute(invites_stmt))
    purged_invites = invites_res.rowcount or 0

    # 2. Purge expired bookings past purge_after
    bookings_stmt = delete(Booking).where(Booking.purge_after < now)
    bookings_res = cast(CursorResult[Any], await db.execute(bookings_stmt))
    purged_bookings = bookings_res.rowcount or 0

    # 3. Sweep users scheduled for erasure >24 hours
    cutoff = now - timedelta(hours=24)
    erasure_users_stmt = select(User).where(
        User.status == "deleted",
        User.erasure_requested_at < cutoff,
        User.erased_at.is_(None),
    )
    erasure_res = await db.execute(erasure_users_stmt)
    users_to_erase = erasure_res.scalars().all()
    swept_erasures = 0

    for u in users_to_erase:
        u.erased_at = now
        u.display_alias = None
        # Clean devices and refresh tokens
        await db.execute(delete(Device).where(Device.user_id == u.id))
        await db.execute(delete(RefreshToken).where(RefreshToken.user_id == u.id))
        db.add(
            AuditLog(
                actor="system:retention_purge",
                action="dpdp.erasure_swept",
                resource=f"user:{u.id}",
                meta={"user_id": str(u.id)},
                at=now,
            )
        )
        swept_erasures += 1

    await db.commit()
    logger.info(
        "nightly_retention_purge_completed",
        purged_invites=purged_invites,
        purged_bookings=purged_bookings,
        swept_erasures=swept_erasures,
    )
    return {
        "purged_invites": purged_invites,
        "purged_bookings": purged_bookings,
        "swept_erasures": swept_erasures,
    }


async def nightly_retention_purge_tick(ctx: dict[str, Any]) -> dict[str, int]:
    session_factory = ctx.get("session_factory")
    if session_factory is None:
        settings = ctx.get("settings") or get_settings()
        engine = create_db_engine(settings)
        session_factory = create_session_factory(engine)
        try:
            async with session_factory() as db:
                return await _run_retention_purge(db)
        finally:
            await engine.dispose()

    async with session_factory() as db:
        return await _run_retention_purge(db)


async def retention_purge_job(ctx: dict[str, Any]) -> dict[str, int]:
    return await nightly_retention_purge_tick(ctx)


def _redis_settings() -> RedisSettings:
    return RedisSettings.from_dsn(get_settings().redis_url)


class WorkerSettings:
    functions = [
        heartbeat_job,
        recompute_matches_job,
        deliver_outbox_job,
        retention_purge_job,
    ]
    redis_settings = _redis_settings()

    @staticmethod
    async def on_startup(ctx: dict[str, Any]) -> None:
        settings = get_settings()
        configure_logging(settings.log_level)
        engine = create_db_engine(settings)
        redis_client = create_redis_client(settings)
        ctx["settings"] = settings
        ctx["yaml_configs"] = load_yaml_configs(settings.config_dir)
        ctx["db_engine"] = engine
        ctx["session_factory"] = create_session_factory(engine)
        ctx["redis"] = redis_client
        ctx["rail_router"] = build_rail_router(settings, redis_client)
        ctx["messaging_provider"] = build_messaging_provider(settings)
        ctx["web_push_provider"] = build_web_push_provider(settings)
        logger.info("arq_worker_started")

    @staticmethod
    async def on_shutdown(ctx: dict[str, Any]) -> None:
        redis = ctx.get("redis")
        engine = ctx.get("db_engine")
        if redis is not None:
            await redis.aclose()
        if engine is not None:
            await engine.dispose()


class SchedulerSettings:
    functions = [
        chart_watcher_tick,
        deliver_outbox_tick,
        expire_swaps_tick,
        post_journey_confirm_tick,
        nightly_retention_purge_tick,
    ]
    cron_jobs = [
        cron(chart_watcher_tick, minute={0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55}),
        cron(deliver_outbox_tick, second={0, 30}),
        cron(expire_swaps_tick, second=0),
        cron(post_journey_confirm_tick, minute={0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55}),
        cron(nightly_retention_purge_tick, hour={2}, minute={0}),
    ]
    redis_settings = _redis_settings()

    @staticmethod
    async def on_startup(ctx: dict[str, Any]) -> None:
        settings = get_settings()
        configure_logging(settings.log_level)
        engine = create_db_engine(settings)
        redis_client = create_redis_client(settings)
        ctx["settings"] = settings
        ctx["yaml_configs"] = load_yaml_configs(settings.config_dir)
        ctx["db_engine"] = engine
        ctx["session_factory"] = create_session_factory(engine)
        ctx["redis"] = redis_client
        ctx["rail_router"] = build_rail_router(settings, redis_client)
        ctx["messaging_provider"] = build_messaging_provider(settings)
        ctx["web_push_provider"] = build_web_push_provider(settings)
        logger.info("arq_scheduler_started")

    @staticmethod
    async def on_shutdown(ctx: dict[str, Any]) -> None:
        redis = ctx.get("redis")
        engine = ctx.get("db_engine")
        if redis is not None:
            await redis.aclose()
        if engine is not None:
            await engine.dispose()
