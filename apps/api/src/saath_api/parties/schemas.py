from __future__ import annotations

from datetime import date, datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from saath_api.journeys.schemas import (
    FlightDeclaredInput,
    GoalConstraintsDTO,
    GoalDTO,
    StandingOfferDTO,
)


class PartyInviteResponse(BaseModel):
    party_id: UUID
    invite_token: str
    invite_url: str
    expires_at: datetime


class PartyJoinRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    invite_token: str = Field(min_length=12, max_length=128)
    mode: Literal["train", "flight"]
    pnr: str | None = Field(default=None, min_length=10, max_length=10)
    sms_text: str | None = Field(default=None, min_length=10, max_length=2000)
    bcbp: str | None = Field(default=None, min_length=60, max_length=2000)
    leg_index: int = Field(default=0, ge=0, le=3)
    declared: FlightDeclaredInput | None = None
    layout_ref: str | None = Field(default=None, max_length=40)


class PutGoalRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    goal_type: Literal[
        "together",
        "lower",
        "upper",
        "same_coach",
        "window",
        "aisle",
        "legroom",
        "specific_seats",
        "open_to_help",
    ]
    movers: list[UUID] = Field(default_factory=list)
    preferred_seats: list[str] = Field(default_factory=list, max_length=4)
    constraints: GoalConstraintsDTO = Field(default_factory=GoalConstraintsDTO)
    standing_offer: StandingOfferDTO | None = None


class GoalMutationResponse(BaseModel):
    goal: GoalDTO
    match_version: int


class DeleteGoalResponse(BaseModel):
    ok: bool = True
    match_version: int


class OrganiserCoachBucket(BaseModel):
    coach: str
    member_count: int
    seat_types: dict[str, int]


class OrganiserSummaryResponse(BaseModel):
    party_id: UUID
    journey_instance_id: UUID
    mode: Literal["train", "flight", "bus"]
    service_no: str
    service_date: date
    member_count: int
    bookings_count: int
    coach_breakdown: list[OrganiserCoachBucket]
    seat_type_breakdown: dict[str, int]
    status_breakdown: dict[str, int]
