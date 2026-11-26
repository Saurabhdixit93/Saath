from __future__ import annotations

from datetime import UTC, date, datetime, time, timedelta
from typing import Any
from uuid import UUID
from zoneinfo import ZoneInfo

import structlog
from redis.asyncio import Redis
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from saath_api.core.config import Settings, YamlConfigBundle
from saath_api.journeys.chart_rules import compute_chart_due_at
from saath_api.journeys.models import Booking, JourneyInstance, SeatHolder
from saath_api.journeys.schemas import PublicChartTimeResponse
from saath_api.notifications.models import NotificationsOutbox
from saath_api.providers.rail.router import ProviderRouter
from saath_api.public.train_catalog import get_train_entry
from saath_api.realtime.pubsub import publish_user_event
from saath_api.swaps.models import SwapParticipant, SwapProposal

logger = structlog.get_logger(__name__)
IST = ZoneInfo("Asia/Kolkata")
_CHART_STATE_RANK: dict[str, int] = {"pending": 0, "first": 1, "final": 2}

# Deterministic known train departure times in IST (used by public chart-time lookup)
_KNOWN_TRAIN_DEPARTURE_IST: dict[str, time] = {
    "12009": time(6, 20),  # Mumbai Central - Ahmedabad Shatabdi (morning window)
    "12002": time(6, 0),   # Bhopal Shatabdi
    "22436": time(6, 0),   # Vande Bharat Express
    "12951": time(16, 55), # Mumbai Tejas Rajdhani (evening)
    "12952": time(16, 55),
    "12627": time(19, 20), # Karnataka Express
}


def compute_public_train_chart_time(
    *,
    train_no: str,
    service_date: date,
    yaml_configs: YamlConfigBundle,
) -> PublicChartTimeResponse:
    cleaned = train_no.strip().upper()
    entry = get_train_entry(cleaned)
    if cleaned in _KNOWN_TRAIN_DEPARTURE_IST:
        dep_clock = _KNOWN_TRAIN_DEPARTURE_IST[cleaned]
    elif entry is not None:
        hh, mm = entry.departure_ist.split(":", 1)
        dep_clock = time(int(hh), int(mm))
    elif cleaned.startswith(("120", "224", "20")):
        dep_clock = time(7, 30)
    else:
        dep_clock = time(17, 30)

    dep_ist = datetime.combine(service_date, dep_clock, tzinfo=IST)
    chart_due_utc = compute_chart_due_at(
        dep_ist,
        train_no=cleaned,
        rules=yaml_configs.chart_rules,
    )

    if cleaned in yaml_configs.chart_rules.overrides:
        rule = f"override_{cleaned}"
    elif time(5, 0) <= dep_clock <= time(14, 0):
        rule = "dec2025_morning_prev_20_ist"
    else:
        rule = "dec2025_standard_10h_before"

    return PublicChartTimeResponse(
        train_no=cleaned,
        date=service_date,
        chart_due_at=chart_due_utc,
        rule=rule,
    )


async def _collect_journey_user_ids(
    db: AsyncSession, journey_instance_id: UUID
) -> set[UUID]:
    booking_uids = (
        await db.execute(
            select(Booking.owner_user_id).where(
                Booking.journey_instance_id == journey_instance_id,
                Booking.owner_user_id.is_not(None),
            )
        )
    ).scalars().all()
    sh_uids = (
        await db.execute(
            select(SeatHolder.linked_user_id)
            .join(Booking, Booking.id == SeatHolder.booking_id)
            .where(
                Booking.journey_instance_id == journey_instance_id,
                SeatHolder.linked_user_id.is_not(None),
            )
        )
    ).scalars().all()
    return {uid for uid in (*booking_uids, *sh_uids) if uid is not None}


