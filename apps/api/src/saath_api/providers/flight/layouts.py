from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

FlightSeatType = Literal["WS", "MS", "AS"]


@dataclass(frozen=True)
class AircraftSeat:
    seat_no: str
    row: int
    col: int
    letter: str
    seat_type: FlightSeatType
    is_exit_row: bool
    is_premium: bool


@dataclass(frozen=True)
class AircraftLayoutSpec:
    layout_ref: str
    carrier_code: str
    aircraft_name: str
    configuration: str
    rows: int
    columns: tuple[str, ...]
    aisle_after_indices: tuple[int, ...]
    exit_rows: frozenset[int]
    premium_rows: frozenset[int]
    total_seats: int
    excluded_seats: frozenset[str] = frozenset()


_SEAT_RE = re.compile(r"^0*([1-9][0-9]{0,2})([A-K])$")


def _build_layout(
    *,
    layout_ref: str,
    carrier_code: str,
    aircraft_name: str,
    configuration: str,
    rows: int,
    columns: tuple[str, ...],
    aisle_after_indices: tuple[int, ...],
    exit_rows: frozenset[int],
    premium_rows: frozenset[int],
    excluded_seats: frozenset[str] = frozenset(),
) -> AircraftLayoutSpec:
    total = rows * len(columns) - len(excluded_seats)
    return AircraftLayoutSpec(
        layout_ref=layout_ref,
        carrier_code=carrier_code,
        aircraft_name=aircraft_name,
        configuration=configuration,
        rows=rows,
        columns=columns,
        aisle_after_indices=aisle_after_indices,
        exit_rows=exit_rows,
        premium_rows=premium_rows,
        total_seats=total,
        excluded_seats=excluded_seats,
    )


