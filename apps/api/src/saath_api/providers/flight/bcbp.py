from __future__ import annotations

import hashlib
import hmac
import re
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

IST = ZoneInfo("Asia/Kolkata")
_INVALID_SEAT_VALUES = frozenset({"", "000", "0000", "INF", "GATE", "STBY", "NONE"})
_SEAT_CODE_RE = re.compile(r"^0*([1-9][0-9]{0,2})([A-K])$")


class BcbpParseError(ValueError):
    """Raised when an IATA Resolution 792 BCBP payload is malformed."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class BcbpLeg:
    leg_index: int
    pnr_hash: bytes
    from_iata: str
    to_iata: str
    carrier_code: str
    flight_no: str
    service_date: date
    compartment_code: str
    travel_class: str
    seat_no: str
    checkin_seq: str
    pax_status: str


@dataclass(frozen=True)
class BcbpParseResult:
    num_legs: int
    passenger_name_hint: str  # In-memory only for optional fuzzy check; NEVER persist or log
    electronic_ticket: str
    legs: tuple[BcbpLeg, ...]


def resolve_julian_service_date(
    julian_day: int,
    *,
    reference_date: date | None = None,
) -> date:
    """Convert IATA 3-digit Julian day (001..366) to calendar date with year-rollover heuristic."""
    if julian_day < 1 or julian_day > 366:
        raise BcbpParseError("invalid_bcbp_date", f"Julian day out of range: {julian_day}")

    ref = reference_date or datetime.now(IST).date()
    candidates: list[date] = []
    for year in (ref.year - 1, ref.year, ref.year + 1):
        try:
            candidate = date(year, 1, 1) + timedelta(days=julian_day - 1)
        except ValueError:
            continue
        if candidate.year != year:
            # julian_day == 366 in a non-leap year overflows to next year Jan 1
            continue
        candidates.append(candidate)

    if not candidates:
        raise BcbpParseError("invalid_bcbp_date", "No valid calendar date for Julian day.")

    # Choose candidate closest to reference_date; tie-break toward future
    best = min(
        candidates,
        key=lambda d: (abs((d - ref).days), 0 if d >= ref else 1),
    )
    if best < ref - timedelta(days=7) or best > ref + timedelta(days=365):
        raise BcbpParseError(
            "bcbp_date_out_of_window",
            "Boarding pass travel date is outside the supported window (-7d..+365d).",
        )
    return best


def normalize_bcbp_seat(raw_seat: str) -> str:
    cleaned = raw_seat.strip().upper()
    if cleaned in _INVALID_SEAT_VALUES:
        raise BcbpParseError(
            "invalid_bcbp_seat",
            "Boarding pass does not contain an assigned seat number.",
        )
    match = _SEAT_CODE_RE.fullmatch(cleaned)
    if not match:
        raise BcbpParseError(
            "invalid_bcbp_seat",
            f"Unrecognized boarding pass seat format: {raw_seat!r}.",
        )
    return f"{int(match.group(1))}{match.group(2)}"


def _map_compartment_to_class(compartment: str) -> str:
    c = compartment.strip().upper()
    if c in {"F", "A", "P"}:
        return "F"
    if c in {"J", "C", "D", "I", "Z"}:
        return "J"
    if c in {"W", "E"}:
        return "W"
    return "Y"


def _normalize_flight_no(carrier: str, raw_flight: str) -> str:
    trimmed = raw_flight.strip().upper()
    if not trimmed:
        raise BcbpParseError("malformed_bcbp", "Missing flight number in BCBP.")
    match = re.fullmatch(r"0*([1-9][0-9]*)([A-Z]?)", trimmed)
    if match:
        return f"{carrier}{match.group(1)}{match.group(2)}"
    return f"{carrier}{trimmed}"


def _hash_pnr(pnr: str, pnr_pepper: str) -> bytes:
    return hmac.new(
        pnr_pepper.encode("utf-8"),
        pnr.strip().upper().encode("utf-8"),
        hashlib.sha256,
    ).digest()


def _parse_leg_fields(
    *,
    leg_index: int,
    pnr_raw: str,
    from_raw: str,
    to_raw: str,
    carrier_raw: str,
    flight_raw: str,
    julian_raw: str,
    compartment_raw: str,
    seat_raw: str,
    seq_raw: str,
    status_raw: str,
    pnr_pepper: str,
    reference_date: date | None,
) -> BcbpLeg:
    pnr = pnr_raw.strip().upper()
    if len(pnr) < 5 or not re.fullmatch(r"[A-Z0-9]{5,7}", pnr):
        raise BcbpParseError("malformed_bcbp", "Invalid PNR code in BCBP payload.")
    from_iata = from_raw.strip().upper()
    to_iata = to_raw.strip().upper()
    if not re.fullmatch(r"[A-Z]{3}", from_iata) or not re.fullmatch(r"[A-Z]{3}", to_iata):
        raise BcbpParseError("malformed_bcbp", "Invalid airport IATA codes in BCBP payload.")
    carrier = carrier_raw.strip().upper()
    if not re.fullmatch(r"[A-Z0-9]{2,3}", carrier):
        raise BcbpParseError("malformed_bcbp", "Invalid carrier code in BCBP payload.")

    flight_no = _normalize_flight_no(carrier, flight_raw)
    if not julian_raw.strip().isdigit():
        raise BcbpParseError("invalid_bcbp_date", "Julian flight date must be numeric.")
    service_date = resolve_julian_service_date(
        int(julian_raw.strip()), reference_date=reference_date
    )
    compartment = compartment_raw.strip().upper() or "Y"
    seat_no = normalize_bcbp_seat(seat_raw)

    return BcbpLeg(
        leg_index=leg_index,
        pnr_hash=_hash_pnr(pnr, pnr_pepper),
        from_iata=from_iata,
        to_iata=to_iata,
        carrier_code=carrier,
        flight_no=flight_no,
        service_date=service_date,
        compartment_code=compartment,
        travel_class=_map_compartment_to_class(compartment),
        seat_no=seat_no,
        checkin_seq=seq_raw.strip(),
        pax_status=status_raw.strip(),
    )


def parse_bcbp(
    raw: str,
    *,
    pnr_pepper: str,
    reference_date: date | None = None,
) -> BcbpParseResult:
    """Parse an IATA Resolution 792 single- or multi-leg BCBP barcode string."""
    raw = raw.lstrip().rstrip("\r\n\t") if raw else ""
    if not raw or len(raw) < 60:
        raise BcbpParseError(
            "malformed_bcbp",
            "Boarding pass barcode payload must be at least 60 characters.",
        )

    if raw[0] != "M":
        raise BcbpParseError("malformed_bcbp", "BCBP format code must be 'M'.")

    if not raw[1].isdigit():
        raise BcbpParseError("malformed_bcbp", "BCBP number of legs must be 1-4.")
    num_legs = int(raw[1])
    if num_legs < 1 or num_legs > 4:
        raise BcbpParseError("malformed_bcbp", "BCBP number of legs must be between 1 and 4.")

    pax_name_hint = raw[2:22].strip()
    eticket = raw[22:23]

    try:
        leg1_var_len = int(raw[58:60], 16)
    except ValueError as exc:
        raise BcbpParseError("malformed_bcbp", "Invalid BCBP leg 1 variable length field.") from exc

    if len(raw) < 60 + leg1_var_len:
        raise BcbpParseError("malformed_bcbp", "Truncated BCBP variable field on leg 1.")

    legs: list[BcbpLeg] = [
        _parse_leg_fields(
            leg_index=0,
            pnr_raw=raw[23:30],
            from_raw=raw[30:33],
            to_raw=raw[33:36],
            carrier_raw=raw[36:39],
            flight_raw=raw[39:44],
            julian_raw=raw[44:47],
            compartment_raw=raw[47:48],
            seat_raw=raw[48:52],
            seq_raw=raw[52:57],
            status_raw=raw[57:58],
            pnr_pepper=pnr_pepper,
            reference_date=reference_date,
        )
    ]

    cursor = 60 + leg1_var_len
    for idx in range(1, num_legs):
        if len(raw) < cursor + 37:
            raise BcbpParseError(
                "malformed_bcbp",
                f"Truncated BCBP repeated mandatory block for leg {idx + 1}.",
            )
        block = raw[cursor : cursor + 37]
        try:
            var_len = int(block[35:37], 16)
        except ValueError as exc:
            raise BcbpParseError(
                "malformed_bcbp", f"Invalid variable length on leg {idx + 1}."
            ) from exc
        if len(raw) < cursor + 37 + var_len:
            raise BcbpParseError("malformed_bcbp", f"Truncated variable block on leg {idx + 1}.")

        legs.append(
            _parse_leg_fields(
                leg_index=idx,
                pnr_raw=block[0:7],
                from_raw=block[7:10],
                to_raw=block[10:13],
                carrier_raw=block[13:16],
                flight_raw=block[16:21],
                julian_raw=block[21:24],
                compartment_raw=block[24:25],
                seat_raw=block[25:29],
                seq_raw=block[29:34],
                status_raw=block[34:35],
                pnr_pepper=pnr_pepper,
                reference_date=reference_date,
            )
        )
        cursor += 37 + var_len

    return BcbpParseResult(
        num_legs=num_legs,
        passenger_name_hint=pax_name_hint,
        electronic_ticket=eticket,
        legs=tuple(legs),
    )
