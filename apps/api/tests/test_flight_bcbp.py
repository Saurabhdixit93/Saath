from __future__ import annotations

from datetime import date
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from saath_api.auth.models import AuditLog
from saath_api.journeys.models import Booking
from saath_api.providers.flight.bcbp import (
    BcbpParseError,
    parse_bcbp,
    resolve_julian_service_date,
)
from saath_api.providers.flight.layouts import (
    AIRCRAFT_LAYOUTS,
    resolve_aircraft_layout,
    validate_and_classify_flight_seat,
)


def _make_bcbp(
    *,
    name: str = "SHARMA/ASHA",
    pnr: str = "AB12CD",
    frm: str = "DEL",
    to: str = "BOM",
    carrier: str = "6E",
    flight: str = "0215",
    julian: str = "330",
    compartment: str = "Y",
    seat: str = "014A",
    seq: str = "0042",
    status: str = "1",
    extra_legs: list[dict[str, str]] | None = None,
) -> str:
    pax = name.ljust(20)[:20]
    pnr_f = pnr.ljust(7)[:7]
    car_f = carrier.ljust(3)[:3]
    flt_f = flight.rjust(4, "0").ljust(5)[:5]
    seat_f = seat.rjust(4, "0")[:4]
    seq_f = seq.rjust(4, "0").ljust(5)[:5]
    legs_count = 1 + (len(extra_legs) if extra_legs else 0)
    base = (
        f"M{legs_count}{pax}E{pnr_f}{frm}{to}{car_f}{flt_f}"
        f"{julian}{compartment}{seat_f}{seq_f}{status}00"
    )
    assert len(base) == 60
    if extra_legs:
        for leg in extra_legs:
            l_pnr = leg.get("pnr", pnr).ljust(7)[:7]
            l_car = leg.get("carrier", carrier).ljust(3)[:3]
            l_flt = leg.get("flight", "0610").rjust(4, "0").ljust(5)[:5]
            l_seat = leg.get("seat", "008F").rjust(4, "0")[:4]
            l_seq = leg.get("seq", "0055").rjust(4, "0").ljust(5)[:5]
            rep = (
                f"{l_pnr}{leg['frm']}{leg['to']}{l_car}{l_flt}"
                f"{leg.get('julian', julian)}{leg.get('compartment', 'Y')}"
                f"{l_seat}{l_seq}{leg.get('status', '1')}00"
            )
            assert len(rep) == 37
            base += rep
    return base


