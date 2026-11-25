from __future__ import annotations

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class YouGetDTO(BaseModel):
    model_config = ConfigDict(extra="forbid")

    coach: str
    seat_type: str
    bay: int | None = None


class MatchOtherDTO(BaseModel):
    model_config = ConfigDict(extra="forbid")

    alias: str
    trust: str
    reliability: str
    responds_in: str


class MatchSegmentDTO(BaseModel):
    model_config = ConfigDict(extra="forbid")

    overlap: Literal["full", "partial"]


class MatchKarmaPreviewDTO(BaseModel):
    model_config = ConfigDict(extra="forbid")

    you: int


class MatchCardDTO(BaseModel):
    model_config = ConfigDict(extra="forbid")

    card_id: str
    kind: Literal["pair", "cycle3", "cycle4", "plan"]
    score: int = Field(ge=0, le=100)
    label: str
    you_give: str
    you_get: YouGetDTO
    others: list[MatchOtherDTO]
    reasons: list[str]
    reason_codes: list[str] = Field(default_factory=list)
    segment: MatchSegmentDTO
    karma_preview: MatchKarmaPreviewDTO


class MatchesResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    match_version: int
    items: list[MatchCardDTO]


class CoachMapSeatDTO(BaseModel):
    model_config = ConfigDict(extra="forbid")

    seat_no: str
    bay: int
    seat_type: str
    is_side: bool = False
    is_exit_row: bool = False
    is_premium: bool = False
    state: Literal["mine", "party", "match", "incoming", "occupied", "unknown"]
    card_id: str | None = None
    alias: str | None = None


class CoachMapResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    journey_id: UUID
    mode: Literal["train", "flight", "bus"]
    coach: str
    travel_class: str
    layout_ref: str
    match_version: int
    coaches: list[str]
    seats: list[CoachMapSeatDTO]
