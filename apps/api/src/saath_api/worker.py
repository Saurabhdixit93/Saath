from __future__ import annotations

from typing import Any
from uuid import UUID

import structlog
from arq import cron
from arq.connections import RedisSettings

from saath_api.core.config import get_settings, load_yaml_configs
from saath_api.core.db import create_db_engine, create_session_factory
from saath_api.core.logging import configure_logging
from saath_api.core.redis import create_redis_client
from saath_api.journeys.chart_watcher import run_chart_watcher_tick
from saath_api.matching.service import recompute_journey_matches
from saath_api.notifications.service import deliver_outbox_batch
from saath_api.providers.messaging import build_messaging_provider
from saath_api.providers.push import build_web_push_provider
from saath_api.providers.rail import build_rail_router
from saath_api.swaps.service import (
    expire_pending_swaps,
    transition_awaiting_confirmations,
)

logger = structlog.get_logger(__name__)


async def heartbeat_job(_ctx: dict[str, Any]) -> str:
    logger.info("arq_worker_heartbeat")
    return "ok"


async def recompute_matches_job(
    ctx: dict[str, Any], journey_instance_id: str
) -> int:
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

    rail_router = ctx.get("rail_router") or build_rail_router(settings, redis)
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


def _redis_settings() -> RedisSettings:
    return RedisSettings.from_dsn(get_settings().redis_url)


class WorkerSettings:
    functions = [heartbeat_job, recompute_matches_job, deliver_outbox_job]
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
    ]
    cron_jobs = [
        cron(chart_watcher_tick, minute={0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55}),
        cron(deliver_outbox_tick, second={0, 30}),
        cron(expire_swaps_tick, second=0),
        cron(post_journey_confirm_tick, minute={0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55}),
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