AIRCRAFT_LAYOUTS: dict[str, AircraftLayoutSpec] = {
    "6E:A320neo": _build_layout(
        layout_ref="6E:A320neo",
        carrier_code="6E",
        aircraft_name="IndiGo Airbus A320neo (186)",
        configuration="3-3",
        rows=31,
        columns=("A", "B", "C", "D", "E", "F"),
        aisle_after_indices=(2,),
        exit_rows=frozenset({12, 13}),
        premium_rows=frozenset({1, 12, 13}),
    ),
    "6E:A321neo": _build_layout(
        layout_ref="6E:A321neo",
        carrier_code="6E",
        aircraft_name="IndiGo Airbus A321neo (222)",
        configuration="3-3",
        rows=37,
        columns=("A", "B", "C", "D", "E", "F"),
        aisle_after_indices=(2,),
        exit_rows=frozenset({17, 18, 28}),
        premium_rows=frozenset({1, 17, 18, 28}),
    ),
    "6E:ATR72-600": _build_layout(
        layout_ref="6E:ATR72-600",
        carrier_code="6E",
        aircraft_name="IndiGo ATR 72-600 (78)",
        configuration="2-2",
        rows=20,
        columns=("A", "C", "D", "F"),
        aisle_after_indices=(1,),
        exit_rows=frozenset({1, 19}),
        premium_rows=frozenset({1}),
        excluded_seats=frozenset({"20A", "20C"}),
    ),
    "QP:737-MAX-8": _build_layout(
        layout_ref="QP:737-MAX-8",
        carrier_code="QP",
        aircraft_name="Akasa Air Boeing 737 MAX 8 (189)",
        configuration="3-3",
        rows=32,
        columns=("A", "B", "C", "D", "E", "F"),
        aisle_after_indices=(2,),
        exit_rows=frozenset({15, 16}),
        premium_rows=frozenset({1, 15, 16}),
        excluded_seats=frozenset({"32A", "32B", "32C"}),
    ),
    "IX:737-8": _build_layout(
        layout_ref="IX:737-8",
        carrier_code="IX",
        aircraft_name="Air India Express Boeing 737-8 (189)",
        configuration="3-3",
        rows=32,
        columns=("A", "B", "C", "D", "E", "F"),
        aisle_after_indices=(2,),
        exit_rows=frozenset({15, 16}),
        premium_rows=frozenset({1, 15, 16}),
        excluded_seats=frozenset({"32A", "32B", "32C"}),
    ),
    "IX:737-8-176": _build_layout(
        layout_ref="IX:737-8-176",
        carrier_code="IX",
        aircraft_name="Air India Express Boeing 737-8 (176)",
        configuration="3-3",
        rows=30,
        columns=("A", "B", "C", "D", "E", "F"),
        aisle_after_indices=(2,),
        exit_rows=frozenset({14, 15}),
        premium_rows=frozenset({1, 14, 15}),
        excluded_seats=frozenset({"30A", "30B", "30C", "1C"}),
    ),
    "AI:A320neo": _build_layout(
        layout_ref="AI:A320neo",
        carrier_code="AI",
        aircraft_name="Air India Airbus A320neo (180)",
        configuration="3-3",
        rows=30,
        columns=("A", "B", "C", "D", "E", "F"),
        aisle_after_indices=(2,),
        exit_rows=frozenset({12, 13}),
        premium_rows=frozenset({1, 2, 3, 12, 13}),
    ),
    "AI:A321neo": _build_layout(
        layout_ref="AI:A321neo",
        carrier_code="AI",
        aircraft_name="Air India Airbus A321neo (222)",
        configuration="3-3",
        rows=37,
        columns=("A", "B", "C", "D", "E", "F"),
        aisle_after_indices=(2,),
        exit_rows=frozenset({17, 18, 28}),
        premium_rows=frozenset({1, 2, 3, 17, 18, 28}),
    ),
    "AI:B787-8": _build_layout(
        layout_ref="AI:B787-8",
        carrier_code="AI",
        aircraft_name="Air India Boeing 787-8 Dreamliner",
        configuration="3-3-3",
        rows=32,
        columns=("A", "B", "C", "D", "E", "G", "H", "J", "K"),
        aisle_after_indices=(2, 5),
        exit_rows=frozenset({12, 24}),
        premium_rows=frozenset({1, 2, 3, 12, 24}),
    ),
    "AI:B777-300ER": _build_layout(
        layout_ref="AI:B777-300ER",
        carrier_code="AI",
        aircraft_name="Air India Boeing 777-300ER",
        configuration="3-3-3",
        rows=42,
        columns=("A", "B", "C", "D", "E", "G", "H", "J", "K"),
        aisle_after_indices=(2, 5),
        exit_rows=frozenset({16, 30}),
        premium_rows=frozenset({1, 2, 3, 16, 30}),
    ),
    "SG:737-800": _build_layout(
        layout_ref="SG:737-800",
        carrier_code="SG",
        aircraft_name="SpiceJet Boeing 737-800 (189)",
        configuration="3-3",
        rows=32,
        columns=("A", "B", "C", "D", "E", "F"),
        aisle_after_indices=(2,),
        exit_rows=frozenset({16, 17}),
        premium_rows=frozenset({1, 16, 17}),
        excluded_seats=frozenset({"32A", "32B", "32C"}),
    ),
    "SG:737-MAX-8": _build_layout(
        layout_ref="SG:737-MAX-8",
        carrier_code="SG",
        aircraft_name="SpiceJet Boeing 737 MAX 8 (189)",
        configuration="3-3",
        rows=32,
        columns=("A", "B", "C", "D", "E", "F"),
        aisle_after_indices=(2,),
        exit_rows=frozenset({15, 16}),
        premium_rows=frozenset({1, 15, 16}),
        excluded_seats=frozenset({"32A", "32B", "32C"}),
    ),
    "AI:A350-900": _build_layout(
        layout_ref="AI:A350-900",
        carrier_code="AI",
        aircraft_name="Air India Airbus A350-900",
        configuration="3-3-3",
        rows=35,
        columns=("A", "B", "C", "D", "E", "G", "H", "J", "K"),
        aisle_after_indices=(2, 5),
        exit_rows=frozenset({14, 27}),
        premium_rows=frozenset({1, 2, 3, 14, 27}),
    ),
    "AI:B787-9": _build_layout(
        layout_ref="AI:B787-9",
        carrier_code="AI",
        aircraft_name="Air India Boeing 787-9 Dreamliner",
        configuration="3-3-3",
        rows=36,
        columns=("A", "B", "C", "D", "E", "G", "H", "J", "K"),
        aisle_after_indices=(2, 5),
        exit_rows=frozenset({14, 26}),
        premium_rows=frozenset({1, 2, 3, 14, 26}),
    ),
    "AI:A319": _build_layout(
        layout_ref="AI:A319",
        carrier_code="AI",
        aircraft_name="Air India Airbus A319 (144)",
        configuration="3-3",
        rows=24,
        columns=("A", "B", "C", "D", "E", "F"),
        aisle_after_indices=(2,),
        exit_rows=frozenset({10, 11}),
        premium_rows=frozenset({1, 2, 10, 11}),
    ),
    "AI:A321ceo": _build_layout(
        layout_ref="AI:A321ceo",
        carrier_code="AI",
        aircraft_name="Air India Airbus A321ceo (210)",
        configuration="3-3",
        rows=35,
        columns=("A", "B", "C", "D", "E", "F"),
        aisle_after_indices=(2,),
        exit_rows=frozenset({16, 17, 27}),
        premium_rows=frozenset({1, 2, 3, 16, 17, 27}),
    ),
    "6E:B777-300ER": _build_layout(
        layout_ref="6E:B777-300ER",
        carrier_code="6E",
        aircraft_name="IndiGo Boeing 777-300ER",
        configuration="3-4-3",
        rows=44,
        columns=("A", "B", "C", "D", "E", "F", "G", "H", "J", "K"),
        aisle_after_indices=(2, 6),
        exit_rows=frozenset({17, 31}),
        premium_rows=frozenset({1, 17, 31}),
    ),
    "IX:A320neo": _build_layout(
        layout_ref="IX:A320neo",
        carrier_code="IX",
        aircraft_name="Air India Express Airbus A320neo (180)",
        configuration="3-3",
        rows=30,
        columns=("A", "B", "C", "D", "E", "F"),
        aisle_after_indices=(2,),
        exit_rows=frozenset({12, 13}),
        premium_rows=frozenset({1, 12, 13}),
    ),
    "SG:Q400": _build_layout(
        layout_ref="SG:Q400",
        carrier_code="SG",
        aircraft_name="SpiceJet Bombardier Q400 (78)",
        configuration="2-2",
        rows=20,
        columns=("A", "C", "D", "F"),
        aisle_after_indices=(1,),
        exit_rows=frozenset({1, 19}),
        premium_rows=frozenset({1}),
        excluded_seats=frozenset({"20A", "20C"}),
    ),
    # Generic layouts for arbitrary airlines / declared fallback
    "generic:3-3": _build_layout(
        layout_ref="generic:3-3",
        carrier_code="GEN",
        aircraft_name="Generic Narrowbody (3-3)",
        configuration="3-3",
        rows=32,
        columns=("A", "B", "C", "D", "E", "F"),
        aisle_after_indices=(2,),
        exit_rows=frozenset({12, 13}),
        premium_rows=frozenset({1}),
    ),
    "generic:2-2": _build_layout(
        layout_ref="generic:2-2",
        carrier_code="GEN",
        aircraft_name="Generic Regional Turboprop (2-2)",
        configuration="2-2",
        rows=20,
        columns=("A", "C", "D", "F"),
        aisle_after_indices=(1,),
        exit_rows=frozenset({1, 19}),
        premium_rows=frozenset({1}),
    ),
    "generic:3-3-3": _build_layout(
        layout_ref="generic:3-3-3",
        carrier_code="GEN",
        aircraft_name="Generic Widebody (3-3-3)",
        configuration="3-3-3",
        rows=40,
        columns=("A", "B", "C", "D", "E", "G", "H", "J", "K"),
        aisle_after_indices=(2, 5),
        exit_rows=frozenset({16, 28}),
        premium_rows=frozenset({1, 16, 28}),
    ),
    "generic:3-4-3": _build_layout(
        layout_ref="generic:3-4-3",
        carrier_code="GEN",
        aircraft_name="Generic High-Density Widebody (3-4-3)",
        configuration="3-4-3",
        rows=44,
        columns=("A", "B", "C", "D", "E", "F", "G", "H", "J", "K"),
        aisle_after_indices=(2, 6),
        exit_rows=frozenset({17, 31}),
        premium_rows=frozenset({1, 17, 31}),
    ),
    "generic:2-4-2": _build_layout(
        layout_ref="generic:2-4-2",
        carrier_code="GEN",
        aircraft_name="Generic Widebody (2-4-2)",
        configuration="2-4-2",
        rows=36,
        columns=("A", "C", "D", "E", "F", "G", "H", "K"),
        aisle_after_indices=(1, 5),
        exit_rows=frozenset({15, 27}),
        premium_rows=frozenset({1, 15, 27}),
    ),
    "generic:1-2": _build_layout(
        layout_ref="generic:1-2",
        carrier_code="GEN",
        aircraft_name="Generic Regional Jet (1-2)",
        configuration="1-2",
        rows=24,
        columns=("A", "D", "F"),
        aisle_after_indices=(0,),
        exit_rows=frozenset({1, 12}),
        premium_rows=frozenset({1}),
    ),
}

