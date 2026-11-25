from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

CoachClass = Literal["1A", "2A", "3A", "3E", "SL", "CC", "EC", "2S"]
SeatType = Literal["LB", "MB", "UB", "SL", "SM", "SU", "WS", "MS", "AS"]


@dataclass(frozen=True)
class BerthSlot:
    seat_no: int
    label: str
    bay: int
    seat_type: SeatType
    is_side: bool
    x: int
    y: int
    width: int
    height: int


@dataclass(frozen=True)
class CoachLayoutSpec:
    travel_class: CoachClass
    capacity: int
    bay_count: int
    layout_ref: str
    slots: tuple[BerthSlot, ...]


_VALID_CLASSES: frozenset[str] = frozenset({"1A", "2A", "3A", "3E", "SL", "CC", "EC", "2S"})

_DEFAULT_CAPACITY: dict[CoachClass, int] = {
    "1A": 24,
    "2A": 48,
    "3A": 72,
    "3E": 83,
    "SL": 72,
    "CC": 78,
    "EC": 56,
    "2S": 108,
}

_SUPPORTED_VARIANTS: dict[CoachClass, tuple[int, ...]] = {
    "1A": (24, 18),
    "2A": (48, 54),
    "3A": (72, 64),
    "3E": (83,),
    "SL": (72, 80),
    "CC": (78,),
    "EC": (56,),
    "2S": (108,),
}

_MOD8_TYPES: tuple[SeatType, ...] = ("LB", "MB", "UB", "LB", "MB", "UB", "SL", "SU")
_MOD6_2A_TYPES: tuple[SeatType, ...] = ("LB", "UB", "LB", "UB", "SL", "SU")
_MOD9_3E_TYPES: tuple[SeatType, ...] = ("LB", "MB", "UB", "LB", "MB", "UB", "SL", "SM", "SU")
_MOD5_CC_TYPES: tuple[SeatType, ...] = ("WS", "MS", "AS", "AS", "WS")
_MOD4_EC_TYPES: tuple[SeatType, ...] = ("WS", "AS", "AS", "WS")
_MOD6_2S_TYPES: tuple[SeatType, ...] = ("WS", "MS", "AS", "AS", "MS", "WS")


def normalize_coach_class(travel_class: str | None, coach_code: str | None = None) -> CoachClass:
    if travel_class:
        upper = travel_class.strip().upper()
        if upper in _VALID_CLASSES:
            return upper  # type: ignore[return-value]
    if coach_code:
        prefix = coach_code.strip().upper()[:1]
        inferred: dict[str, CoachClass] = {
            "H": "1A",
            "A": "2A",
            "B": "3A",
            "M": "3E",
            "S": "SL",
            "C": "CC",
            "E": "EC",
            "D": "2S",
        }
        if prefix in inferred:
            return inferred[prefix]
    return "3A"


def parse_rail_seat_number(raw_seat: str | int, travel_class: str) -> int:
    if isinstance(raw_seat, int):
        return raw_seat
    cleaned = raw_seat.strip().upper()
    if cleaned.isdigit():
        return int(cleaned)
    # Support 1A cabin-letter notation like "A-1" .. "H-4"
    if travel_class.strip().upper() == "1A" and "-" in cleaned:
        cabin_part, berth_part = cleaned.split("-", 1)
        if len(cabin_part) == 1 and "A" <= cabin_part <= "H" and berth_part.isdigit():
            cabin_idx = ord(cabin_part) - ord("A") + 1
            berth_idx = int(berth_part)
            counts = [4, 2, 4, 2, 4, 2, 4, 2]
            offset = sum(counts[: cabin_idx - 1])
            if 1 <= berth_idx <= counts[cabin_idx - 1]:
                return offset + berth_idx
    digits = "".join(ch for ch in cleaned if ch.isdigit())
    if not digits:
        raise ValueError(f"Invalid rail seat number: {raw_seat!r}")
    return int(digits)


def default_capacity_for_class(travel_class: CoachClass) -> int:
    return _DEFAULT_CAPACITY[travel_class]


