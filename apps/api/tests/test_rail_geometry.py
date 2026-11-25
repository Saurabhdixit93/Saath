from __future__ import annotations

import pytest

from saath_api.journeys.geometry import (
    build_coach_layout,
    default_capacity_for_class,
    generate_train_coach_svg,
    normalize_coach_class,
    parse_rail_seat_number,
    seat_to_bay_and_type,
)


def test_default_capacities_and_normalize_class() -> None:
    expected_caps = {
        "1A": 24,
        "2A": 48,
        "3A": 72,
        "3E": 83,
        "SL": 72,
        "CC": 78,
        "EC": 56,
        "2S": 108,
    }
    for cls, cap in expected_caps.items():
        assert default_capacity_for_class(cls) == cap  # type: ignore[arg-type]
        assert normalize_coach_class(cls.lower()) == cls

    assert normalize_coach_class(None, "H1") == "1A"
    assert normalize_coach_class(None, "A2") == "2A"
    assert normalize_coach_class(None, "B5") == "3A"
    assert normalize_coach_class(None, "M1") == "3E"
    assert normalize_coach_class(None, "S4") == "SL"
    assert normalize_coach_class(None, "C3") == "CC"
    assert normalize_coach_class(None, "E1") == "EC"
    assert normalize_coach_class(None, "D2") == "2S"
    assert normalize_coach_class(None, None) == "3A"


def test_3a_and_sl_mod8_geometry_and_variants() -> None:
    assert seat_to_bay_and_type("3A", 1) == (1, "LB", False)
    assert seat_to_bay_and_type("3A", 2) == (1, "MB", False)
    assert seat_to_bay_and_type("3A", 3) == (1, "UB", False)
    assert seat_to_bay_and_type("3A", 4) == (1, "LB", False)
    assert seat_to_bay_and_type("3A", 5) == (1, "MB", False)
    assert seat_to_bay_and_type("3A", 6) == (1, "UB", False)
    assert seat_to_bay_and_type("3A", 7) == (1, "SL", True)
    assert seat_to_bay_and_type("3A", 8) == (1, "SU", True)
    assert seat_to_bay_and_type("3A", 72) == (9, "SU", True)
    assert seat_to_bay_and_type("3A", 64, capacity=64) == (8, "SU", True)
    assert seat_to_bay_and_type("SL", 80, capacity=80) == (10, "SU", True)


def test_2a_1a_3e_cc_ec_2s_geometry() -> None:
    # 2A (48 default, 54 variant)
    assert seat_to_bay_and_type("2A", 1) == (1, "LB", False)
    assert seat_to_bay_and_type("2A", 2) == (1, "UB", False)
    assert seat_to_bay_and_type("2A", 5) == (1, "SL", True)
    assert seat_to_bay_and_type("2A", 6) == (1, "SU", True)
    assert seat_to_bay_and_type("2A", 54, capacity=54) == (9, "SU", True)

    # 1A (24 LHB alternating 4/2, 18 ICF, and A-1..H-2 cabin notation)
    assert seat_to_bay_and_type("1A", 1) == (1, "LB", False)
    assert seat_to_bay_and_type("1A", 4) == (1, "UB", False)
    assert seat_to_bay_and_type("1A", 5) == (2, "LB", False)
    assert seat_to_bay_and_type("1A", 6) == (2, "UB", False)
    assert seat_to_bay_and_type("1A", 24) == (8, "UB", False)
    assert seat_to_bay_and_type("1A", 18, capacity=18) == (6, "UB", False)
    assert parse_rail_seat_number("A-1", "1A") == 1
    assert parse_rail_seat_number("B-2", "1A") == 6
    assert seat_to_bay_and_type("1A", "C-3") == (3, "LB", False)

    # 3E (83 berths: 9x9 + bay 10 with 82:SL, 83:SU)
    assert seat_to_bay_and_type("3E", 7) == (1, "SL", True)
    assert seat_to_bay_and_type("3E", 8) == (1, "SM", True)
    assert seat_to_bay_and_type("3E", 9) == (1, "SU", True)
    assert seat_to_bay_and_type("3E", 81) == (9, "SU", True)
    assert seat_to_bay_and_type("3E", 82) == (10, "SL", True)
    assert seat_to_bay_and_type("3E", 83) == (10, "SU", True)

    # CC (78 seats: 15x5 + row 16 with 3)
    assert seat_to_bay_and_type("CC", 1) == (1, "WS", False)
    assert seat_to_bay_and_type("CC", 2) == (1, "MS", False)
    assert seat_to_bay_and_type("CC", 3) == (1, "AS", False)
    assert seat_to_bay_and_type("CC", 76) == (16, "WS", False)
    assert seat_to_bay_and_type("CC", 77) == (16, "MS", False)
    assert seat_to_bay_and_type("CC", 78) == (16, "AS", False)

    # EC (56 seats: 14x4)
    assert seat_to_bay_and_type("EC", 1) == (1, "WS", False)
    assert seat_to_bay_and_type("EC", 2) == (1, "AS", False)
    assert seat_to_bay_and_type("EC", 56) == (14, "WS", False)

    # 2S (108 seats: 18x6)
    assert seat_to_bay_and_type("2S", 1) == (1, "WS", False)
    assert seat_to_bay_and_type("2S", 2) == (1, "MS", False)
    assert seat_to_bay_and_type("2S", 3) == (1, "AS", False)
    assert seat_to_bay_and_type("2S", 108) == (18, "WS", False)


def test_invalid_seats_and_capacities_raise() -> None:
    with pytest.raises(ValueError, match="Unsupported capacity"):
        seat_to_bay_and_type("3A", 1, capacity=99)
    with pytest.raises(ValueError, match="out of range"):
        seat_to_bay_and_type("3A", 0)
    with pytest.raises(ValueError, match="out of range"):
        seat_to_bay_and_type("3E", 84)
    with pytest.raises(ValueError, match="Invalid rail seat"):
        parse_rail_seat_number("XYZ", "3A")
    with pytest.raises(ValueError, match="Invalid rail seat"):
        parse_rail_seat_number("-1", "3A")
    with pytest.raises(ValueError, match="Invalid rail seat"):
        parse_rail_seat_number("0", "3A")
    with pytest.raises(ValueError, match="Invalid rail seat"):
        parse_rail_seat_number("B5-42", "3A")
    with pytest.raises(ValueError, match="Invalid 1A cabin berth"):
        parse_rail_seat_number("B-3", "1A")


def test_coach_layout_specs_and_svg_generation() -> None:
    expected = {
        "1A": 24,
        "2A": 48,
        "3A": 72,
        "3E": 83,
        "SL": 72,
        "CC": 78,
        "EC": 56,
        "2S": 108,
    }
    for cls, count in expected.items():
        spec = build_coach_layout(cls)
        assert spec.capacity == count
        assert len(spec.slots) == count
        assert spec.layout_ref == f"IR:{cls}:{count}"
        svg = generate_train_coach_svg(cls, highlighted_seats={1}, coach_label="X1")
        assert "<svg " in svg
        assert 'role="img"' in svg
        assert 'data-seat="1"' in svg
        assert f'data-seat="{count}"' in svg

    xss_svg = generate_train_coach_svg("3A", coach_label='B3"><script>alert(1)</script>')
    assert "<script>" not in xss_svg
    assert "&lt;script&gt;" in xss_svg
