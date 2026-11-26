from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class CreateSwapRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    card_id: str = Field(min_length=4, max_length=80)
    note: str | None = Field(default=None, max_length=300)


class AcceptSwapRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    version: int = Field(ge=0)


class DeclineSwapRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reason: str | None = Field(default=None, max_length=240)


class ConfirmCompletionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    answer: Literal["yes", "no", "did_not_board"]


class SwapParticipantViewDTO(BaseModel):
    model_config = ConfigDict(extra="forbid")

    alias: str
    decision: Literal["pending", "accepted", "declined"]
    decided_at: datetime | None = None
    post_confirm: Literal["yes", "no", "did_not_board"] | None = None
    is_me: bool
    gives_seat: str | None = None
    gets_seat: str | None = None
    gives_coach: str | None = None
    gets_coach: str | None = None
    gives_seat_type: str | None = None
    gets_seat_type: str | None = None


class SwapDetailDTO(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: UUID
    journey_instance_id: UUID
    kind: Literal["pair", "cycle3", "cycle4", "plan"]
    status: Literal[
        "draft",
        "pending",
        "confirmed",
        "declined",
        "expired",
        "invalidated",
        "cancelled",
        "awaiting_confirmation",
        "completed",
        "not_completed",
    ]
    version: int
    expires_at: datetime
    created_at: datetime
    confirmed_at: datetime | None = None
    note: str | None = None
    decline_reason: str | None = None
    service: str
    date: str
    mode: Literal["train", "flight", "bus"]
    you_give: str
    you_get_summary: str
    participants: list[SwapParticipantViewDTO]
    swap_card_code: str | None = None
    can_accept: bool = False
    can_cancel: bool = False
    can_confirm_completion: bool = False
    my_post_confirm: Literal["yes", "no", "did_not_board"] | None = None


class SwapListResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: list[SwapDetailDTO]


class SwapCardParticipantDTO(BaseModel):
    model_config = ConfigDict(extra="forbid")

    alias: str
    from_seat: str
    to_seat: str
    gives_seat: str
    gets_seat: str
    decided_at: datetime | None = None


class SwapCardJsonResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    proposal_id: UUID
    public_code: str
    signature: str
    public_key: str
    alg: Literal["Ed25519"] = "Ed25519"
    service: str
    date: str
    mode: Literal["train", "flight", "bus"]
    revoked: bool
    revoked_reason: str | None = None
    confirmed_at: datetime
    qr_url: str
    tte_note: str = "Subject to TTE approval"
    participants: list[SwapCardParticipantDTO]


class PublicSwapCardVerifyResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    public_code: str
    valid: bool
    revoked: bool
    revoked_reason: str | None = None
    service: str
    date: str
    mode: Literal["train", "flight", "bus"]
    seats: str
    confirmed_at: datetime
    signature_verified: bool
    tte_note: str = "Subject to TTE approval"
