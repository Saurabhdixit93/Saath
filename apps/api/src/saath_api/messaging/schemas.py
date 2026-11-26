from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class ConversationParticipantDTO(BaseModel):
    alias: str
    alias_ref: str
    is_me: bool
    seat_revealed: str | None = None


class MessageDTO(BaseModel):
    id: UUID
    conversation_id: UUID
    sender_alias: str
    is_me: bool
    client_id: str
    body: str
    lang: str | None = None
    moderation: Literal["ok", "redacted", "hidden"]
    redacted_hint: str | None = None
    created_at: datetime


class ConversationDTO(BaseModel):
    id: UUID
    journey_instance_id: UUID
    service: str
    date: str
    partner_alias: str
    partner_alias_ref: str
    unmasked: bool
    blocked: bool = False
    participants: list[ConversationParticipantDTO]
    last_message: MessageDTO | None = None
    created_at: datetime
    updated_at: datetime


class ConversationListResponse(BaseModel):
    items: list[ConversationDTO]


class CreateConversationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    card_id: str = Field(min_length=4, max_length=128)


class MessagesResponse(BaseModel):
    conversation: ConversationDTO
    items: list[MessageDTO]
    next_before: str | None = None


class SendMessageRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    body: str = Field(min_length=1, max_length=1000)
    client_id: str = Field(min_length=1, max_length=128)
    lang: Literal["en", "hi"] | None = None


class TranslateMessageRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    message_id: UUID
    to: Literal["en", "hi"]


class TranslateMessageResponse(BaseModel):
    message_id: UUID
    translated_text: str
    to: Literal["en", "hi"]


class BlockUserRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    alias_ref: str = Field(min_length=4, max_length=128)


class BlockUserResponse(BaseModel):
    blocked: bool = True


class CreateReportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    conversation_id: UUID
    message_id: UUID | None = None
    reason: str = Field(min_length=2, max_length=500)


class CreateReportResponse(BaseModel):
    report_id: UUID
    status: Literal["open", "reviewed", "dismissed", "actioned"] = "open"
    auto_restricted: bool = False