_LAYOUT_ALIASES: dict[str, str] = {
    "737 MAX 8": "QP:737-MAX-8",
    "QP:737 MAX 8": "QP:737-MAX-8",
    "SG:737 MAX 8": "SG:737-MAX-8",
    "6E:ATR72": "6E:ATR72-600",
    "3-3": "generic:3-3",
    "2-2": "generic:2-2",
    "3-3-3": "generic:3-3-3",
    "3-4-3": "generic:3-4-3",
    "2-4-2": "generic:2-4-2",
    "1-2": "generic:1-2",
}

_LOWER_LAYOUT_KEYS: dict[str, str] = {k.lower(): k for k in AIRCRAFT_LAYOUTS}
_LOWER_ALIASES: dict[str, str] = {k.lower(): v for k, v in _LAYOUT_ALIASES.items()}

CARRIER_DEFAULT_LAYOUT: dict[str, str] = {
    "6E": "6E:A320neo",
    "QP": "QP:737-MAX-8",
    "IX": "IX:737-8",
    "AI": "AI:A320neo",
    "SG": "SG:737-800",
}


def resolve_aircraft_layout(layout_ref: str | None, carrier_code: str = "") -> AircraftLayoutSpec:
    if layout_ref:
        lowered = layout_ref.strip().lower()
        canonical = _LOWER_ALIASES.get(lowered) or _LOWER_LAYOUT_KEYS.get(lowered)
        if canonical and canonical in AIRCRAFT_LAYOUTS:
            return AIRCRAFT_LAYOUTS[canonical]
    carrier_default = CARRIER_DEFAULT_LAYOUT.get(carrier_code.strip().upper())
    if carrier_default and carrier_default in AIRCRAFT_LAYOUTS:
        return AIRCRAFT_LAYOUTS[carrier_default]
    return AIRCRAFT_LAYOUTS["generic:3-3"]


