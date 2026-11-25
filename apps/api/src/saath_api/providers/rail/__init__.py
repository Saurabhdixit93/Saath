from __future__ import annotations

from redis.asyncio import Redis

from saath_api.core.config import Settings
from saath_api.providers.rail.adapters import RailProviderA, RailProviderB
from saath_api.providers.rail.fake import FakeRailProvider
from saath_api.providers.rail.protocol import (
    BookingDTO,
    CoachDTO,
    LiveStatusDTO,
    PassengerDTO,
    RailDataProvider,
    RailPnrFlushedError,
    RailPnrInvalidError,
    RailPnrNotFoundError,
    RailProviderError,
)
from saath_api.providers.rail.router import ProviderRouter, RedisCircuitBreaker

__all__ = [
    "BookingDTO",
    "CoachDTO",
    "FakeRailProvider",
    "LiveStatusDTO",
    "PassengerDTO",
    "ProviderRouter",
    "RailDataProvider",
    "RailPnrFlushedError",
    "RailPnrInvalidError",
    "RailPnrNotFoundError",
    "RailProviderA",
    "RailProviderB",
    "RailProviderError",
    "RedisCircuitBreaker",
    "build_rail_router",
]


def build_rail_router(settings: Settings, redis: Redis) -> ProviderRouter:
    timeout_seconds = max(0.5, settings.provider_rail_timeout_ms / 1000.0)
    providers: list[RailDataProvider] = []
    if settings.rail_provider_mode == "live":
        if settings.provider_rail_a_base_url:
            providers.append(
                RailProviderA(
                    base_url=settings.provider_rail_a_base_url,
                    api_key=settings.provider_rail_a_api_key,
                    timeout_seconds=timeout_seconds,
                )
            )
        if settings.provider_rail_b_base_url:
            providers.append(
                RailProviderB(
                    base_url=settings.provider_rail_b_base_url,
                    api_key=settings.provider_rail_b_api_key,
                    timeout_seconds=timeout_seconds,
                )
            )
        if not settings.is_production:
            providers.append(FakeRailProvider())
    else:
        providers.append(FakeRailProvider())

    return ProviderRouter(
        providers=providers,
        redis=redis,
        pnr_pepper=settings.pnr_pepper,
        timeout_seconds=timeout_seconds,
    )
