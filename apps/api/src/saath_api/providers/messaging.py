from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Protocol

import httpx
import structlog

from saath_api.core.config import Settings
from saath_api.providers.base import CircuitBreaker, ProviderError, call_with_retry_and_timeout

logger = structlog.get_logger(__name__)

OtpChannel = Literal["whatsapp", "sms"]


@dataclass(frozen=True)
class SentOtpRecord:
    phone_e164: str
    code: str
    locale: str
    channel: OtpChannel


@dataclass(frozen=True)
class SentTemplateRecord:
    phone_e164: str
    template_name: str
    locale: str
    params: dict[str, str] = field(default_factory=dict)
    channel: OtpChannel = "whatsapp"


@dataclass(frozen=True)
class SentWhatsAppReplyRecord:
    phone_e164: str
    text: str
    buttons: list[tuple[str, str]] = field(default_factory=list)


class MessagingProvider(Protocol):
    async def send_otp(
        self,
        *,
        phone_e164: str,
        code: str,
        locale: str,
        channel: OtpChannel,
    ) -> None: ...

    async def send_template(
        self,
        *,
        phone_e164: str,
        template_name: str,
        locale: str,
        params: dict[str, str],
        channel: OtpChannel,
    ) -> None: ...

    async def send_whatsapp_reply(
        self,
        *,
        phone_e164: str,
        text: str,
        buttons: list[tuple[str, str]] | None = None,
    ) -> None: ...


class FakeMessagingProvider:
    """In-memory fake messaging adapter for dev/test."""

    def __init__(self) -> None:
        self.sent_messages: list[SentOtpRecord] = []
        self.sent_templates: list[SentTemplateRecord] = []
        self.sent_whatsapp_replies: list[SentWhatsAppReplyRecord] = []
        self.fail_channels: set[OtpChannel] = set()

    async def send_otp(
        self,
        *,
        phone_e164: str,
        code: str,
        locale: str,
        channel: OtpChannel,
    ) -> None:
        if channel in self.fail_channels:
            raise ProviderError(f"Simulated {channel} OTP failure")
        record = SentOtpRecord(
            phone_e164=phone_e164,
            code=code,
            locale=locale,
            channel=channel,
        )
        self.sent_messages.append(record)
        masked = f"***{phone_e164[-4:]}"
        logger.info("fake_otp_dispatched", phone_masked=masked, channel=channel, locale=locale)

    async def send_template(
        self,
        *,
        phone_e164: str,
        template_name: str,
        locale: str,
        params: dict[str, str],
        channel: OtpChannel,
    ) -> None:
        if channel in self.fail_channels:
            raise ProviderError(f"Simulated {channel} template failure")
        record = SentTemplateRecord(
            phone_e164=phone_e164,
            template_name=template_name,
            locale=locale,
            params=dict(params),
            channel=channel,
        )
        self.sent_templates.append(record)
        masked = f"***{phone_e164[-4:]}"
        logger.info(
            "fake_template_dispatched",
            phone_masked=masked,
            template_name=template_name,
            channel=channel,
            locale=locale,
        )

    async def send_whatsapp_reply(
        self,
        *,
        phone_e164: str,
        text: str,
        buttons: list[tuple[str, str]] | None = None,
    ) -> None:
        if "whatsapp" in self.fail_channels:
            raise ProviderError("Simulated whatsapp reply failure")
        record = SentWhatsAppReplyRecord(
            phone_e164=phone_e164,
            text=text,
            buttons=list(buttons or []),
        )
        self.sent_whatsapp_replies.append(record)
        masked = f"***{phone_e164[-4:]}"
        logger.info("fake_whatsapp_reply_dispatched", phone_masked=masked)


