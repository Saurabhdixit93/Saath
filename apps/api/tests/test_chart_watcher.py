from __future__ import annotations

from datetime import UTC, date, datetime, timedelta

from httpx import AsyncClient
from sqlalchemy import select

from saath_api.core.config import Settings
from saath_api.journeys.chart_watcher import compute_public_train_chart_time, run_chart_watcher_tick
from saath_api.journeys.models import JourneyInstance
from saath_api.notifications.models import NotificationsOutbox
from saath_api.providers.messaging import FakeMessagingProvider
from saath_api.providers.rail.protocol import LiveStatusDTO


async def _otp_login(
    client: AsyncClient,
    fake_messaging: FakeMessagingProvider,
    phone: str,
) -> tuple[str, str]:
    start = await client.post(
        "/v1/auth/otp/start",
        json={"phone": phone, "channel": "whatsapp", "turnstile": "ok"},
    )
    assert start.status_code == 200
    code = fake_messaging.sent_messages[-1].code
    verify = await client.post(
        "/v1/auth/otp/verify",
        json={"request_id": start.json()["request_id"], "code": code},
    )
    assert verify.status_code == 200
    return str(verify.json()["access"]), str(verify.json()["user"]["id"])


async def test_public_train_chart_time_rules(client: AsyncClient) -> None:
    morning = await client.get("/v1/public/train/12009/chart-time?date=2026-12-01")
    evening = await client.get("/v1/public/train/12951/chart-time?date=2026-12-01")
    assert morning.status_code == 200
    assert evening.status_code == 200
    m_data = morning.json()
    e_data = evening.json()
    assert m_data["train_no"] == "12009"
    assert e_data["train_no"] == "12951"
    assert m_data["rule"] != e_data["rule"]
    assert m_data["rule"] == "dec2025_morning_prev_20_ist"
    assert e_data["rule"] == "dec2025_standard_10h_before"


async def test_simulate_chart_change_invalidates_swap_and_emits_events(
    client: AsyncClient,
    fake_messaging: FakeMessagingProvider,
) -> None:
    tok_a, _ = await _otp_login(client, fake_messaging, "9876543901")
    tok_b, _ = await _otp_login(client, fake_messaging, "9876543902")
    h_a = {"Authorization": f"Bearer {tok_a}"}
    h_b = {"Authorization": f"Bearer {tok_b}"}

    va = (
        await client.post(
            "/v1/journeys/verify", headers=h_a, json={"mode": "train", "pnr": "4111111111"}
        )
    ).json()
    vb = (
        await client.post(
            "/v1/journeys/verify", headers=h_b, json={"mode": "train", "pnr": "4222222222"}
        )
    ).json()
    await client.put(
        f"/v1/parties/{vb['party']['id']}/goal",
        headers=h_b,
        json={
            "goal_type": "open_to_help",
            "movers": [vb["seat_holders"][0]["id"]],
            "constraints": {},
        },
    )
    await client.put(
        f"/v1/parties/{va['party']['id']}/goal",
        headers=h_a,
        json={"goal_type": "lower", "movers": [va["seat_holders"][0]["id"]], "constraints": {}},
    )

    matches = (
        await client.get(f"/v1/parties/{va['party']['id']}/matches?kind=pair", headers=h_a)
    ).json()["items"]
    swap = (
        await client.post("/v1/swaps", headers=h_a, json={"card_id": matches[0]["card_id"]})
    ).json()
    acc1 = await client.post(
        f"/v1/swaps/{swap['id']}/accept", headers=h_a, json={"version": swap["version"]}
    )
    acc2 = await client.post(
        f"/v1/swaps/{swap['id']}/accept", headers=h_b, json={"version": acc1.json()["version"]}
    )
    assert acc2.status_code == 200

    reverify = await client.post(
        f"/v1/journeys/{va['journey']['id']}/reverify",
        headers={**h_a, "X-Simulate-Chart-Change": "true"},
    )
    assert reverify.status_code == 200
    assert reverify.json()["chart"]["state"] == "final"

    swap_after = (await client.get(f"/v1/swaps/{swap['id']}", headers=h_a)).json()
    assert swap_after["status"] == "invalidated"

    app = client.app  # type: ignore[attr-defined]
    async with app.state.session_factory() as db:
        outbox_events = list((await db.execute(select(NotificationsOutbox.event))).scalars().all())
        assert "BerthChanged" in outbox_events
        assert "SwapInvalidated" in outbox_events