def test_bcbp_15_plus_synthetic_cases() -> None:
    ref = date(2026, 11, 25)
    pepper = "unit-test-pepper"

    # 1. Standard IndiGo single-leg (also verifies .strip() on leading/trailing whitespace)
    res1 = parse_bcbp(f"  {_make_bcbp()}  ", pnr_pepper=pepper, reference_date=ref)
    assert res1.num_legs == 1
    assert res1.legs[0].flight_no == "6E215"
    assert res1.legs[0].seat_no == "14A"

    # 2. Multi-leg (2 legs)
    two_leg = _make_bcbp(
        extra_legs=[{"frm": "BOM", "to": "GOI", "carrier": "6E", "flight": "0710", "seat": "005C"}]
    )
    res2 = parse_bcbp(two_leg, pnr_pepper=pepper, reference_date=ref)
    assert res2.num_legs == 2
    assert res2.legs[1].to_iata == "GOI"
    assert res2.legs[1].seat_no == "5C"

    # 3. 3-leg itinerary
    three_leg = _make_bcbp(
        extra_legs=[
            {"frm": "BOM", "to": "BLR", "flight": "0301", "seat": "010F"},
            {"frm": "BLR", "to": "COK", "flight": "0402", "seat": "003A"},
        ]
    )
    res3 = parse_bcbp(three_leg, pnr_pepper=pepper, reference_date=ref)
    assert res3.num_legs == 3
    assert res3.legs[2].seat_no == "3A"

    # 4. Julian year-rollover Dec -> Jan (ref 2026-12-28, julian 005 -> 2027-01-05)
    assert resolve_julian_service_date(5, reference_date=date(2026, 12, 28)) == date(2027, 1, 5)
    # 5. Julian year-rollover Jan -> Dec (ref 2027-01-02, julian 364 -> 2026-12-30)
    assert resolve_julian_service_date(364, reference_date=date(2027, 1, 2)) == date(2026, 12, 30)
    # 6. Leap year day 366 (ref 2024-12-20 -> 2024-12-31)
    assert resolve_julian_service_date(366, reference_date=date(2024, 12, 20)) == date(2024, 12, 31)

    # 7-10. Compartment mappings F, J, W, Y
    assert parse_bcbp(_make_bcbp(compartment="F"), pnr_pepper=pepper, reference_date=ref).legs[0].travel_class == "F"
    assert parse_bcbp(_make_bcbp(compartment="J"), pnr_pepper=pepper, reference_date=ref).legs[0].travel_class == "J"
    assert parse_bcbp(_make_bcbp(compartment="W"), pnr_pepper=pepper, reference_date=ref).legs[0].travel_class == "W"
    assert parse_bcbp(_make_bcbp(compartment="Y"), pnr_pepper=pepper, reference_date=ref).legs[0].travel_class == "Y"

    # 11. Variable length hex block handled cleanly (including trailing space padding)
    var_bcbp = _make_bcbp()[:-2] + "04ABCD"
    assert parse_bcbp(var_bcbp, pnr_pepper=pepper, reference_date=ref).legs[0].seat_no == "14A"

    var_space_padded = f"  \n\t{_make_bcbp()[:-2]}04AB  \r\n"
    assert parse_bcbp(var_space_padded, pnr_pepper=pepper, reference_date=ref).legs[0].seat_no == "14A"

    two_leg_var_space = _make_bcbp(
        extra_legs=[{"frm": "BOM", "to": "GOI", "carrier": "6E", "flight": "0710", "seat": "005C"}]
    )[:-2] + "04    \r\n"
    res_var2 = parse_bcbp(two_leg_var_space, pnr_pepper=pepper, reference_date=ref)
    assert res_var2.num_legs == 2
    assert res_var2.legs[1].seat_no == "5C"

    # 12-16. Malformed & error cases
    with pytest.raises(BcbpParseError, match="60 characters"):
        parse_bcbp("M1SHORT", pnr_pepper=pepper, reference_date=ref)
    with pytest.raises(BcbpParseError, match="format code"):
        parse_bcbp("X" + _make_bcbp()[1:], pnr_pepper=pepper, reference_date=ref)
    with pytest.raises(BcbpParseError, match="between 1 and 4"):
        parse_bcbp("M5" + _make_bcbp()[2:], pnr_pepper=pepper, reference_date=ref)
    with pytest.raises(BcbpParseError, match="assigned seat"):
        parse_bcbp(_make_bcbp(seat="000 "), pnr_pepper=pepper, reference_date=ref)
    with pytest.raises(BcbpParseError, match="assigned seat"):
        parse_bcbp(_make_bcbp(seat="INF "), pnr_pepper=pepper, reference_date=ref)
    with pytest.raises(BcbpParseError, match="Truncated"):
        parse_bcbp("M2" + _make_bcbp()[2:], pnr_pepper=pepper, reference_date=ref)


