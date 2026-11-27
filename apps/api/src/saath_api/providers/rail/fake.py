from __future__ import annotations

import re
from datetime import UTC, date, datetime, time, timedelta
from typing import Literal
from zoneinfo import ZoneInfo

from saath_api.journeys.geometry import default_capacity_for_class, seat_to_bay_and_type
from saath_api.providers.rail.protocol import (
    BookingDTO,
    CoachDTO,
    LiveStatusDTO,
    PassengerDTO,
    RailPnrFlushedError,
    RailPnrInvalidError,
    RailPnrNotFoundError,
)
from saath_api.public.train_catalog import get_train_entry, is_valid_train_no

IST = ZoneInfo("Asia/Kolkata")
_PNR_RE = re.compile(r"^[0-9]{10}$")


def _make_pax(
    *,
    pax_seq: int,
    travel_class: str,
    booking_status: str,
    current_status: str,
    coach: str | None,
    seat_no: int | None,
    age_band: Literal["child", "adult", "senior", "unknown"] = "adult",
    gender_band: Literal["F", "M", "U"] = "M",
) -> PassengerDTO:
    if coach is not None and seat_no is not None:
        bay, stype, _ = seat_to_bay_and_type(travel_class, seat_no)
        seat_str = str(seat_no)
    else:
        bay, stype, seat_str = None, None, None
    return PassengerDTO(
        pax_seq=pax_seq,
        booking_status=booking_status,
        current_status=current_status,
        coach=coach,
        seat_no=seat_str,
        seat_type=stype,
        bay=bay,
        age_band=age_band,
        gender_band=gender_band,
    )


def _rajdhani_dates(base_date: date | None = None) -> tuple[date, datetime, datetime]:
    svc_date = base_date or (datetime.now(IST).date() + timedelta(days=2))
    dep_ist = datetime.combine(svc_date, time(16, 55), tzinfo=IST)
    arr_ist = dep_ist + timedelta(hours=15, minutes=40)
    return svc_date, dep_ist.astimezone(UTC), arr_ist.astimezone(UTC)


def _karnataka_dates(base_date: date | None = None) -> tuple[date, datetime, datetime]:
    svc_date = base_date or (datetime.now(IST).date() + timedelta(days=3))
    dep_ist = datetime.combine(svc_date, time(19, 20), tzinfo=IST)
    arr_ist = dep_ist + timedelta(hours=33, minutes=10)
    return svc_date, dep_ist.astimezone(UTC), arr_ist.astimezone(UTC)


def _vande_bharat_dates(base_date: date | None = None) -> tuple[date, datetime, datetime]:
    svc_date = base_date or (datetime.now(IST).date() + timedelta(days=2))
    dep_ist = datetime.combine(svc_date, time(6, 0), tzinfo=IST)
    arr_ist = dep_ist + timedelta(hours=8, minutes=0)
    return svc_date, dep_ist.astimezone(UTC), arr_ist.astimezone(UTC)