async def test_chart_watcher_tick_transitions_due_journey(
    client: AsyncClient,
    test_settings: Settings,
    fake_messaging: FakeMessagingProvider,
) -> None:
    tok_a, _ = await _otp_login(client, fake_messaging, "9876543903")
    h_a = {"Authorization": f"Bearer {tok_a}"}
    va = (
        await client.post(
            "/v1/journeys/verify", headers=h_a, json={"mode": "train", "pnr": "4111111111"}
        )
    ).json()
    ji_id = va["journey"]["id"]

    app = client.app  # type: ignore[attr-defined]

    class _MockRailRouter:
        async def get_live_status(self, train_no: str, service_date: date) -> LiveStatusDTO:
            return LiveStatusDTO(
                train_no=train_no,
                service_date=service_date,
                current_station="BRC",
                delay_minutes=0,
                chart_state="final",
            )

    future_now = datetime.now(UTC) + timedelta(days=5)
    async with app.state.session_factory() as db:
        updated = await run_chart_watcher_tick(
            settings=test_settings,
            yaml_configs=app.state.yaml_configs,
            db=db,
            redis=app.state.redis,
            rail_router=_MockRailRouter(),  # type: ignore[arg-type]
            now_override=future_now,
        )
        assert updated >= 1
        ji = (
            await db.execute(select(JourneyInstance).where(JourneyInstance.id == ji_id))
        ).scalar_one()
        assert ji.chart_state == "final"

    # Also verify pure compute_public_train_chart_time works directly
    out = compute_public_train_chart_time(
        train_no="12009",
        service_date=date(2026, 12, 1),
        yaml_configs=app.state.yaml_configs,
    )
    assert out.rule == "dec2025_morning_prev_20_ist"


async def test_chart_watcher_enforces_monotonic_chart_state(
    client: AsyncClient,
    test_settings: Settings,
    fake_messaging: FakeMessagingProvider,
) -> None:
    tok_a, _ = await _otp_login(client, fake_messaging, "9876543904")
    h_a = {"Authorization": f"Bearer {tok_a}"}
    va = (
        await client.post(
            "/v1/journeys/verify", headers=h_a, json={"mode": "train", "pnr": "4111111111"}
        )
    ).json()
    ji_id = va["journey"]["id"]

    app = client.app  # type: ignore[attr-defined]

    class _StalePendingRailRouter:
        async def get_live_status(self, train_no: str, service_date: date) -> LiveStatusDTO:
            return LiveStatusDTO(
                train_no=train_no,
                service_date=service_date,
                current_station="BRC",
                delay_minutes=0,
                chart_state="pending",
            )

    now = datetime.now(UTC)
    async with app.state.session_factory() as db:
        ji = (
            await db.execute(select(JourneyInstance).where(JourneyInstance.id == ji_id))
        ).scalar_one()
        ji.chart_state = "first"
        ji.chart_due_at = now - timedelta(minutes=10)
        ji.departure_at = now + timedelta(hours=5)
        await db.commit()

        await app.state.redis.delete(f"chart:poll:{ji.id}", f"chart:final_checked:{ji.id}")
        updated = await run_chart_watcher_tick(
            settings=test_settings,
            yaml_configs=app.state.yaml_configs,
            db=db,
            redis=app.state.redis,
            rail_router=_StalePendingRailRouter(),  # type: ignore[arg-type]
            now_override=now,
        )
        assert updated == 0
        await db.refresh(ji)
        assert ji.chart_state == "first"

        # Inside final window, stale "pending" still advances monotonically to "final"
        ji.departure_at = now + timedelta(minutes=30)
        await db.commit()
        await app.state.redis.delete(f"chart:poll:{ji.id}", f"chart:final_checked:{ji.id}")
        updated_final = await run_chart_watcher_tick(
            settings=test_settings,
            yaml_configs=app.state.yaml_configs,
            db=db,
            redis=app.state.redis,
            rail_router=_StalePendingRailRouter(),  # type: ignore[arg-type]
            now_override=now,
        )
        assert updated_final >= 1
        await db.refresh(ji)
        assert ji.chart_state == "final"
