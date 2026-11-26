from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field, field_validator


class PushSubscriptionKeysDTO(BaseModel):
    model_config = ConfigDict(extra="forbid")

    p256dh: str = Field(min_length=8, max_length=512)
    auth: str = Field(min_length=4, max_length=256)


class PushSubscriptionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    endpoint: str = Field(min_length=8, max_length=2048)
    keys: PushSubscriptionKeysDTO

    @field_validator("endpoint")
    @classmethod
    def _validate_endpoint_url(cls, value: str) -> str:
        cleaned = value.strip()
        if not (
            cleaned.startswith("https://")
            or cleaned.startswith("http://localhost")
            or cleaned.startswith("http://127.0.0.1")
        ):
            raise ValueError("Push endpoint must be an https:// URL")
        return cleaned


class PushSubscriptionResponse(BaseModel):
    subscribed: bool = True


class WhatsAppWebhookResponse(BaseModel):
    ok: bool = True
    processed: int = 0
    deduped: int = 0
