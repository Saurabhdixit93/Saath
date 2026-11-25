from __future__ import annotations

from typing import Any

import structlog
from arq.connections import RedisSettings

from saath_api.core.config import get_settings
from saath_api.core.logging import configure_logging

logger = structlog.get_logger(__name__)


async def heartbeat_job(_ctx: dict[str, Any]) -> str:
    logger.info("arq_worker_heartbeat")
    return "ok"


async def chart_watcher_tick(_ctx: dict[str, Any]) -> str:
    logger.info("arq_scheduler_chart_watcher_tick")
    return "ok"


def _redis_settings() -> RedisSettings:
    return RedisSettings.from_dsn(get_settings().redis_url)


class WorkerSettings:
    functions = [heartbeat_job]
    redis_settings = _redis_settings()

    @staticmethod
    async def on_startup(_ctx: dict[str, Any]) -> None:
        configure_logging(get_settings().log_level)
        logger.info("arq_worker_started")


class SchedulerSettings:
    functions = [chart_watcher_tick]
    redis_settings = _redis_settings()

    @staticmethod
    async def on_startup(_ctx: dict[str, Any]) -> None:
        configure_logging(get_settings().log_level)
        logger.info("arq_scheduler_started")