def test_seeded_aircraft_layouts_and_seat_validation() -> None:
    required_refs = {
        "6E:A320neo",
        "6E:A321neo",
        "6E:ATR72-600",
        "QP:737-MAX-8",
        "IX:737-8",
        "AI:A320neo",
        "AI:A321neo",
        "AI:B787-8",
        "AI:B777-300ER",
        "SG:737-800",
        "SG:737-MAX-8",
        "generic:3-3",
        "generic:2-2",
        "generic:3-3-3",
        "generic:3-4-3",
        "generic:2-4-2",
        "generic:1-2",
    }
    assert required_refs.issubset(set(AIRCRAFT_LAYOUTS.keys()))

    seat_12a = validate_and_classify_flight_seat("6E:A320neo", "12A")
    assert seat_12a.seat_type == "WS"
    assert seat_12a.is_exit_row is True
    assert seat_12a.is_premium is True

    # Case-insensitive layout resolution
    assert resolve_aircraft_layout("6e:a320neo").layout_ref == "6E:A320neo"
    seat_12a_lower = validate_and_classify_flight_seat("6e:a320neo", "12a")
    assert seat_12a_lower.is_premium is True
    assert resolve_aircraft_layout("6e:atr72").layout_ref == "6E:ATR72-600"

    seat_14b = validate_and_classify_flight_seat("6E:A320neo", "14B")
    assert seat_14b.seat_type == "MS"
    assert seat_14b.is_exit_row is False

    seat_14c = validate_and_classify_flight_seat("6E:A320neo", "14C")
    assert seat_14c.seat_type == "AS"

    # Excluded seats rejected
    with pytest.raises(ValueError, match="does not exist"):
        validate_and_classify_flight_seat("6E:ATR72-600", "20A")
    with pytest.raises(ValueError, match="does not exist"):
        validate_and_classify_flight_seat("6E:A320neo", "99A")


async def test_flight_bcbp_duplicate_claim_409_and_declared_fallback(
    client: AsyncClient,
) -> None:
    anon1 = (await client.post("/v1/auth/anonymous", json={"turnstile": "ok"})).json()["access"]
    anon2 = (await client.post("/v1/auth/anonymous", json={"turnstile": "ok"})).json()["access"]

    today_julian = f"{date.today().timetuple().tm_yday:03d}"
    bcbp_raw = _make_bcbp(
        name="PASSENGER/SECRETNAME",
        pnr="XYZ987",
        julian=today_julian,
        seat="014A",
    )

    resp1 = await client.post(
        "/v1/journeys/verify",
        headers={"Authorization": f"Bearer {anon1}"},
        json={"mode": "flight", "bcbp": bcbp_raw},
    )
    assert resp1.status_code == 200
    body1 = resp1.json()
    assert body1["trust_tier"] == "verified_bcbp"
    assert body1["seat_holders"][0]["seat_no"] == "14A"
    assert "SECRETNAME" not in resp1.text
    assert "XYZ987" not in resp1.text

    # Same PNR + different seat (14B) on another account is allowed for multi-pax family BCBP
    bcbp_14b = _make_bcbp(
        name="PASSENGER/TWO",
        pnr="XYZ987",
        julian=today_julian,
        seat="014B",
    )
    resp_14b = await client.post(
        "/v1/journeys/verify",
        headers={"Authorization": f"Bearer {anon2}"},
        json={"mode": "flight", "bcbp": bcbp_14b},
    )
    assert resp_14b.status_code == 200

    # Same PNR + same seat (14A) on second account -> 409 duplicate_seat_claim + flagged + AuditLog
    dup_resp = await client.post(
        "/v1/journeys/verify",
        headers={"Authorization": f"Bearer {anon2}"},
        json={"mode": "flight", "bcbp": bcbp_raw},
    )
    assert dup_resp.status_code == 409
    assert dup_resp.json()["code"] == "duplicate_seat_claim"

    app: Any = client.app  # type: ignore[attr-defined]
    async with app.state.session_factory() as db:
        booking = (
            await db.execute(select(Booking).where(Booking.id == body1["booking"]["id"]))
        ).scalar_one()
        assert booking.claim_conflict_flagged is True
        audits = (
            await db.execute(
                select(AuditLog).where(AuditLog.action == "flight.duplicate_claim_flagged")
            )
        ).scalars().all()
        assert len(audits) == 1

    # Declared fallback
    declared_resp = await client.post(
        "/v1/journeys/verify",
        headers={"Authorization": f"Bearer {anon1}"},
        json={
            "mode": "flight",
            "declared": {
                "flight_no": "AI804",
                "date": date.today().isoformat(),
                "seat": "18F",
            },
        },
    )
    assert declared_resp.status_code == 200
    assert declared_resp.json()["trust_tier"] == "declared"
    assert declared_resp.json()["chart"]["state"] == "na"