class FakeRailProvider:
    """Deterministic fake rail provider with 70-pax 3A Rajdhani, SL, and CC fixtures."""

    name = "fake_rail"

    def __init__(self, *, service_date: date | None = None) -> None:
        self._base_date = service_date
        self._rajdhani_pnrs = self._build_rajdhani_fixtures()

    def _build_rajdhani_fixtures(self) -> dict[str, list[PassengerDTO]]:
        fixtures: dict[str, list[PassengerDTO]] = {
            # Senior on upper berth + split across coaches B5 & B3
            "2415678901": [
                _make_pax(
                    pax_seq=1,
                    travel_class="3A",
                    booking_status="CNF",
                    current_status="CNF",
                    coach="B5",
                    seat_no=11,  # UB
                    age_band="senior",
                    gender_band="F",
                ),
                _make_pax(
                    pax_seq=2,
                    travel_class="3A",
                    booking_status="CNF",
                    current_status="CNF",
                    coach="B3",
                    seat_no=42,  # MB
                    age_band="adult",
                    gender_band="M",
                ),
            ],
            # Solo woman on lower berth
            "2415678902": [
                _make_pax(
                    pax_seq=1,
                    travel_class="3A",
                    booking_status="CNF",
                    current_status="CNF",
                    coach="B5",
                    seat_no=12,  # LB
                    age_band="adult",
                    gender_band="F",
                )
            ],
            # Flexible adult for 3-way swap tests
            "2415678903": [
                _make_pax(
                    pax_seq=1,
                    travel_class="3A",
                    booking_status="CNF",
                    current_status="CNF",
                    coach="B5",
                    seat_no=14,  # UB
                    age_band="adult",
                    gender_band="M",
                )
            ],
            "2415678904": [
                _make_pax(
                    pax_seq=1,
                    travel_class="3A",
                    booking_status="CNF",
                    current_status="CNF",
                    coach="B5",
                    seat_no=15,  # SL
                    age_band="adult",
                    gender_band="M",
                )
            ],
            # RAC passenger
            "2415678905": [
                _make_pax(
                    pax_seq=1,
                    travel_class="3A",
                    booking_status="RAC 12",
                    current_status="RAC 12",
                    coach="B4",
                    seat_no=7,  # SL
                    age_band="adult",
                    gender_band="F",
                )
            ],
            # WL passenger (no coach/seat yet)
            "2415678906": [
                _make_pax(
                    pax_seq=1,
                    travel_class="3A",
                    booking_status="WL 4",
                    current_status="WL 4",
                    coach=None,
                    seat_no=None,
                    age_band="adult",
                    gender_band="M",
                )
            ],
            # M3 cycle & party test PNRs (all single-pax on 12951 Rajdhani 3A)
            "4111111111": [
                _make_pax(
                    pax_seq=1,
                    travel_class="3A",
                    booking_status="CNF",
                    current_status="CNF",
                    coach="B3",
                    seat_no=11,  # UB
                    age_band="senior",
                    gender_band="F",
                )
            ],
            "4222222222": [
                _make_pax(
                    pax_seq=1,
                    travel_class="3A",
                    booking_status="CNF",
                    current_status="CNF",
                    coach="B3",
                    seat_no=20,  # LB
                    age_band="adult",
                    gender_band="M",
                )
            ],
            "4333333333": [
                _make_pax(
                    pax_seq=1,
                    travel_class="3A",
                    booking_status="CNF",
                    current_status="CNF",
                    coach="B3",
                    seat_no=12,  # LB
                    age_band="adult",
                    gender_band="F",
                )
            ],
            # M1 HomeTabs test PNR
            "4512890341": [
                _make_pax(
                    pax_seq=1,
                    travel_class="3A",
                    booking_status="CNF",
                    current_status="CNF",
                    coach="B3",
                    seat_no=42,
                    age_band="adult",
                    gender_band="M",
                ),
                _make_pax(
                    pax_seq=2,
                    travel_class="3A",
                    booking_status="CNF",
                    current_status="CNF",
                    coach="B3",
                    seat_no=44,
                    age_band="adult",
                    gender_band="F",
                ),
            ],
        }

        # Populate additional deterministic passengers to reach 70 total Rajdhani passengers
        total_pax = sum(len(v) for v in fixtures.values())
        coaches = ("B1", "B2", "B3", "B4", "B5")
        idx = 10
        while total_pax < 70:
            pnr = f"24156789{idx:02d}"
            idx += 1
            if pnr in fixtures:
                continue
            coach = coaches[idx % len(coaches)]
            seat_num = ((idx * 7) % 72) + 1
            if idx % 15 == 0:
                pax = _make_pax(
                    pax_seq=1,
                    travel_class="3A",
                    booking_status=f"WL {idx % 9 + 1}",
                    current_status=f"WL {idx % 9 + 1}",
                    coach=None,
                    seat_no=None,
                    age_band="adult",
                    gender_band="F" if idx % 2 == 0 else "M",
                )
            elif idx % 9 == 0:
                rac_seat = ((idx // 9) * 8) - 1
                if rac_seat < 1 or rac_seat > 72:
                    rac_seat = 7
                pax = _make_pax(
                    pax_seq=1,
                    travel_class="3A",
                    booking_status=f"RAC {idx % 18 + 1}",
                    current_status=f"RAC {idx % 18 + 1}",
                    coach=coach,
                    seat_no=rac_seat,
                    age_band="adult",
                    gender_band="F" if idx % 2 == 0 else "M",
                )
            else:
                pax = _make_pax(
                    pax_seq=1,
                    travel_class="3A",
                    booking_status="CNF",
                    current_status="CNF",
                    coach=coach,
                    seat_no=seat_num,
                    age_band="senior" if idx % 11 == 0 else "adult",
                    gender_band="F" if idx % 2 == 0 else "M",
                )
            fixtures[pnr] = [pax]
            total_pax += 1

        return fixtures

    def rajdhani_fixture_pnrs(self) -> dict[str, list[PassengerDTO]]:
        return dict(self._rajdhani_pnrs)

    async def get_pnr(self, pnr: str) -> BookingDTO:
        cleaned = pnr.strip()
        if not _PNR_RE.fullmatch(cleaned):
            raise RailPnrInvalidError("Enter a valid 10-digit Indian Railways PNR.")
        if cleaned in {"0000000000", "9999999999", "9999999991", "9999999992"}:
            raise RailPnrFlushedError(
                "This PNR looks flushed or cancelled. Double-check the 10 digits from your SMS."
            )
        if cleaned == "1111111111":
            raise RailPnrNotFoundError("PNR was not found in rail provider records.")

        if cleaned in self._rajdhani_pnrs:
            svc_date, dep_at, arr_at = _rajdhani_dates(self._base_date)
            return BookingDTO(
                provider=self.name,
                train_no="12951",
                train_name="Mumbai Tejas Rajdhani Express",
                service_date=svc_date,
                travel_class="3A",
                from_code="NDLS",
                to_code="MMCT",
                from_seq=1,
                to_seq=9,
                departure_at=dep_at,
                arrival_at=arr_at,
                chart_state="pending",
                passengers=self._rajdhani_pnrs[cleaned],
            )

        if cleaned == "2415678971":
            svc_date, dep_at, arr_at = _karnataka_dates(self._base_date)
            return BookingDTO(
                provider=self.name,
                train_no="12627",
                train_name="Karnataka Express",
                service_date=svc_date,
                travel_class="SL",
                from_code="SBC",
                to_code="NDLS",
                from_seq=1,
                to_seq=24,
                departure_at=dep_at,
                arrival_at=arr_at,
                chart_state="pending",
                passengers=[
                    _make_pax(
                        pax_seq=1,
                        travel_class="SL",
                        booking_status="CNF",
                        current_status="CNF",
                        coach="S2",
                        seat_no=19,
                        age_band="senior",
                        gender_band="F",
                    ),
                    _make_pax(
                        pax_seq=2,
                        travel_class="SL",
                        booking_status="CNF",
                        current_status="CNF",
                        coach="S4",
                        seat_no=25,
                        age_band="adult",
                        gender_band="M",
                    ),
                ],
            )

        if cleaned == "2415678972":
            svc_date, dep_at, arr_at = _karnataka_dates(self._base_date)
            return BookingDTO(
                provider=self.name,
                train_no="12627",
                train_name="Karnataka Express",
                service_date=svc_date,
                travel_class="SL",
                from_code="SBC",
                to_code="NDLS",
                from_seq=1,
                to_seq=24,
                departure_at=dep_at,
                arrival_at=arr_at,
                chart_state="pending",
                passengers=[
                    _make_pax(
                        pax_seq=1,
                        travel_class="SL",
                        booking_status="RAC 6",
                        current_status="RAC 6",
                        coach="S3",
                        seat_no=15,
                        age_band="adult",
                        gender_band="M",
                    ),
                    _make_pax(
                        pax_seq=2,
                        travel_class="SL",
                        booking_status="WL 2",
                        current_status="WL 2",
                        coach=None,
                        seat_no=None,
                        age_band="adult",
                        gender_band="F",
                    ),
                ],
            )

        if cleaned == "2415678981":
            svc_date, dep_at, arr_at = _vande_bharat_dates(self._base_date)
            return BookingDTO(
                provider=self.name,
                train_no="22436",
                train_name="New Delhi - Varanasi Vande Bharat Express",
                service_date=svc_date,
                travel_class="CC",
                from_code="NDLS",
                to_code="BSB",
                from_seq=1,
                to_seq=4,
                departure_at=dep_at,
                arrival_at=arr_at,
                chart_state="pending",
                passengers=[
                    _make_pax(
                        pax_seq=1,
                        travel_class="CC",
                        booking_status="CNF",
                        current_status="CNF",
                        coach="C2",
                        seat_no=11,
                        age_band="adult",
                        gender_band="F",
                    ),
                    _make_pax(
                        pax_seq=2,
                        travel_class="CC",
                        booking_status="CNF",
                        current_status="CNF",
                        coach="C2",
                        seat_no=12,
                        age_band="adult",
                        gender_band="M",
                    ),
                ],
            )

        # Deterministic synthetic 3A Rajdhani booking for any other valid 10-digit PNR
        seed = int(cleaned)
        svc_date, dep_at, arr_at = _rajdhani_dates(self._base_date)
        coach = f"B{(seed % 5) + 1}"
        seat_one = (seed % 72) + 1
        seat_two = ((seed + 17) % 72) + 1
        return BookingDTO(
            provider=self.name,
            train_no="12951",
            train_name="Mumbai Tejas Rajdhani Express",
            service_date=svc_date,
            travel_class="3A",
            from_code="NDLS",
            to_code="MMCT",
            from_seq=1,
            to_seq=9,
            departure_at=dep_at,
            arrival_at=arr_at,
            chart_state="pending",
            passengers=[
                _make_pax(
                    pax_seq=1,
                    travel_class="3A",
                    booking_status="CNF",
                    current_status="CNF",
                    coach=coach,
                    seat_no=seat_one,
                    age_band="adult",
                    gender_band="F" if seed % 2 == 0 else "M",
                ),
                _make_pax(
                    pax_seq=2,
                    travel_class="3A",
                    booking_status="CNF",
                    current_status="CNF",
                    coach=coach,
                    seat_no=seat_two,
                    age_band="adult",
                    gender_band="M" if seed % 2 == 0 else "F",
                ),
            ],
        )

    async def get_composition(self, train_no: str, service_date: date) -> list[CoachDTO]:
        _ = service_date
        tno = train_no.strip()
        if not is_valid_train_no(tno):
            raise RailPnrNotFoundError(f"Train {tno} was not found.")
        if tno == "12627":
            cap = default_capacity_for_class("SL")
            return [
                CoachDTO(coach=f"S{i}", travel_class="SL", position=i, capacity=cap)
                for i in range(1, 7)
            ]
        if tno == "22436":
            cap = default_capacity_for_class("CC")
            return [
                CoachDTO(coach=f"C{i}", travel_class="CC", position=i, capacity=cap)
                for i in range(1, 5)
            ]
        entry = get_train_entry(tno)
        if entry and entry.classes:
            coaches: list[CoachDTO] = []
            pos = 1
            for cls in entry.classes:
                normalized = (
                    cls if cls in ("1A", "2A", "3A", "3E", "SL", "CC", "EC", "2S") else "3A"
                )
                cap = default_capacity_for_class(normalized)  # type: ignore[arg-type]
                prefix = {
                    "1A": "H",
                    "2A": "A",
                    "3A": "B",
                    "3E": "M",
                    "SL": "S",
                    "CC": "C",
                    "EC": "E",
                    "2S": "D",
                }[normalized]
                count = 1 if normalized in ("1A", "EC") else (2 if normalized == "2A" else 4)
                for idx in range(1, count + 1):
                    coaches.append(
                        CoachDTO(
                            coach=f"{prefix}{idx}",
                            travel_class=normalized,
                            position=pos,
                            capacity=cap,
                        )
                    )
                    pos += 1
            if coaches:
                return coaches
        cap = default_capacity_for_class("3A")
        return [
            CoachDTO(coach=f"B{i}", travel_class="3A", position=i, capacity=cap)
            for i in range(1, 6)
        ]

    async def get_live_status(self, train_no: str, service_date: date) -> LiveStatusDTO:
        tno = train_no.strip()
        if not is_valid_train_no(tno):
            raise RailPnrNotFoundError(f"Train {tno} was not found.")
        entry = get_train_entry(tno)
        current_station = entry.from_code if entry else "NDLS"
        delay = (int(tno) % 15) if tno != "12951" else 0
        return LiveStatusDTO(
            train_no=tno,
            service_date=service_date,
            current_station=current_station,
            delay_minutes=delay,
            chart_state="pending",
        )