def seat_to_bay_and_type(
    travel_class: str,
    seat_no: int | str,
    *,
    capacity: int | None = None,
) -> tuple[int, SeatType, bool]:
    """Return (bay_or_row_1based, seat_type, is_side_berth) for Indian Railways classes."""
    cls = normalize_coach_class(travel_class)
    cap = capacity if capacity is not None else _DEFAULT_CAPACITY[cls]
    if cap not in _SUPPORTED_VARIANTS[cls]:
        raise ValueError(
            f"Unsupported capacity {cap} for class {cls}; expected {_SUPPORTED_VARIANTS[cls]}"
        )

    s = parse_rail_seat_number(seat_no, cls)
    if s < 1 or s > cap:
        raise ValueError(f"Seat {s} out of range 1..{cap} for class {cls}")

    if cls in ("3A", "SL"):
        bay = (s - 1) // 8 + 1
        pos = (s - 1) % 8
        stype = _MOD8_TYPES[pos]
        return bay, stype, pos >= 6

    if cls == "2A":
        bay = (s - 1) // 6 + 1
        pos = (s - 1) % 6
        stype = _MOD6_2A_TYPES[pos]
        return bay, stype, pos >= 4

    if cls == "1A":
        bay_sizes = (4, 2, 4, 2, 4, 2) if cap == 18 else (4, 2, 4, 2, 4, 2, 4, 2)
        running = 0
        for bay_idx, size in enumerate(bay_sizes, start=1):
            if s <= running + size:
                pos = s - running
                stype: SeatType = "LB" if pos % 2 == 1 else "UB"
                return bay_idx, stype, False
            running += size
        raise ValueError(f"Seat {s} out of 1A range")  # pragma: no cover

    if cls == "3E":
        if s <= 81:
            bay = (s - 1) // 9 + 1
            pos = (s - 1) % 9
            return bay, _MOD9_3E_TYPES[pos], pos >= 6
        return 10, ("SL" if s == 82 else "SU"), True

    if cls == "CC":
        if s <= 75:
            row = (s - 1) // 5 + 1
            pos = (s - 1) % 5
            return row, _MOD5_CC_TYPES[pos], False
        row_16_types: tuple[SeatType, ...] = ("WS", "MS", "AS")
        return 16, row_16_types[s - 76], False

    if cls == "EC":
        row = (s - 1) // 4 + 1
        pos = (s - 1) % 4
        return row, _MOD4_EC_TYPES[pos], False

    # cls == "2S"
    row = (s - 1) // 6 + 1
    pos = (s - 1) % 6
    return row, _MOD6_2S_TYPES[pos], False


