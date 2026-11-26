from __future__ import annotations

from datetime import date, datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class FlightDeclaredInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    flight_no: str = Field(min_length=3, max_length=10)
    date: date
    seat: str = Field(min_length=2, max_length=5)
    layout_ref: str | None = Field(default=None, max_length=40)


class VerifyJourneyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    mode: Literal["train", "flight", "bus"]
    pnr: str | None = Field(default=None, min_length=10, max_length=10)
    sms_text: str | None = Field(default=None, min_length=10, max_length=2000)
    bcbp: str | None = Field(default=None, min_length=60, max_length=2000)
    leg_index: int = Field(default=0, ge=0, le=3)
    declared: FlightDeclaredInput | None = None
    layout_ref: str | None = Field(default=None, max_length=40)
    invite_token: str | None = Field(default=None, min_length=8, max_length=128)
    open_to_help: bool = False


class SeatHolderOwnDTO(BaseModel):
    id: UUID
    pax_seq: int
    booking_status: str | None = None
    current_status: str | None = None
    coach: str | None = None
    seat_no: str | None = None
    seat_type: str | None = None
    bay: int | None = None
    age_band: Literal["child", "adult", "senior", "unknown"]
    gender_band: Literal["F", "M", "U"]
    linked_user_id: UUID | None = None


class ChartStatusDTO(BaseModel):
    state: Literal["pending", "first", "final", "na"]
    chart_due_at: datetime | None = None
    seconds_until_chart: int | None = None


class JourneySummaryDTO(BaseModel):
    id: UUID
    mode: Literal["train", "flight", "bus"]
    carrier_code: str
    service_no: str
    service_date: date
    departure_at: datetime | None = None
    arrival_at: datetime | None = None
    chart_due_at: datetime | None = None
    chart_state: Literal["pending", "first", "final", "na"]
    layout_ref: str | None = None
    match_version: int


class BookingSummaryDTO(BaseModel):
    id: UUID
    travel_class: str | None = None
    from_code: str | None = None
    to_code: str | None = None
    trust_tier: Literal["verified_provider", "verified_bcbp", "verified_doc", "declared"]
    claim_conflict_flagged: bool
    last_verified_at: datetime | None = None


class GoalConstraintsDTO(BaseModel):
    model_config = ConfigDict(extra="forbid")

    women_only: bool = False
    no_middle: bool = False
    same_coach_only: bool = False
    verified_only: bool = False


class StandingOfferDTO(BaseModel):
    model_config = ConfigDict(extra="forbid")

    give_to: Literal["senior", "women", "anyone"] = "senior"
    note: str | None = Field(default=None, max_length=120)


class GoalDTO(BaseModel):
    id: UUID
    party_id: UUID
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
    movers: list[UUID]
    preferred_seats: list[str]
    constraints: GoalConstraintsDTO
    standing_offer: StandingOfferDTO | None = None
    active: bool
    updated_at: datetime


class SmartSuggestionDTO(BaseModel):
    code: str
    title_key: str
    seat_holder_ids: list[UUID] = Field(default_factory=list)
    recommended_goal_type: str


class PartySummaryDTO(BaseModel):
    id: UUID
    leader_is_me: bool
    members: list[SeatHolderOwnDTO]
    member_count: int
    max_party_members: int
    has_organiser_pass: bool
    invite_expires_at: datetime | None = None


class JourneyCountsDTO(BaseModel):
    coach_active_count: int
    journey_active_count: int


class VerifyPartyRef(BaseModel):
    id: UUID


class VerifyJourneyResponse(BaseModel):
    journey: JourneySummaryDTO
    booking: BookingSummaryDTO
    seat_holders: list[SeatHolderOwnDTO]
    party_id: UUID
    party: VerifyPartyRef
    trust_tier: Literal["verified_provider", "verified_bcbp", "verified_doc", "declared"]
    chart: ChartStatusDTO


class JourneyListItemDTO(BaseModel):
    journey: JourneySummaryDTO
    booking: BookingSummaryDTO
    party_id: UUID
    member_count: int
    seat_holders: list[SeatHolderOwnDTO]
    goal: GoalDTO | None = None


class JourneyListResponse(BaseModel):
    items: list[JourneyListItemDTO]


class JourneyHubResponse(BaseModel):
    journey: JourneySummaryDTO
    chart: ChartStatusDTO
    booking: BookingSummaryDTO
    seat_holders: list[SeatHolderOwnDTO] = Field(default_factory=list)
    party: PartySummaryDTO
    goal: GoalDTO | None = None
    suggestions: list[SmartSuggestionDTO] = Field(default_factory=list)
    counts: JourneyCountsDTO


class DeleteJourneyResponse(BaseModel):
    ok: bool = True
    deleted_booking_id: UUID


class AircraftLayoutSummaryDTO(BaseModel):
    layout_ref: str
    carrier_code: str
    aircraft_name: str
    configuration: str
    rows: int
    columns: list[str]
    aisle_after_indices: list[int]
    exit_rows: list[int]
    premium_rows: list[int]
    total_seats: int


class FlightLayoutsResponse(BaseModel):
    layouts: list[AircraftLayoutSummaryDTO]


class PublicChartTimeResponse(BaseModel):
    train_no: str
    date: date
    chart_due_at: datetime
    rule: str
