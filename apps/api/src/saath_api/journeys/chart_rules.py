from __future__ import annotations

from datetime import UTC, datetime, time, timedelta
from typing import Protocol
from zoneinfo import ZoneInfo

IST = ZoneInfo("Asia/Kolkata")


class ChartRulesDefaultLike(Protocol):
    morning_window_start_ist: str
    morning_window_end_ist: str
    morning_chart_previous_day_ist: str
    standard_hours_before_departure: int


class ChartRulesConfigLike(Protocol):
    # Read-only properties so concrete configs (e.g. ChartRulesConfig, whose
    # ``default`` is a ChartRulesDefault) match structurally; mutable protocol
    # attributes would be invariant.
    @property
    def default(self) -> ChartRulesDefaultLike: ...

    @property
    def overrides(self) -> dict[str, object]: ...


def _parse_hhmm(raw: str) -> time:
    parts = raw.strip().split(":")
    if len(parts) != 2:
        raise ValueError(f"Invalid HH:MM time value: {raw!r}")
    hour = int(parts[0])
    minute = int(parts[1])
    return time(hour=hour, minute=minute)


def compute_chart_due_at(
    departure_at: datetime,
    *,
    train_no: str = "",
    rules: ChartRulesConfigLike | None = None,
) -> datetime:
    """Compute chart preparation UTC timestamp using Dec 2025 Indian Railways rules.

    Dec 2025 rule:
    - Trains departing between 05:00 IST and 14:00 IST (inclusive): chart prepares
      at 20:00 IST on the previous calendar day.
    - All other departure times: chart prepares 10 hours before departure.
    """
    if departure_at.tzinfo is None:
        dep_ist = departure_at.replace(tzinfo=IST)
    else:
        dep_ist = departure_at.astimezone(IST)

    morning_start = _parse_hhmm(rules.default.morning_window_start_ist if rules else "05:00")
    morning_end = _parse_hhmm(rules.default.morning_window_end_ist if rules else "14:00")
    prev_day_time = _parse_hhmm(rules.default.morning_chart_previous_day_ist if rules else "20:00")
    standard_hours = rules.default.standard_hours_before_departure if rules else 10

    if rules and train_no and isinstance(rules.overrides.get(train_no), dict):
        override = rules.overrides[train_no]
        assert isinstance(override, dict)
        if "hours_before_departure" in override:
            hours = int(override["hours_before_departure"])
            return (dep_ist - timedelta(hours=hours)).astimezone(UTC)

    dep_clock = dep_ist.timetz().replace(tzinfo=None)
    if morning_start <= dep_clock <= morning_end:
        prev_day = dep_ist.date() - timedelta(days=1)
        chart_ist = datetime.combine(prev_day, prev_day_time, tzinfo=IST)
    else:
        chart_ist = dep_ist - timedelta(hours=standard_hours)

    return chart_ist.astimezone(UTC)
