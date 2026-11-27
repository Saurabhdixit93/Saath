from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass


class ProviderError(Exception):
    """Raised when an external provider call fails or circuit is open."""


@dataclass
class CircuitBreaker:
    name: str
    failure_threshold: int = 5
    reset_timeout_seconds: float = 30.0
    _failures: int = 0
    _opened_at: float | None = None

    def check(self) -> None:
        if self._opened_at is None:
            return
        if (time.monotonic() - self._opened_at) >= self.reset_timeout_seconds:
            self._opened_at = None
            self._failures = 0
            return
        raise ProviderError(f"Circuit breaker open for provider {self.name}")

    def record_success(self) -> None:
        self._failures = 0
        self._opened_at = None

    def record_failure(self) -> None:
        self._failures += 1
        if self._failures >= self.failure_threshold:
            self._opened_at = time.monotonic()


async def call_with_retry_and_timeout[T](
    fn: Callable[[], Awaitable[T]],
    *,
    timeout_seconds: float = 3.0,
    retries: int = 1,
    breaker: CircuitBreaker | None = None,
) -> T:
    if breaker is not None:
        breaker.check()

    last_exc: Exception | None = None
    for attempt in range(retries + 1):
        try:
            result = await asyncio.wait_for(fn(), timeout=timeout_seconds)
            if breaker is not None:
                breaker.record_success()
            return result
        except Exception as exc:
            last_exc = exc
            if attempt < retries:
                await asyncio.sleep(0.05)

    if breaker is not None:
        breaker.record_failure()
    raise ProviderError(f"Provider call failed after {retries + 1} attempts") from last_exc
