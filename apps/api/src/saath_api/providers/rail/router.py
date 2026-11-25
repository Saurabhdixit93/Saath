from __future__ import annotations

import asyncio
from datetime import date

import structlog
from redis.asyncio import Redis

from saath_api.core.crypto import hash_pnr
from saath_api.providers.rail.protocol import (
    BookingDTO,
    CoachDTO,
    LiveStatusDTO,
    RailDataProvider,
    RailPnrFlushedError,
    RailPnrInvalidError,
    RailPnrNotFoundError,
    RailProviderError,
)

logger = structlog.get_logger(__name__)

PRE_CHART_CACHE_TTL_SECONDS = 600
POST_CHART_CACHE_TTL_SECONDS = 3600


class RedisCircuitBreaker:
    """Redis-backed circuit breaker shared across worker processes."""

    def __init__(
        self,
        redis: Redis,
        *,
        failure_threshold: int = 5,
        failure_window_seconds: int = 60,
        open_seconds: int = 30,
    ) -> None:
        self._redis = redis
        self._failure_threshold = failure_threshold
        self._failure_window_seconds = failure_window_seconds
        self._open_seconds = open_seconds

    async def is_open(self, provider_name: str) -> bool:
        return bool(await self._redis.exists(f"cb:rail:{provider_name}:open"))

    async def record_success(self, provider_name: str) -> None:
        await self._redis.delete(
            f"cb:rail:{provider_name}:failures",
            f"cb:rail:{provider_name}:open",
        )

    async def record_failure(self, provider_name: str) -> None:
        fail_key = f"cb:rail:{provider_name}:failures"
        count = int(await self._redis.incr(fail_key))
        if count == 1:
            await self._redis.expire(fail_key, self._failure_window_seconds)
        if count >= self._failure_threshold:
            await self._redis.set(
                f"cb:rail:{provider_name}:open",
                "1",
                ex=self._open_seconds,
            )


class ProviderRouter:
    """Ordered rail provider router with timeout, Redis CB, single-flight, and caching."""

    def __init__(
        self,
        *,
        providers: list[RailDataProvider],
        redis: Redis,
        pnr_pepper: str,
        timeout_seconds: float = 3.0,
        retries: int = 1,
        circuit_breaker: RedisCircuitBreaker | None = None,
    ) -> None:
        self._providers = providers
        self._redis = redis
        self._pnr_pepper = pnr_pepper
        self._timeout_seconds = timeout_seconds
        self._retries = retries
        self._cb = circuit_breaker or RedisCircuitBreaker(redis)
        self._inflight: dict[str, asyncio.Future[BookingDTO]] = {}

    async def get_pnr(self, pnr: str, *, force_refresh: bool = False) -> BookingDTO:
        cleaned = pnr.strip()
        if not cleaned.isdigit() or len(cleaned) != 10:
            raise RailPnrInvalidError("Enter a valid 10-digit Indian Railways PNR.")

        pnr_hash_hex = hash_pnr(cleaned, self._pnr_pepper).hex()
        cache_key = f"cache:rail:pnr:{pnr_hash_hex}"

        if not force_refresh:
            cached = await self._redis.get(cache_key)
            if cached:
                return BookingDTO.model_validate_json(cached)

        existing = self._inflight.get(pnr_hash_hex)
        if existing is not None:
            return await existing

        loop = asyncio.get_running_loop()
        fut: asyncio.Future[BookingDTO] = loop.create_future()
        self._inflight[pnr_hash_hex] = fut

        try:
            booking = await self._fetch_pnr_with_fallback(cleaned, cache_key, pnr_hash_hex)
            fut.set_result(booking)
            return booking
        except Exception as exc:
            fut.set_exception(exc)
            raise
        finally:
            self._inflight.pop(pnr_hash_hex, None)

    async def _fetch_pnr_with_fallback(
        self,
        pnr: str,
        cache_key: str,
        pnr_hash_hex: str,
    ) -> BookingDTO:
        lock_key = f"sf:rail:{pnr_hash_hex}"
        acquired_lock = bool(await self._redis.set(lock_key, "1", nx=True, ex=5))
        if not acquired_lock:
            for _ in range(10):
                await asyncio.sleep(0.05)
                cached = await self._redis.get(cache_key)
                if cached:
                    return BookingDTO.model_validate_json(cached)

        try:
            last_exc: Exception | None = None
            for provider in self._providers:
                if await self._cb.is_open(provider.name):
                    logger.info("rail_provider_circuit_open", provider=provider.name)
                    continue

                for attempt in range(self._retries + 1):
                    try:
                        booking = await asyncio.wait_for(
                            provider.get_pnr(pnr),
                            timeout=self._timeout_seconds,
                        )
                        await self._cb.record_success(provider.name)
                        ttl = (
                            POST_CHART_CACHE_TTL_SECONDS
                            if booking.chart_state in ("first", "final")
                            else PRE_CHART_CACHE_TTL_SECONDS
                        )
                        await self._redis.set(cache_key, booking.model_dump_json(), ex=ttl)
                        return booking
                    except (RailPnrInvalidError, RailPnrFlushedError, RailPnrNotFoundError):
                        raise
                    except Exception as exc:
                        last_exc = exc
                        logger.warning(
                            "rail_provider_attempt_failed",
                            provider=provider.name,
                            attempt=attempt + 1,
                            error=str(exc),
                        )
                        if attempt < self._retries:
                            await asyncio.sleep(0.02)

                await self._cb.record_failure(provider.name)

            raise RailProviderError("All configured rail data providers are unavailable.") from (
                last_exc
            )
        finally:
            if acquired_lock:
                await self._redis.delete(lock_key)

    async def get_composition(self, train_no: str, service_date: date) -> list[CoachDTO]:
        for provider in self._providers:
            if await self._cb.is_open(provider.name):
                continue
            try:
                res = await asyncio.wait_for(
                    provider.get_composition(train_no, service_date),
                    timeout=self._timeout_seconds,
                )
                await self._cb.record_success(provider.name)
                return res
            except Exception:
                await self._cb.record_failure(provider.name)
        raise RailProviderError("Unable to fetch train composition.")

    async def get_live_status(self, train_no: str, service_date: date) -> LiveStatusDTO:
        for provider in self._providers:
            if await self._cb.is_open(provider.name):
                continue
            try:
                res = await asyncio.wait_for(
                    provider.get_live_status(train_no, service_date),
                    timeout=self._timeout_seconds,
                )
                await self._cb.record_success(provider.name)
                return res
            except Exception:
                await self._cb.record_failure(provider.name)
        raise RailProviderError("Unable to fetch live train status.")