def _seat_type_for_column(spec: AircraftLayoutSpec, col_idx: int) -> FlightSeatType:
    last_idx = len(spec.columns) - 1
    if col_idx == 0 or col_idx == last_idx:
        return "WS"
    if col_idx in spec.aisle_after_indices or (col_idx - 1) in spec.aisle_after_indices:
        return "AS"
    return "MS"


def validate_and_classify_flight_seat(
    layout_ref: str | None,
    seat_no: str,
    *,
    carrier_code: str = "",
) -> AircraftSeat:
    spec = resolve_aircraft_layout(layout_ref, carrier_code)
    match = _SEAT_RE.fullmatch(seat_no.strip().upper())
    if not match:
        raise ValueError(f"Invalid flight seat number: {seat_no!r}")

    row = int(match.group(1))
    letter = match.group(2)
    normalized = f"{row}{letter}"

    if row < 1 or row > spec.rows:
        raise ValueError(
            f"Row {row} does not exist on aircraft layout {spec.layout_ref} (1..{spec.rows})"
        )
    if letter not in spec.columns:
        raise ValueError(
            f"Seat letter {letter} does not exist on aircraft layout {spec.layout_ref}"
        )
    if normalized in spec.excluded_seats:
        raise ValueError(f"Seat {normalized} does not exist on aircraft layout {spec.layout_ref}")

    col_idx = spec.columns.index(letter)
    return AircraftSeat(
        seat_no=normalized,
        row=row,
        col=col_idx,
        letter=letter,
        seat_type=_seat_type_for_column(spec, col_idx),
        is_exit_row=row in spec.exit_rows,
        is_premium=row in spec.premium_rows,
    )
