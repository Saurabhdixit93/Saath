from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from typing import Any, Protocol

import structlog

from saath_api.core.config import Settings
from saath_api.providers.base import CircuitBreaker, ProviderError, call_with_retry_and_timeout

logger = structlog.get_logger(__name__)


class PushSubscriptionExpiredError(ProviderError):
    """Raised when the push endpoint returns 404 or 410 Gone."""


class PushProviderError(ProviderError):
    """Raised when push delivery fails with a transient or server error."""


@dataclass(frozen=True)
class SentPushRecord:
    endpoint: str
    p256dh: str
    auth: str
    title: str
    body: str
    url: str
    data: dict[str, Any] = field(default_factory=dict)


class WebPushProvider(Protocol):
    async def send_push(
        self,
        *,
        endpoint: str,
        p256dh: str,
        auth: str,
        title: str,
        body: str,
        url: str,
        data: dict[str, Any] | None = None,
    ) -> None: ...


class FakeWebPushProvider:
    """In-memory fake Web Push provider for dev/test."""

    def __init__(self) -> None:
        self.sent_pushes: list[SentPushRecord] = []
        self.expired_endpoints: set[str] = set()
        self.fail_endpoints: set[str] = set()

    async def send_push(
        self,
        *,
        endpoint: str,
        p256dh: str,
        auth: str,
        title: str,
        body: str,
        url: str,
        data: dict[str, Any] | None = None,
    ) -> None:
        if endpoint in self.expired_endpoints:
            raise PushSubscriptionExpiredError("Push subscription expired (410)")
        if endpoint in self.fail_endpoints:
            raise PushProviderError("Simulated push delivery failure")
        record = SentPushRecord(
            endpoint=endpoint,
            p256dh=p256dh,
            auth=auth,
            title=title,
            body=body,
            url=url,
            data=dict(data or {}),
        )
        self.sent_pushes.append(record)
        logger.info("fake_webpush_dispatched", endpoint=endpoint[:48], title=title)


class VAPIDPushAdapter:
    """Production Web Push adapter using pywebpush + VAPID keys."""

    def __init__(
        self,
        *,
        vapid_private_key: str,
        vapid_subject: str,
        timeout_seconds: float = 4.0,
    ) -> None:
        cleaned_priv_key = vapid_private_key.strip()
        cleaned_subject = vapid_subject.strip()
        if not cleaned_priv_key or not cleaned_subject:
            raise ValueError("VAPID_PRIVATE_KEY and VAPID_SUBJECT are required when PUSH_MODE=vapid")
        self._vapid_private_key = cleaned_priv_key
        self._vapid_subject = cleaned_subject
        self._timeout_seconds = timeout_seconds
        self._breaker = CircuitBreaker(name="vapid_webpush")

    async def send_push(
        self,
        *,
        endpoint: str,
        p256dh: str,
        auth: str,
        title: str,
        body: str,
        url: str,
        data: dict[str, Any] | None = None,
    ) -> None:
        from pywebpush import WebPushException, webpush  # type: ignore[import-untyped]

        payload = json.dumps(
            {
                "title": title,
                "body": body,
                "url": url,
                "data": dict(data or {}),
            }
        )
        sub_info = {
            "endpoint": endpoint,
            "keys": {"p256dh": p256dh, "auth": auth},
        }
        vapid_claims = {"sub": self._vapid_subject}

        def _sync_send() -> None:
            try:
                webpush(
                    subscription_info=sub_info,
                    data=payload,
                    vapid_private_key=self._vapid_private_key,
                    vapid_claims=vapid_claims,
                    timeout=self._timeout_seconds,
                )
            except WebPushException as exc:
                status_code = getattr(getattr(exc, "response", None), "status_code", None)
                if status_code in (404, 410):
                    raise PushSubscriptionExpiredError(str(exc)) from exc
                raise PushProviderError(str(exc)) from exc

        async def _send() -> None:
            await asyncio.to_thread(_sync_send)

        try:
            await call_with_retry_and_timeout(
                _send,
                timeout_seconds=self._timeout_seconds,
                retries=1,
                breaker=self._breaker,
            )
        except PushSubscriptionExpiredError:
            raise
        except ProviderError as exc:
            if isinstance(exc.__cause__, PushSubscriptionExpiredError):
                raise exc.__cause__ from exc
            raise PushProviderError(str(exc)) from exc


def build_web_push_provider(settings: Settings) -> WebPushProvider:
    if settings.push_mode == "fake":
        if settings.is_production:
            raise RuntimeError("Fake WebPush adapter cannot be used when ENV=production")
        return FakeWebPushProvider()
    return VAPIDPushAdapter(
        vapid_private_key=settings.vapid_private_key,
        vapid_subject=settings.vapid_subject,
    )
