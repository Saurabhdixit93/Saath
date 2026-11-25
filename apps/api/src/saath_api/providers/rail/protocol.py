from __future__ import annotations

from datetime import date, datetime
from typing import Literal, Protocol

from pydantic import BaseModel, Field

from saath_api.providers.base import ProviderError


class RailProviderError(ProviderError):
    """Base error for rail provider operations."""


class RailPnrInvalidError(RailProviderError):
    """Raised when PNR fails 10-digit format validation."""


class RailPnrFlushedError(RailProviderError):
    """Raised when PNR is flushed or cancelled."""


class RailPnrNotFoundError(RailProviderError):
    """Raised when a rail provider reports PNR not found."""


class PassengerDTO(BaseModel):
    """Normalized passenger slot without any passenger name."""

    pax_seq: int
    booking_status: str
    current_status: str
    coach: str | None = None
    seat_no: str | None = None
    seat_type: str | None = None
    bay: int | None = None
    age_band: Literal["child", "adult", "senior", "unknown"] = "unknown"
    gender_band: Literal["F", "M", "U"] = "U"


class BookingDTO(BaseModel):
    provider: str
    train_no: str
    train_name: str
    service_date: date
    travel_class: str
    from_code: str
    to_code: str
    from_seq: int = 1
    to_seq: int = 2
    departure_at: datetime
    arrival_at: datetime
    chart_state: Literal["pending", "first", "final", "na"] = "pending"
    passengers: list[PassengerDTO] = Field(default_factory=list)


class CoachDTO(BaseModel):
    coach: str
    travel_class: str
    position: int
    capacity: int


class LiveStatusDTO(BaseModel):
    train_no: str
    service_date: date
    current_station: str | None = None
    delay_minutes: int = 0
    chart_state: Literal["pending", "first", "final", "na"] = "pending"


class RailDataProvider(Protocol):
    name: str

    async def get_pnr(self, pnr: str) -> BookingDTO: ...

    async def get_composition(self, train_no: str, service_date: date) -> list[CoachDTO]: ...

    async def get_live_status(self, train_no: str, service_date: date) -> LiveStatusDTO: ...
