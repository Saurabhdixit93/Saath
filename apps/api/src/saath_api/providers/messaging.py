from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Protocol

import httpx
import structlog

from saath_api.core.config import Settings
from saath_api.providers.base import CircuitBreaker, call_with_retry_and_timeout

logger = structlog.get_logger(__name__)

OtpChannel = Literal["whatsapp", "sms"]


@dataclass(frozen=True)
class SentOtpRecord:
    phone_e164: str
    code: str
    locale: str
    channel: OtpChannel


class MessagingProvider(Protocol):
    async def send_otp(
        self,
        *,
        phone_e164: str,
        code: str,
        locale: str,
        channel: OtpChannel,
    ) -> None: ...


class FakeMessagingProvider:
    """In-memory fake messaging adapter for dev/test."""

    def __init__(self) -> None:
        self.sent_messages: list[SentOtpRecord] = []

    async def send_otp(
        self,
        *,
        phone_e164: str,
        code: str,
        locale: str,
        channel: OtpChannel,
    ) -> None:
        record = SentOtpRecord(
            phone_e164=phone_e164,
            code=code,
            locale=locale,
            channel=channel,
        )
        self.sent_messages.append(record)
        masked = f"***{phone_e164[-4:]}"
        logger.info("fake_otp_dispatched", phone_masked=masked, channel=channel, locale=locale)


class WhatsAppCloudAdapter:
    """Meta WhatsApp Cloud API adapter for OTP template delivery."""

    def __init__(
        self,
        *,
        access_token: str,
        phone_number_id: str,
        timeout_seconds: float = 3.0,
    ) -> None:
        if not access_token or not phone_number_id:
            raise ValueError("WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID are required")
        self._access_token = access_token
        self._phone_number_id = phone_number_id
        self._timeout_seconds = timeout_seconds
        self._breaker = CircuitBreaker(name="whatsapp_cloud")

    async def send_otp(
        self,
        *,
        phone_e164: str,
        code: str,
        locale: str,
        channel: OtpChannel,
    ) -> None:
        _ = channel
        url = f"https://graph.facebook.com/v20.0/{self._phone_number_id}/messages"
        lang_code = "hi" if locale == "hi" else "en_US"
        payload = {
            "messaging_product": "whatsapp",
            "to": phone_e164.lstrip("+"),
            "type": "template",
            "template": {
                "name": "saath_otp_verify",
                "language": {"code": lang_code},
                "components": [
                    {
                        "type": "body",
                        "parameters": [{"type": "text", "text": code}],
                    }
                ],
            },
        }
        headers = {"Authorization": f"Bearer {self._access_token}"}

        async def _send() -> None:
            async with httpx.AsyncClient(timeout=self._timeout_seconds) as client:
                resp = await client.post(url, json=payload, headers=headers)
                resp.raise_for_status()

        await call_with_retry_and_timeout(
            _send,
            timeout_seconds=self._timeout_seconds,
            retries=1,
            breaker=self._breaker,
        )


class MSG91SMSAdapter:
    """MSG91 TRAI DLT SMS adapter for OTP delivery."""

    API_URL = "https://control.msg91.com/api/v5/otp"

    def __init__(
        self,
        *,
        auth_key: str,
        sender_id: str,
        template_id: str,
        timeout_seconds: float = 3.0,
    ) -> None:
        if not auth_key or not template_id:
            raise ValueError("MSG91_AUTH_KEY and MSG91_DLT_TE_ID_OTP are required")
        self._auth_key = auth_key
        self._sender_id = sender_id
        self._template_id = template_id
        self._timeout_seconds = timeout_seconds
        self._breaker = CircuitBreaker(name="msg91_sms")

    async def send_otp(
        self,
        *,
        phone_e164: str,
        code: str,
        locale: str,
        channel: OtpChannel,
    ) -> None:
        _ = (locale, channel)
        payload = {
            "template_id": self._template_id,
            "mobile": phone_e164.lstrip("+"),
            "sender": self._sender_id,
            "otp": code,
        }
        headers = {"authkey": self._auth_key, "content-type": "application/json"}

        async def _send() -> None:
            async with httpx.AsyncClient(timeout=self._timeout_seconds) as client:
                resp = await client.post(self.API_URL, json=payload, headers=headers)
                resp.raise_for_status()

        await call_with_retry_and_timeout(
            _send,
            timeout_seconds=self._timeout_seconds,
            retries=1,
            breaker=self._breaker,
        )


class ChannelRoutingMessagingProvider:
    """Routes OTP delivery by channel between WhatsApp and SMS adapters."""

    def __init__(
        self,
        *,
        whatsapp: MessagingProvider,
        sms: MessagingProvider,
    ) -> None:
        self._whatsapp = whatsapp
        self._sms = sms

    async def send_otp(
        self,
        *,
        phone_e164: str,
        code: str,
        locale: str,
        channel: OtpChannel,
    ) -> None:
        target = self._whatsapp if channel == "whatsapp" else self._sms
        await target.send_otp(
            phone_e164=phone_e164,
            code=code,
            locale=locale,
            channel=channel,
        )


def build_messaging_provider(settings: Settings) -> MessagingProvider:
    fake_provider = FakeMessagingProvider()

    if settings.whatsapp_mode == "fake":
        if settings.is_production:
            raise RuntimeError("Fake WhatsApp adapter cannot be used when ENV=production")
        wa_adapter: MessagingProvider = fake_provider
    else:
        wa_adapter = WhatsAppCloudAdapter(
            access_token=settings.whatsapp_access_token,
            phone_number_id=settings.whatsapp_phone_number_id,
        )

    if settings.sms_mode == "fake":
        if settings.is_production:
            raise RuntimeError("Fake SMS adapter cannot be used when ENV=production")
        sms_adapter: MessagingProvider = fake_provider
    else:
        sms_adapter = MSG91SMSAdapter(
            auth_key=settings.msg91_auth_key,
            sender_id=settings.msg91_sender_id,
            template_id=settings.msg91_dlt_te_id_otp,
        )

    if wa_adapter is fake_provider and sms_adapter is fake_provider:
        return fake_provider

    return ChannelRoutingMessagingProvider(whatsapp=wa_adapter, sms=sms_adapter)
