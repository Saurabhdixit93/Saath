from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

DPDP_PURPOSES = [
    "verification",
    "matching",
    "notifications",
    "analytics",
    "whatsapp",
]

DPDP_NOTICE_VERSION = "1.0"

DpdpPurposeType = Literal[
    "verification",
    "matching",
    "notifications",
    "analytics",
    "whatsapp",
]


class ConsentItemInput(BaseModel):
    purpose: str = Field(..., description="DPDP processing purpose")
    notice_version: str = Field(default=DPDP_NOTICE_VERSION, description="Consent notice version")
    granted: bool = Field(..., description="Whether consent was granted or revoked")


class SaveConsentsRequest(BaseModel):
    consents: list[ConsentItemInput] = Field(
        ..., min_length=1, description="List of consent items to record"
    )


class ConsentRecordDTO(BaseModel):
    purpose: str
    notice_version: str
    granted: bool
    at: datetime | None = None


class ConsentsListResponse(BaseModel):
    notice_version: str = Field(default=DPDP_NOTICE_VERSION)
    purposes: list[str] = Field(default_factory=lambda: list(DPDP_PURPOSES))
    consents: list[ConsentRecordDTO]


class SaveConsentsResponse(BaseModel):
    consents: list[ConsentRecordDTO]


class DeleteAccountResponse(BaseModel):
    status: str = Field(default="erasure_scheduled")
    scheduled_within_hours: int = Field(default=24)
