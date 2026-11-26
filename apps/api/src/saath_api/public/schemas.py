from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from saath_api.journeys.schemas import AircraftLayoutSummaryDTO


class CreateSeatInviteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    coach: str | None = Field(default=None, min_length=1, max_length=12)
    seat_no: str | None = Field(default=None, min_length=1, max_length=8)


class SeatInviteResponse(BaseModel):
    invite_url: str
    token: str
    expires_at: datetime
    message_en: str
    message_hi: str
    target_coach: str | None = None
    target_seat_no: str | None = None
    conversions_count: int = 0


class PublicSeatInviteResponse(BaseModel):
    valid: bool = True
    mode: Literal["train", "flight", "bus"]
    carrier_code: str
    service_no: str
    service_date: date
    target_coach: str | None = None
    target_seat_no: str | None = None
    expires_at: datetime
    conversions_count: int = 0


class PublicPnrStatusItemDTO(BaseModel):
    pax_seq: int
    booking_status: str
    current_status: str
    coach: str | None = None
    seat_type: str | None = None
    bay: int | None = None


class PublicPnrStatusResponse(BaseModel):
    train_no: str
    train_name: str
    service_date: date
    travel_class: str
    from_code: str
    to_code: str
    departure_at: datetime
    arrival_at: datetime
    chart_state: Literal["pending", "first", "final", "na"]
    chart_due_at: datetime | None = None
    passenger_count: int
    confirmed_count: int
    rac_count: int
    wl_count: int
    coaches: list[str]
    berth_types: list[str]
    status_summary: list[PublicPnrStatusItemDTO]


class PublicTrainLiveResponse(BaseModel):
    train_no: str
    train_name: str
    from_code: str | None = None
    to_code: str | None = None
    service_date: date
    current_station: str | None = None
    delay_minutes: int
    chart_state: Literal["pending", "first", "final", "na"]
    chart_due_at: datetime | None = None


class PublicTrainCoachDTO(BaseModel):
    coach: str
    travel_class: str
    position: int
    capacity: int


class PublicTrainCompositionResponse(BaseModel):
    train_no: str
    train_name: str
    from_code: str | None = None
    to_code: str | None = None
    service_date: date
    coaches: list[PublicTrainCoachDTO]


class PublicFlightLayoutsResponse(BaseModel):
    items: list[AircraftLayoutSummaryDTO]


class PublicStatsResponse(BaseModel):
    verified_journeys_count: int
    completed_swaps_count: int
    active_trains_catalog_count: int
    flight_layouts_count: int
