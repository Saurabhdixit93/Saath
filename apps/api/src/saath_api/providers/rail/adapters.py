from __future__ import annotations

from datetime import UTC, date, datetime
from typing import Any, Literal

import httpx

from saath_api.journeys.geometry import normalize_coach_class, seat_to_bay_and_type
from saath_api.providers.rail.protocol import (
    BookingDTO,
    CoachDTO,
    LiveStatusDTO,
    PassengerDTO,
    RailPnrFlushedError,
    RailPnrNotFoundError,
    RailProviderError,
)


def _age_band_from_raw(raw_age: Any) -> Literal["child", "adult", "senior", "unknown"]:
    if raw_age is None:
        return "unknown"
    try:
        age = int(raw_age)
    except (TypeError, ValueError):
        return "unknown"
    if age < 18:
        return "child"
    if age >= 60:
        return "senior"
    return "adult"


def _gender_band_from_raw(raw_gender: Any) -> Literal["F", "M", "U"]:
    if not isinstance(raw_gender, str):
        return "U"
    g = raw_gender.strip().upper()[:1]
    if g == "F":
        return "F"
    if g == "M":
        return "M"
    return "U"


def _normalize_vendor_booking(provider_name: str, data: dict[str, Any]) -> BookingDTO:
    # TODO: map live vendor JSON fields when credentials are configured.
    # Passenger names are explicitly ignored and never placed into PassengerDTO.
    travel_class = normalize_coach_class(
        str(data.get("travel_class") or data.get("class") or "3A")
    )
    raw_pax = data.get("passengers") or []
    passengers: list[PassengerDTO] = []
    for idx, item in enumerate(raw_pax, start=1):
        if not isinstance(item, dict):
            continue
        coach = item.get("coach")
        seat_raw = item.get("seat_no") or item.get("berth")
        bay: int | None = None
        seat_type: str | None = None
        seat_str = str(seat_raw).strip() if seat_raw is not None else None
        if coach and seat_str and seat_str.isdigit():
            try:
                bay, seat_type, _ = seat_to_bay_and_type(travel_class, int(seat_str))
            except ValueError:
                bay, seat_type = None, None
        passengers.append(
            PassengerDTO(
                pax_seq=int(item.get("pax_seq") or idx),
                booking_status=str(item.get("booking_status") or "CNF"),
                current_status=str(item.get("current_status") or "CNF"),
                coach=str(coach).upper() if coach else None,
                seat_no=seat_str,
                seat_type=seat_type,
                bay=bay,
                age_band=_age_band_from_raw(item.get("age")),
                gender_band=_gender_band_from_raw(item.get("gender")),
            )
        )

    dep_raw = data.get("departure_at")
    arr_raw = data.get("arrival_at")
    svc_raw = data.get("service_date")
    svc_date = (
        date.fromisoformat(str(svc_raw)) if svc_raw else datetime.now(UTC).date()
    )
    dep_at = (
        datetime.fromisoformat(str(dep_raw))
        if dep_raw
        else datetime.now(UTC)
    )
    arr_at = (
        datetime.fromisoformat(str(arr_raw))
        if arr_raw
        else dep_at
    )
    chart_raw = str(data.get("chart_state") or "pending").lower()
    chart_state: Literal["pending", "first", "final", "na"] = (
        chart_raw  # type: ignore[assignment]
        if chart_raw in ("pending", "first", "final", "na")
        else "pending"
    )
    return BookingDTO(
        provider=provider_name,
        train_no=str(data.get("train_no") or ""),
        train_name=str(data.get("train_name") or ""),
        service_date=svc_date,
        travel_class=travel_class,
        from_code=str(data.get("from_code") or ""),
        to_code=str(data.get("to_code") or ""),
        from_seq=int(data.get("from_seq") or 1),
        to_seq=int(data.get("to_seq") or 2),
        departure_at=dep_at,
        arrival_at=arr_at,
        chart_state=chart_state,
        passengers=passengers,
    )


class _HttpRailAdapter:
    def __init__(
        self,
        *,
        name: str,
        base_url: str,
        api_key: str,
        timeout_seconds: float = 3.0,
    ) -> None:
        self.name = name
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._timeout = timeout_seconds

    def _headers(self) -> dict[str, str]:
        headers = {"Accept": "application/json"}
        if self._api_key:
            headers["X-API-Key"] = self._api_key
        return headers

    async def get_pnr(self, pnr: str) -> BookingDTO:
        if not self._base_url:
            raise RailProviderError(f"{self.name} base URL is not configured")
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            resp = await client.get(
                f"{self._base_url}/pnr/{pnr.strip()}",
                headers=self._headers(),
            )
        if resp.status_code == 410:
            raise RailPnrFlushedError(
                "This PNR looks flushed or cancelled. Double-check the 10 digits from your SMS."
            )
        if resp.status_code == 404:
            raise RailPnrNotFoundError("PNR not found.")
        if resp.status_code >= 400:
            raise RailProviderError(f"{self.name} returned status {resp.status_code}")
        payload = resp.json()
        if not isinstance(payload, dict):
            raise RailProviderError(f"{self.name} returned non-object JSON")
        return _normalize_vendor_booking(self.name, payload)

    async def get_composition(self, train_no: str, service_date: date) -> list[CoachDTO]:
        if not self._base_url:
            raise RailProviderError(f"{self.name} base URL is not configured")
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            resp = await client.get(
                f"{self._base_url}/trains/{train_no.strip()}/composition",
                params={"date": service_date.isoformat()},
                headers=self._headers(),
            )
        if resp.status_code >= 400:
            raise RailProviderError(f"{self.name} composition status {resp.status_code}")
        items = resp.json()
        if not isinstance(items, list):
            return []
        return [CoachDTO.model_validate(item) for item in items]

    async def get_live_status(self, train_no: str, service_date: date) -> LiveStatusDTO:
        if not self._base_url:
            raise RailProviderError(f"{self.name} base URL is not configured")
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            resp = await client.get(
                f"{self._base_url}/trains/{train_no.strip()}/status",
                params={"date": service_date.isoformat()},
                headers=self._headers(),
            )
        if resp.status_code >= 400:
            raise RailProviderError(f"{self.name} live status {resp.status_code}")
        return LiveStatusDTO.model_validate(resp.json())


class RailProviderA(_HttpRailAdapter):
    def __init__(self, *, base_url: str, api_key: str, timeout_seconds: float = 3.0) -> None:
        super().__init__(
            name="rail_provider_a",
            base_url=base_url,
            api_key=api_key,
            timeout_seconds=timeout_seconds,
        )


class RailProviderB(_HttpRailAdapter):
    def __init__(self, *, base_url: str, api_key: str, timeout_seconds: float = 3.0) -> None:
        super().__init__(
            name="rail_provider_b",
            base_url=base_url,
            api_key=api_key,
            timeout_seconds=timeout_seconds,
        )
