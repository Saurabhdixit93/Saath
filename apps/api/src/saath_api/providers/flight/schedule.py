from __future__ import annotations

from datetime import UTC, date, datetime, time, timedelta
from typing import Any, Protocol
from zoneinfo import ZoneInfo

import httpx
from pydantic import BaseModel

from saath_api.core.config import Settings
from saath_api.providers.base import CircuitBreaker, ProviderError, call_with_retry_and_timeout
from saath_api.providers.flight.layouts import CARRIER_DEFAULT_LAYOUT

IST = ZoneInfo("Asia/Kolkata")


class FlightScheduleDTO(BaseModel):
    carrier_code: str
    service_no: str
    service_date: date
    from_code: str
    to_code: str
    departure_at: datetime
    arrival_at: datetime
    layout_ref: str


class FlightScheduleProvider(Protocol):
    name: str

    async def lookup_flight(
        self,
        *,
        carrier_code: str,
        service_no: str,
        service_date: date,
        from_code: str | None = None,
        to_code: str | None = None,
    ) -> FlightScheduleDTO: ...


_KNOWN_SCHEDULES: dict[str, tuple[str, str, str, int, int, int]] = {
    # flight_no -> (from_iata, to_iata, layout_ref, dep_h, dep_m, duration_m)
    "6E215": ("DEL", "BOM", "6E:A320neo", 9, 30, 130),
    "6E6101": ("BLR", "DEL", "6E:A321neo", 14, 15, 165),
    "6E7102": ("BLR", "GOI", "6E:ATR72-600", 11, 10, 75),
    "QP1102": ("BOM", "BLR", "QP:737-MAX-8", 16, 45, 105),
    "IX123": ("DEL", "IXB", "IX:737-8", 8, 20, 125),
    "AI804": ("BOM", "DEL", "AI:A320neo", 18, 0, 135),
    "AI101": ("DEL", "JFK", "AI:B777-300ER", 2, 15, 900),
    "AI302": ("DEL", "SIN", "AI:B787-8", 23, 10, 340),
    "SG152": ("DEL", "GOI", "SG:737-800", 12, 40, 155),
}


class FakeFlightScheduleProvider:
    name = "fake_flight_schedule"

    async def lookup_flight(
        self,
        *,
        carrier_code: str,
        service_no: str,
        service_date: date,
        from_code: str | None = None,
        to_code: str | None = None,
    ) -> FlightScheduleDTO:
        carrier = carrier_code.strip().upper()
        svc = service_no.strip().upper()
        key = svc if svc.startswith(carrier) else f"{carrier}{svc}"

        known = _KNOWN_SCHEDULES.get(key)
        if known:
            default_from, default_to, layout_ref, dep_h, dep_m, dur_m = known
        else:
            default_from = "DEL"
            default_to = "BOM"
            layout_ref = CARRIER_DEFAULT_LAYOUT.get(carrier, "generic:3-3")
            dep_h, dep_m, dur_m = 10, 30, 130

        dep_ist = datetime.combine(service_date, time(dep_h, dep_m), tzinfo=IST)
        arr_ist = dep_ist + timedelta(minutes=dur_m)
        return FlightScheduleDTO(
            carrier_code=carrier,
            service_no=key,
            service_date=service_date,
            from_code=(from_code or default_from).upper(),
            to_code=(to_code or default_to).upper(),
            departure_at=dep_ist.astimezone(UTC),
            arrival_at=arr_ist.astimezone(UTC),
            layout_ref=layout_ref,
        )


def _parse_utc_datetime(raw_value: object) -> datetime:
    dt = datetime.fromisoformat(str(raw_value))
    if dt.tzinfo is None:
        return dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC)


class LiveFlightScheduleProvider:
    name = "live_flight_schedule"

    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        timeout_seconds: float = 3.0,
    ) -> None:
        cleaned_url = base_url.strip().rstrip("/")
        if not cleaned_url:
            raise ValueError("PROVIDER_FLIGHT_BASE_URL is required for LiveFlightScheduleProvider")
        self._base_url = cleaned_url
        self._api_key = api_key.strip()
        self._timeout_seconds = timeout_seconds
        self._breaker = CircuitBreaker(name="flight_schedule")

    async def lookup_flight(
        self,
        *,
        carrier_code: str,
        service_no: str,
        service_date: date,
        from_code: str | None = None,
        to_code: str | None = None,
    ) -> FlightScheduleDTO:
        if not self._base_url:
            raise ProviderError("Live flight schedule provider URL is not configured")
        headers = {"Accept": "application/json"}
        if self._api_key:
            headers["X-API-Key"] = self._api_key

        async def _fetch() -> dict[str, Any]:
            try:
                async with httpx.AsyncClient(timeout=self._timeout_seconds) as client:
                    resp = await client.get(
                        f"{self._base_url}/flights/{service_no.strip().upper()}",
                        params={"date": service_date.isoformat(), "carrier": carrier_code},
                        headers=headers,
                    )
                if resp.status_code >= 400:
                    raise ProviderError(f"Flight schedule provider returned {resp.status_code}")
                payload = resp.json()
            except ProviderError:
                raise
            except (httpx.HTTPError, ValueError) as exc:
                raise ProviderError(f"Flight schedule lookup failed: {exc}") from exc

            if not isinstance(payload, dict):
                raise ProviderError("Flight schedule provider returned invalid JSON payload")
            return payload

        data = await call_with_retry_and_timeout(
            _fetch,
            timeout_seconds=self._timeout_seconds,
            retries=1,
            breaker=self._breaker,
        )
        # TODO: adjust field mapping to live flight schedule provider contract.
        try:
            departure_at = _parse_utc_datetime(data["departure_at"])
            arrival_at = _parse_utc_datetime(data["arrival_at"])
        except (KeyError, TypeError, ValueError) as exc:
            raise ProviderError(f"Invalid flight schedule response payload: {exc}") from exc

        return FlightScheduleDTO(
            carrier_code=str(data.get("carrier_code") or carrier_code).upper(),
            service_no=str(data.get("service_no") or service_no).upper(),
            service_date=service_date,
            from_code=str(data.get("from_code") or from_code or "DEL").upper(),
            to_code=str(data.get("to_code") or to_code or "BOM").upper(),
            departure_at=departure_at,
            arrival_at=arrival_at,
            layout_ref=str(
                data.get("layout_ref")
                or CARRIER_DEFAULT_LAYOUT.get(carrier_code.upper(), "generic:3-3")
            ),
        )


def build_flight_schedule_provider(settings: Settings) -> FlightScheduleProvider:
    if settings.flight_provider_mode == "live":
        base_url = settings.provider_flight_base_url.strip()
        if base_url:
            return LiveFlightScheduleProvider(
                base_url=base_url,
                api_key=settings.provider_flight_api_key,
            )
        if settings.is_production:
            raise RuntimeError(
                "PROVIDER_FLIGHT_BASE_URL is required when ENV=production and FLIGHT_PROVIDER_MODE=live"
            )
    elif settings.is_production:
        raise RuntimeError("FakeFlightScheduleProvider cannot be used when ENV=production")
    return FakeFlightScheduleProvider()
