from __future__ import annotations

from typing import Protocol

import httpx

from saath_api.core.config import Settings
from saath_api.providers.base import CircuitBreaker, call_with_retry_and_timeout


class TurnstileVerifier(Protocol):
    async def verify(self, token: str, remote_ip: str | None = None) -> bool: ...


class FakeTurnstileVerifier:
    """Deterministic fake Turnstile verifier for dev/test only."""

    _REJECT_TOKENS = frozenset({"", "fail-turnstile", "invalid", "invalid-token"})

    async def verify(self, token: str, remote_ip: str | None = None) -> bool:
        _ = remote_ip
        return token.strip() not in self._REJECT_TOKENS


class CloudflareTurnstileVerifier:
    """Live Cloudflare Turnstile /siteverify adapter."""

    SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"

    def __init__(self, secret_key: str, *, timeout_seconds: float = 3.0) -> None:
        if not secret_key:
            raise ValueError("TURNSTILE_SECRET_KEY is required for CloudflareTurnstileVerifier")
        self._secret_key = secret_key
        self._timeout_seconds = timeout_seconds
        self._breaker = CircuitBreaker(name="cloudflare_turnstile")

    async def verify(self, token: str, remote_ip: str | None = None) -> bool:
        if not token.strip():
            return False

        payload: dict[str, str] = {"secret": self._secret_key, "response": token}
        if remote_ip:
            payload["remoteip"] = remote_ip

        async def _post() -> bool:
            async with httpx.AsyncClient(timeout=self._timeout_seconds) as client:
                resp = await client.post(self.SITEVERIFY_URL, data=payload)
                resp.raise_for_status()
                data = resp.json()
                return bool(data.get("success", False))

        return await call_with_retry_and_timeout(
            _post,
            timeout_seconds=self._timeout_seconds,
            retries=1,
            breaker=self._breaker,
        )


def build_turnstile_verifier(settings: Settings) -> TurnstileVerifier:
    if settings.turnstile_mode == "fake":
        if settings.is_production:
            raise RuntimeError("FakeTurnstileVerifier cannot be used when ENV=production")
        return FakeTurnstileVerifier()
    return CloudflareTurnstileVerifier(secret_key=settings.turnstile_secret_key)