def build_coach_layout(
    travel_class: str,
    *,
    capacity: int | None = None,
) -> CoachLayoutSpec:
    cls = normalize_coach_class(travel_class)
    cap = capacity if capacity is not None else _DEFAULT_CAPACITY[cls]
    slots: list[BerthSlot] = []

    pad_x = 16
    pad_y = 16
    cell_w = 54
    cell_h = 34
    gap = 6
    aisle = 28

    max_bay = 1
    for s in range(1, cap + 1):
        bay, stype, is_side = seat_to_bay_and_type(cls, s, capacity=cap)
        if bay > max_bay:
            max_bay = bay

        if cls in ("CC", "EC", "2S"):
            row_y = pad_y + (bay - 1) * (cell_h + 10)
            if cls == "CC":
                pos = (s - 1) % 5 if s <= 75 else (s - 76)
                col_x = (
                    pad_x + pos * (cell_w + gap)
                    if pos < 3
                    else pad_x + 3 * (cell_w + gap) + aisle + (pos - 3) * (cell_w + gap)
                )
            elif cls == "EC":
                pos = (s - 1) % 4
                col_x = (
                    pad_x + pos * (cell_w + gap)
                    if pos < 2
                    else pad_x + 2 * (cell_w + gap) + aisle + (pos - 2) * (cell_w + gap)
                )
            else:
                pos = (s - 1) % 6
                col_x = (
                    pad_x + pos * (cell_w + gap)
                    if pos < 3
                    else pad_x + 3 * (cell_w + gap) + aisle + (pos - 3) * (cell_w + gap)
                )
            slots.append(
                BerthSlot(
                    seat_no=s,
                    label=str(s),
                    bay=bay,
                    seat_type=stype,
                    is_side=is_side,
                    x=col_x,
                    y=row_y,
                    width=cell_w,
                    height=cell_h,
                )
            )
            continue

        if cls == "1A":
            bay_h = cell_h * 2 + gap * 2
            bay_y = pad_y + (bay - 1) * (bay_h + 14)
            # Determine position within cabin (4) or coupe (2)
            bay_sizes = (4, 2, 4, 2, 4, 2) if cap == 18 else (4, 2, 4, 2, 4, 2, 4, 2)
            offset = sum(bay_sizes[: bay - 1])
            pos = s - offset - 1  # 0..3 or 0..1
            col = pos // 2
            tier = pos % 2
            x = pad_x + col * (cell_w + gap)
            y = bay_y + (1 - tier) * (cell_h + gap)
            slots.append(
                BerthSlot(
                    seat_no=s,
                    label=str(s),
                    bay=bay,
                    seat_type=stype,
                    is_side=False,
                    x=x,
                    y=y,
                    width=cell_w,
                    height=cell_h,
                )
            )
            continue

        if cls == "2A":
            bay_h = cell_h * 2 + gap
            bay_y = pad_y + (bay - 1) * (bay_h + 16)
            pos = (s - 1) % 6
            if pos < 4:
                col = pos // 2
                tier = pos % 2
                x = pad_x + col * (cell_w + gap)
                y = bay_y + (1 - tier) * (cell_h + gap)
            else:
                x = pad_x + 2 * (cell_w + gap) + aisle
                y = bay_y + (1 - (pos - 4)) * (cell_h + gap)
            slots.append(
                BerthSlot(
                    seat_no=s,
                    label=str(s),
                    bay=bay,
                    seat_type=stype,
                    is_side=is_side,
                    x=x,
                    y=y,
                    width=cell_w,
                    height=cell_h,
                )
            )
            continue

        if cls == "3E":
            bay_h = cell_h * 3 + gap * 2
            bay_y = pad_y + (bay - 1) * (bay_h + 16)
            if s <= 81:
                pos = (s - 1) % 9
                if pos < 6:
                    col = pos // 3
                    tier = pos % 3
                    x = pad_x + col * (cell_w + gap)
                    y = bay_y + (2 - tier) * (cell_h + gap)
                else:
                    tier = pos - 6
                    x = pad_x + 2 * (cell_w + gap) + aisle
                    y = bay_y + (2 - tier) * (cell_h + gap)
            else:
                tier = s - 82
                x = pad_x + 2 * (cell_w + gap) + aisle
                y = bay_y + (2 - tier) * (cell_h + gap)
            slots.append(
                BerthSlot(
                    seat_no=s,
                    label=str(s),
                    bay=bay,
                    seat_type=stype,
                    is_side=is_side,
                    x=x,
                    y=y,
                    width=cell_w,
                    height=cell_h,
                )
            )
            continue

        # 3A and SL (8 per bay)
        bay_h = cell_h * 3 + gap * 2
        bay_y = pad_y + (bay - 1) * (bay_h + 16)
        pos = (s - 1) % 8
        if pos < 6:
            col = pos // 3
            tier = pos % 3
            x = pad_x + col * (cell_w + gap)
            y = bay_y + (2 - tier) * (cell_h + gap)
        else:
            tier = pos - 6
            x = pad_x + 2 * (cell_w + gap) + aisle
            y = bay_y + (2 - tier) * (cell_h + gap * 2)
        slots.append(
            BerthSlot(
                seat_no=s,
                label=str(s),
                bay=bay,
                seat_type=stype,
                is_side=is_side,
                x=x,
                y=y,
                width=cell_w,
                height=cell_h,
            )
        )

    return CoachLayoutSpec(
        travel_class=cls,
        capacity=cap,
        bay_count=max_bay,
        layout_ref=f"IR:{cls}:{cap}",
        slots=tuple(slots),
    )


def generate_train_coach_svg(
    travel_class: str,
    *,
    capacity: int | None = None,
    highlighted_seats: set[int] | None = None,
    coach_label: str = "",
) -> str:
    """Generate a deterministic accessible SVG diagram for a train coach."""
    spec = build_coach_layout(travel_class, capacity=capacity)
    highlighted = highlighted_seats or set()
    max_x = max((slot.x + slot.width for slot in spec.slots), default=240) + 16
    max_y = max((slot.y + slot.height for slot in spec.slots), default=240) + 16

    rects: list[str] = []
    for slot in spec.slots:
        is_mine = slot.seat_no in highlighted
        fill = "#E2572B" if is_mine else "#F3EFE8"
        stroke = "#B83D18" if is_mine else "#C9C0B4"
        text_fill = "#FFFFFF" if is_mine else "#1A1918"
        marker = "●" if is_mine else ""
        rects.append(
            f'<g data-seat="{slot.seat_no}" data-bay="{slot.bay}" data-type="{slot.seat_type}">'
            f'<rect x="{slot.x}" y="{slot.y}" width="{slot.width}" height="{slot.height}" '
            f'rx="6" fill="{fill}" stroke="{stroke}" stroke-width="1.5" />'
            f'<text x="{slot.x + slot.width // 2}" y="{slot.y + 15}" text-anchor="middle" '
            f'font-size="11" font-weight="700" fill="{text_fill}">{marker}{slot.label}</text>'
            f'<text x="{slot.x + slot.width // 2}" y="{slot.y + 28}" text-anchor="middle" '
            f'font-size="9" fill="{text_fill}">{slot.seat_type}</text>'
            f"</g>"
        )

    title = f"Coach {coach_label} ({spec.travel_class})".strip()
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {max_x} {max_y}" '
        f'role="img" aria-label="{title}">'
        f"<title>{title}</title>"
        + "".join(rects)
        + "</svg>"
    )