class WhatsAppCloudAdapter:
    """Meta WhatsApp Cloud API adapter for OTP, templates, and interactive replies."""

    def __init__(
        self,
        *,
        access_token: str,
        phone_number_id: str,
        timeout_seconds: float = 3.0,
    ) -> None:
        cleaned_token = access_token.strip()
        cleaned_phone_number_id = phone_number_id.strip()
        if not cleaned_token or not cleaned_phone_number_id:
            raise ValueError("WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID are required")
        self._access_token = cleaned_token
        self._phone_number_id = cleaned_phone_number_id
        self._timeout_seconds = timeout_seconds
        self._breaker = CircuitBreaker(name="whatsapp_cloud")

    async def _post_message(self, payload: dict[str, object]) -> None:
        url = f"https://graph.facebook.com/v20.0/{self._phone_number_id}/messages"
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

    async def send_otp(
        self,
        *,
        phone_e164: str,
        code: str,
        locale: str,
        channel: OtpChannel,
    ) -> None:
        _ = channel
        lang_code = "hi" if locale == "hi" else "en_US"
        payload: dict[str, object] = {
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
        await self._post_message(payload)

    async def send_template(
        self,
        *,
        phone_e164: str,
        template_name: str,
        locale: str,
        params: dict[str, str],
        channel: OtpChannel,
    ) -> None:
        _ = channel
        lang_code = "hi" if locale == "hi" else "en_US"
        body_params = [{"type": "text", "text": str(v)} for v in params.values()]
        payload: dict[str, object] = {
            "messaging_product": "whatsapp",
            "to": phone_e164.lstrip("+"),
            "type": "template",
            "template": {
                "name": template_name,
                "language": {"code": lang_code},
                "components": [{"type": "body", "parameters": body_params}] if body_params else [],
            },
        }
        await self._post_message(payload)

    async def send_whatsapp_reply(
        self,
        *,
        phone_e164: str,
        text: str,
        buttons: list[tuple[str, str]] | None = None,
    ) -> None:
        to_number = phone_e164.lstrip("+")
        if buttons:
            payload: dict[str, object] = {
                "messaging_product": "whatsapp",
                "to": to_number,
                "type": "interactive",
                "interactive": {
                    "type": "button",
                    "body": {"text": text},
                    "action": {
                        "buttons": [
                            {
                                "type": "reply",
                                "reply": {"id": btn_id, "title": btn_title[:20]},
                            }
                            for btn_id, btn_title in buttons[:3]
                        ]
                    },
                },
            }
        else:
            payload = {
                "messaging_product": "whatsapp",
                "to": to_number,
                "type": "text",
                "text": {"body": text},
            }
        await self._post_message(payload)


class MSG91SMSAdapter:
    """MSG91 TRAI DLT SMS adapter for OTP and notification delivery."""

    OTP_URL = "https://control.msg91.com/api/v5/otp"
    FLOW_URL = "https://control.msg91.com/api/v5/flow/"

    def __init__(
        self,
        *,
        auth_key: str,
        sender_id: str,
        template_id: str,
        notify_template_id: str = "",
        timeout_seconds: float = 3.0,
    ) -> None:
        cleaned_auth_key = auth_key.strip()
        cleaned_sender_id = sender_id.strip()
        cleaned_template_id = template_id.strip()
        cleaned_notify_template_id = notify_template_id.strip()
        if not cleaned_auth_key or not cleaned_sender_id or not cleaned_template_id:
            raise ValueError(
                "MSG91_AUTH_KEY, MSG91_SENDER_ID, and MSG91_DLT_TE_ID_OTP are required"
            )
        self._auth_key = cleaned_auth_key
        self._sender_id = cleaned_sender_id
        self._template_id = cleaned_template_id
        self._notify_template_id = cleaned_notify_template_id or cleaned_template_id
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
                resp = await client.post(self.OTP_URL, json=payload, headers=headers)
                resp.raise_for_status()

        await call_with_retry_and_timeout(
            _send,
            timeout_seconds=self._timeout_seconds,
            retries=1,
            breaker=self._breaker,
        )

    async def send_template(
        self,
        *,
        phone_e164: str,
        template_name: str,
        locale: str,
        params: dict[str, str],
        channel: OtpChannel,
    ) -> None:
        _ = (template_name, locale, channel)
        payload = {
            "template_id": self._notify_template_id,
            "sender": self._sender_id,
            "short_url": "0",
            "recipients": [
                {
                    "mobiles": phone_e164.lstrip("+"),
                    **{k: str(v) for k, v in params.items()},
                }
            ],
        }
        headers = {"authkey": self._auth_key, "content-type": "application/json"}

        async def _send() -> None:
            async with httpx.AsyncClient(timeout=self._timeout_seconds) as client:
                resp = await client.post(self.FLOW_URL, json=payload, headers=headers)
                resp.raise_for_status()

        await call_with_retry_and_timeout(
            _send,
            timeout_seconds=self._timeout_seconds,
            retries=1,
            breaker=self._breaker,
        )

    async def send_whatsapp_reply(
        self,
        *,
        phone_e164: str,
        text: str,
        buttons: list[tuple[str, str]] | None = None,
    ) -> None:
        _ = (phone_e164, text, buttons)
        raise ProviderError("MSG91SMSAdapter cannot send WhatsApp replies")


class ChannelRoutingMessagingProvider:
    """Routes delivery by channel between WhatsApp and SMS adapters."""

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

    async def send_template(
        self,
        *,
        phone_e164: str,
        template_name: str,
        locale: str,
        params: dict[str, str],
        channel: OtpChannel,
    ) -> None:
        target = self._whatsapp if channel == "whatsapp" else self._sms
        await target.send_template(
            phone_e164=phone_e164,
            template_name=template_name,
            locale=locale,
            params=params,
            channel=channel,
        )

    async def send_whatsapp_reply(
        self,
        *,
        phone_e164: str,
        text: str,
        buttons: list[tuple[str, str]] | None = None,
    ) -> None:
        await self._whatsapp.send_whatsapp_reply(
            phone_e164=phone_e164,
            text=text,
            buttons=buttons,
        )


def build_messaging_provider(settings: Settings) -> MessagingProvider:
    fake_provider: FakeMessagingProvider | None = None

    def _get_fake() -> FakeMessagingProvider:
        nonlocal fake_provider
        if fake_provider is None:
            fake_provider = FakeMessagingProvider()
        return fake_provider

    if settings.whatsapp_mode == "fake":
        if settings.is_production:
            raise RuntimeError("Fake WhatsApp adapter cannot be used when ENV=production")
        wa_adapter: MessagingProvider = _get_fake()
    else:
        wa_adapter = WhatsAppCloudAdapter(
            access_token=settings.whatsapp_access_token,
            phone_number_id=settings.whatsapp_phone_number_id,
        )

    if settings.sms_mode == "fake":
        if settings.is_production:
            raise RuntimeError("Fake SMS adapter cannot be used when ENV=production")
        sms_adapter: MessagingProvider = _get_fake()
    else:
        sms_adapter = MSG91SMSAdapter(
            auth_key=settings.msg91_auth_key,
            sender_id=settings.msg91_sender_id,
            template_id=settings.msg91_dlt_te_id_otp,
            notify_template_id=settings.msg91_dlt_te_id_notify,
        )

    if fake_provider is not None and wa_adapter is fake_provider and sms_adapter is fake_provider:
        return fake_provider

    return ChannelRoutingMessagingProvider(whatsapp=wa_adapter, sms=sms_adapter)
