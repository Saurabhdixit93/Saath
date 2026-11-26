from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class AnonymousAuthRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    turnstile: str = Field(min_length=1, max_length=4096)


class AnonymousAuthResponse(BaseModel):
    access: str
    token_type: Literal["bearer"] = "bearer"
    expires_in: int


class OtpStartRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    phone: str = Field(min_length=10, max_length=20)
    channel: Literal["whatsapp", "sms"] = "whatsapp"
    turnstile: str = Field(min_length=1, max_length=4096)
    locale: Literal["en", "hi"] = "en"


class OtpStartResponse(BaseModel):
    request_id: str
    resend_after: int


class OtpVerifyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    request_id: str = Field(min_length=1, max_length=128)
    code: str = Field(pattern=r"^[0-9]{6}$")


class NotificationChannelsDTO(BaseModel):
    model_config = ConfigDict(extra="forbid")

    push: bool = True
    whatsapp: bool = True
    sms: bool = True
    quiet_hours_enabled: bool = True


class NotificationChannelsPatchDTO(BaseModel):
    model_config = ConfigDict(extra="forbid")

    push: bool | None = None
    whatsapp: bool | None = None
    sms: bool | None = None
    quiet_hours_enabled: bool | None = None


class UserProfile(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    display_alias: str | None = None
    gender_self: Literal["female", "male", "other", "undisclosed"]
    locale: Literal["en", "hi"]
    women_only_default: bool
    reliability_accepted: int
    reliability_completed: int
    status: Literal["active", "restricted", "banned", "deleted"]
    notification_channels: NotificationChannelsDTO = Field(
        default_factory=NotificationChannelsDTO
    )
    created_at: datetime


class OtpVerifyResponse(BaseModel):
    access: str
    refresh: str
    expires_in: int
    user: UserProfile


class RefreshRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    refresh: str = Field(min_length=16, max_length=512)


class TokenPairResponse(BaseModel):
    access: str
    refresh: str
    expires_in: int


class LogoutResponse(BaseModel):
    ok: bool = True


class UpdateMeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    locale: Literal["en", "hi"] | None = None
    women_only_default: bool | None = None
    display_alias: str | None = Field(default=None, max_length=40)
    gender_self: Literal["female", "male", "other", "undisclosed"] | None = None
    notification_channels: NotificationChannelsPatchDTO | None = None