async def apply_journey_chart_update(
    *,
    settings: Settings,
    db: AsyncSession,
    redis: Redis | None,
    journey_instance: JourneyInstance,
    new_chart_state: str | None = None,
    berth_changes: list[tuple[SeatHolder, str | None, str | None, UUID | None]] | None = None,
    commit: bool = True,
) -> tuple[bool, list[UUID]]:
    """Shared chart-update pipeline used by both reverify_journey and chart_watcher_tick."""
    changes = berth_changes or []
    changed_sh_ids = [sh.id for sh, _, _, _ in changes]
    prev_state = journey_instance.chart_state
    prev_rank = _CHART_STATE_RANK.get(prev_state, -1)
    new_rank = _CHART_STATE_RANK.get(new_chart_state, -1) if new_chart_state else -1
    chart_state_changed = bool(
        new_chart_state
        and new_chart_state != prev_state
        and (new_rank > prev_rank or prev_rank == -1)
    )

    if chart_state_changed and new_chart_state is not None:
        journey_instance.chart_state = new_chart_state

    if changes or chart_state_changed:
        journey_instance.match_version += 1

    notified_berth_uids: set[UUID] = set()
    for sh, old_coach, old_seat, owner_uid in changes:
        if owner_uid is not None:
            notified_berth_uids.add(owner_uid)
        db.add(
            NotificationsOutbox(
                user_id=owner_uid,
                event="BerthChanged",
                payload={
                    "journey_instance_id": str(journey_instance.id),
                    "booking_id": str(sh.booking_id),
                    "seat_holder_id": str(sh.id),
                    "old_coach": old_coach,
                    "old_seat": old_seat,
                    "new_coach": sh.coach,
                    "new_seat": sh.seat_no,
                    "chart_state": journey_instance.chart_state,
                },
                idempotency_key=(
                    f"berth_changed:{sh.booking_id}:{sh.id}:{journey_instance.match_version}"
                ),
            )
        )

    invalidated_prop_ids: list[UUID] = []
    if changed_sh_ids:
        from saath_api.swaps.service import invalidate_swaps_for_berth_change

        invalidated_prop_ids = await invalidate_swaps_for_berth_change(
            db=db,
            journey_instance_id=journey_instance.id,
            affected_seat_holder_ids=changed_sh_ids,
            reason="chart_berth_changed",
        )

    journey_user_ids = await _collect_journey_user_ids(db, journey_instance.id)
    if chart_state_changed and journey_instance.chart_state in ("first", "final"):
        for uid in journey_user_ids:
            if uid in notified_berth_uids:
                continue
            db.add(
                NotificationsOutbox(
                    user_id=uid,
                    event="ChartChanged",
                    payload={
                        "journey_instance_id": str(journey_instance.id),
                        "chart_state": journey_instance.chart_state,
                    },
                    idempotency_key=(
                        f"chart_changed:{journey_instance.id}:{journey_instance.chart_state}:{uid}"
                    ),
                )
            )

    if commit:
        await db.commit()
        await db.refresh(journey_instance)

    if not (changes or chart_state_changed):
        return False, []

    for uid in journey_user_ids:
        await publish_user_event(
            redis,
            uid,
            {
                "type": "journey.chart",
                "journey_id": str(journey_instance.id),
                "journey_instance_id": str(journey_instance.id),
                "state": journey_instance.chart_state,
                "changed": bool(changes or chart_state_changed),
            },
        )

    if invalidated_prop_ids:
        inv_props = list(
            (
                await db.execute(
                    select(SwapProposal).where(
                        SwapProposal.id.in_(invalidated_prop_ids)
                    )
                )
            )
            .scalars()
            .all()
        )
        parts = list(
            (
                await db.execute(
                    select(SwapParticipant).where(
                        SwapParticipant.proposal_id.in_(invalidated_prop_ids)
                    )
                )
            )
            .scalars()
            .all()
        )
        uids_by_prop: dict[UUID, set[UUID]] = {}
        for p in parts:
            if p.user_id is not None:
                uids_by_prop.setdefault(p.proposal_id, set()).add(p.user_id)
        for prop in inv_props:
            for uid in uids_by_prop.get(prop.id, set()):
                await publish_user_event(
                    redis,
                    uid,
                    {
                        "type": "swap.updated",
                        "swap_id": str(prop.id),
                        "journey_instance_id": str(prop.journey_instance_id),
                        "status": prop.status,
                        "version": prop.version,
                    },
                )

    from saath_api.matching.service import recompute_journey_matches

    _ = settings
    await recompute_journey_matches(
        db=db,
        redis=redis,
        journey_instance_id=journey_instance.id,
        publish_events=True,
    )
    return True, invalidated_prop_ids


async def run_chart_watcher_tick(
    *,
    settings: Settings,
    yaml_configs: YamlConfigBundle,
    db: AsyncSession,
    redis: Redis | None,
    rail_router: ProviderRouter,
    now_override: datetime | None = None,
) -> int:
    now = now_override or datetime.now(UTC)
    poll_minutes = yaml_configs.chart_rules.default.poll_interval_minutes
    final_minutes = yaml_configs.chart_rules.default.final_reverify_minutes_before_departure
    final_cutoff = now + timedelta(minutes=final_minutes)

    due_journeys = list(
        (
            await db.execute(
                select(JourneyInstance).where(
                    JourneyInstance.mode == "train",
                    JourneyInstance.chart_state.in_(("pending", "first")),
                    (
                        (
                            JourneyInstance.chart_due_at.is_not(None)
                            & (JourneyInstance.chart_due_at <= now)
                        )
                        | (
                            JourneyInstance.departure_at.is_not(None)
                            & (JourneyInstance.departure_at <= final_cutoff)
                        )
                    ),
                )
            )
        )
        .scalars()
        .all()
    )

    updated_count = 0
    for ji in due_journeys:
        in_final_window = bool(
            ji.departure_at is not None and ji.departure_at <= final_cutoff
        )
        if redis is not None:
            try:
                if in_final_window:
                    if not await redis.set(f"chart:final_checked:{ji.id}", "1", nx=True, ex=7200):
                        continue
                else:
                    if not await redis.set(
                        f"chart:poll:{ji.id}",
                        "1",
                        nx=True,
                        ex=max(60, poll_minutes * 60),
                    ):
                        continue
            except Exception:
                pass

        try:
            live = await rail_router.get_live_status(ji.service_no, ji.service_date)
        except Exception as exc:
            logger.warning(
                "chart_watcher_live_status_failed",
                journey_instance_id=str(ji.id),
                error=str(exc),
            )
            continue

        current_rank = _CHART_STATE_RANK.get(ji.chart_state, -1)
        live_rank = _CHART_STATE_RANK.get(live.chart_state, -1)
        target_state: str | None = None
        if live_rank > current_rank:
            target_state = live.chart_state
        elif in_final_window and current_rank < _CHART_STATE_RANK["final"]:
            target_state = "final"

        if target_state is not None:
            changed, _ = await apply_journey_chart_update(
                settings=settings,
                db=db,
                redis=redis,
                journey_instance=ji,
                new_chart_state=target_state,
                berth_changes=[],
                commit=True,
            )
            if changed:
                updated_count += 1

    return updated_count
