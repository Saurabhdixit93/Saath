from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

from httpx import AsyncClient
from sqlalchemy import select

from saath_api.admin.models import FeatureFlag
from saath_api.auth.models import AuditLog, Device, User
from saath_api.core.config import load_yaml_configs
from saath_api.core.crypto import blind_index, encrypt_phone
from saath_api.core.ids import uuid7
from saath_api.journeys.models import Booking, JourneyInstance, SeatHolder
from saath_api.karma.models import KarmaLedger, RewardItem, RewardRedemption
from saath_api.karma.service import (
    _load_participant_contexts,
    calculate_participant_karma,
    credit_for_completed_proposal,
    evaluate_and_award_badges,
)
from saath_api.notifications.models import NotificationsOutbox
from saath_api.parties.models import Goal, Party, PartyMember
from saath_api.providers.messaging import FakeMessagingProvider
from saath_api.swaps.models import SwapParticipant, SwapProposal


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


async def _setup_confirmed_pair_swap(
    client: AsyncClient,
    h_a: dict[str, str],
    h_b: dict[str, str],
    *,
    pnr_a: str = "4111111111",
    pnr_b: str = "4222222222",
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    v_a = (
        await client.post(
            "/v1/journeys/verify",
            headers=h_a,
            json={"mode": "train", "pnr": pnr_a},
        )
    ).json()
    v_b = (
        await client.post(
            "/v1/journeys/verify",
            headers=h_b,
            json={"mode": "train", "pnr": pnr_b},
        )
    ).json()

    await client.put(
        f"/v1/parties/{v_b['party']['id']}/goal",
        headers=h_b,
        json={
            "goal_type": "open_to_help",
            "movers": [v_b["seat_holders"][0]["id"]],
            "constraints": {},
        },
    )
    await client.put(
        f"/v1/parties/{v_a['party']['id']}/goal",
        headers=h_a,
        json={
            "goal_type": "lower",
            "movers": [v_a["seat_holders"][0]["id"]],
            "constraints": {},
        },
    )

    matches = (
        await client.get(
            f"/v1/parties/{v_a['party']['id']}/matches?kind=pair",
            headers=h_a,
        )
    ).json()["items"]
    assert matches
    swap = (
        await client.post(
            "/v1/swaps",
            headers=h_a,
            json={"card_id": matches[0]["card_id"]},
        )
    ).json()
    a1 = (
        await client.post(
            f"/v1/swaps/{swap['id']}/accept",
            headers=h_a,
            json={"version": swap["version"]},
        )
    ).json()
    a2 = (
        await client.post(
            f"/v1/swaps/{swap['id']}/accept",
            headers=h_b,
            json={"version": a1["version"]},
        )
    ).json()
    assert a2["status"] == "confirmed"
    return v_a, v_b, a2


async def test_karma_auth_and_empty_wallet(
    client: AsyncClient,
    fake_messaging: FakeMessagingProvider,
) -> None:
    unauth = await client.get("/v1/karma")
    assert unauth.status_code == 401
    assert unauth.headers["content-type"].startswith("application/problem+json")

    anon = await client.post("/v1/auth/anonymous", json={"turnstile": "ok"})
    assert anon.status_code == 200
    anon_res = await client.get(
        "/v1/karma",
        headers={"Authorization": f"Bearer {anon.json()['access']}"},
    )
    assert anon_res.status_code == 403
    assert anon_res.headers["content-type"].startswith("application/problem+json")

    tok, _ = await _otp_login(client, fake_messaging, "9876543600")
    res = await client.get("/v1/karma", headers={"Authorization": f"Bearer {tok}"})
    assert res.status_code == 200
    data = res.json()
    assert data == {
        "balance": 0,
        "pending": 0,
        "redeemed_points": 0,
        "available_balance": 0,
        "history": [],
        "badges": [],
        "leaderboard": [],
    }


async def test_karma_yaml_point_rules_train_flight_and_bonuses(
    client: AsyncClient,
    fake_messaging: FakeMessagingProvider,
) -> None:
    _, uid_a = await _otp_login(client, fake_messaging, "9876543601")
    _, uid_b = await _otp_login(client, fake_messaging, "9876543602")
    _, uid_c = await _otp_login(client, fake_messaging, "9876543603")

    app: Any = client.app  # type: ignore[attr-defined]
    yaml_cfg = load_yaml_configs(app.state.settings.config_dir)

    async with app.state.session_factory() as db:
        # 1) Flight exit row + cycle3 bonus
        ji_flight = JourneyInstance(
            id=uuid7(),
            mode="flight",
            carrier_code="6E",
            service_no="204",
            service_date=(datetime.now(UTC) + timedelta(days=3)).date(),
            departure_at=datetime.now(UTC) + timedelta(days=3),
            arrival_at=datetime.now(UTC) + timedelta(days=3, hours=2),
            chart_state="na",
            layout_ref="6E:A320neo",
        )
        db.add(ji_flight)
        await db.flush()

        now = datetime.now(UTC)
        bk_fa = Booking(
            id=uuid7(),
            journey_instance_id=ji_flight.id,
            owner_user_id=UUID(uid_a),
            pnr_hash=b"f-a-hash",
            travel_class="Y",
            trust_tier="verified_bcbp",
            purge_after=now + timedelta(days=30),
        )
        bk_fb = Booking(
            id=uuid7(),
            journey_instance_id=ji_flight.id,
            owner_user_id=UUID(uid_b),
            pnr_hash=b"f-b-hash",
            travel_class="Y",
            trust_tier="verified_bcbp",
            purge_after=now + timedelta(days=30),
        )
        bk_fc = Booking(
            id=uuid7(),
            journey_instance_id=ji_flight.id,
            owner_user_id=UUID(uid_c),
            pnr_hash=b"f-c-hash",
            travel_class="Y",
            trust_tier="verified_bcbp",
            purge_after=now + timedelta(days=30),
        )
        db.add_all([bk_fa, bk_fb, bk_fc])
        await db.flush()

        # 12A = Exit row WS on 6E:A320neo -> EXIT (100)
        sh_fa = SeatHolder(
            id=uuid7(),
            booking_id=bk_fa.id,
            pax_seq=1,
            coach="CABIN",
            seat_no="12A",
            seat_type="WS",
            age_band="adult",
            gender_band="M",
        )
        # 14C = Aisle AS -> A (75)
        sh_fb = SeatHolder(
            id=uuid7(),
            booking_id=bk_fb.id,
            pax_seq=1,
            coach="CABIN",
            seat_no="14C",
            seat_type="AS",
            age_band="adult",
            gender_band="F",
        )
        # 14B = Middle MS -> M (50)
        sh_fc = SeatHolder(
            id=uuid7(),
            booking_id=bk_fc.id,
            pax_seq=1,
            coach="CABIN",
            seat_no="14B",
            seat_type="MS",
            age_band="adult",
            gender_band="M",
        )
        db.add_all([sh_fa, sh_fb, sh_fc])
        await db.flush()

        prop_f = SwapProposal(
            id=uuid7(),
            journey_instance_id=ji_flight.id,
            initiator_user_id=UUID(uid_a),
            kind="cycle3",
            status="completed",
            expires_at=now + timedelta(hours=4),
            confirmed_at=now,
        )
        db.add(prop_f)
        await db.flush()

        parts_f = [
            SwapParticipant(
                proposal_id=prop_f.id,
                seat_holder_id=sh_fa.id,
                user_id=UUID(uid_a),
                alias="A",
                gives_seat="12A WS",
                gets_seat="14C AS",
                gives_seat_type="WS",
                gets_seat_type="AS",
                decision="accepted",
            ),
            SwapParticipant(
                proposal_id=prop_f.id,
                seat_holder_id=sh_fb.id,
                user_id=UUID(uid_b),
                alias="B",
                gives_seat="14C AS",
                gets_seat="14B MS",
                gives_seat_type="AS",
                gets_seat_type="MS",
                decision="accepted",
            ),
            SwapParticipant(
                proposal_id=prop_f.id,
                seat_holder_id=sh_fc.id,
                user_id=UUID(uid_c),
                alias="C",
                gives_seat="14B MS",
                gets_seat="12A WS",
                gives_seat_type="MS",
                gets_seat_type="WS",
                decision="accepted",
            ),
        ]
        db.add_all(parts_f)
        await db.flush()

        ctxs = await _load_participant_contexts(db, parts_f)
        # Exit row 100 + helped_solo_woman (B is single-pax F) 25 + cycle_participant 10 = 135
        pts_a = calculate_participant_karma(
            user_id=UUID(uid_a),
            proposal=prop_f,
            contexts=ctxs,
            ji=ji_flight,
            karma_config=yaml_cfg.karma,
        )
        assert pts_a == 135
        # AS (75) + cycle_participant (10) = 85
        pts_b = calculate_participant_karma(
            user_id=UUID(uid_b),
            proposal=prop_f,
            contexts=ctxs,
            ji=ji_flight,
            karma_config=yaml_cfg.karma,
        )
        assert pts_b == 85
        # MS (50) + helped_solo_woman (25) + cycle_participant (10) = 85
        pts_c = calculate_participant_karma(
            user_id=UUID(uid_c),
            proposal=prop_f,
            contexts=ctxs,
            ji=ji_flight,
            karma_config=yaml_cfg.karma,
        )
        assert pts_c == 85


async def test_pending_credit_chart_corroboration_and_dispute_reversal(
    client: AsyncClient,
    fake_messaging: FakeMessagingProvider,
) -> None:
    tok_a, uid_a = await _otp_login(client, fake_messaging, "9876543610")
    tok_b, uid_b = await _otp_login(client, fake_messaging, "9876543611")
    h_a = {"Authorization": f"Bearer {tok_a}"}
    h_b = {"Authorization": f"Bearer {tok_b}"}

    v_a, _, swap = await _setup_confirmed_pair_swap(client, h_a, h_b)

    # Pending karma recorded on confirm
    k_b_pending = (await client.get("/v1/karma", headers=h_b)).json()
    assert k_b_pending["balance"] == 0
    assert k_b_pending["pending"] >= 100
    assert any(row["state"] == "pending" for row in k_b_pending["history"])
    assert uid_a and uid_b

    # Set chart_state = final so one_confirm AND chart_corroborates triggers on first "yes"
    app: Any = client.app  # type: ignore[attr-defined]
    async with app.state.session_factory() as db:
        ji = (
            await db.execute(
                select(JourneyInstance).where(
                    JourneyInstance.id == UUID(v_a["journey"]["id"])
                )
            )
        ).scalar_one()
        ji.chart_state = "final"
        await db.commit()

    # First confirm -> completes immediately via chart corroboration!
    c1 = await client.post(
        f"/v1/swaps/{swap['id']}/confirm-completion",
        headers=h_a,
        json={"answer": "yes"},
    )
    assert c1.status_code == 200
    assert c1.json()["status"] == "completed"

    k_b_credited = (await client.get("/v1/karma", headers=h_b)).json()
    assert k_b_credited["balance"] >= 125
    assert k_b_credited["pending"] == 0
    assert any(b["code"] == "first_swap" for b in k_b_credited["badges"])
    assert any(b["code"] == "senior_saviour" for b in k_b_credited["badges"])

    # Second participant says "yes" -> idempotent, no double credit
    c2 = await client.post(
        f"/v1/swaps/{swap['id']}/confirm-completion",
        headers=h_b,
        json={"answer": "yes"},
    )
    assert c2.status_code == 200
    k_b_after_second = (await client.get("/v1/karma", headers=h_b)).json()
    assert k_b_after_second["balance"] == k_b_credited["balance"]

    # Now test post-completion dispute reversal on a fresh chart-corroborated swap
    tok_c, _ = await _otp_login(client, fake_messaging, "9876543612")
    tok_d, _ = await _otp_login(client, fake_messaging, "9876543613")
    h_c = {"Authorization": f"Bearer {tok_c}"}
    h_d = {"Authorization": f"Bearer {tok_d}"}

    # Use 2415678903 (UB) & 2415678904 (SL) on same Rajdhani (chart_state already final)
    v_c = (
        await client.post(
            "/v1/journeys/verify", headers=h_c, json={"mode": "train", "pnr": "2415678903"}
        )
    ).json()
    v_d = (
        await client.post(
            "/v1/journeys/verify", headers=h_d, json={"mode": "train", "pnr": "2415678904"}
        )
    ).json()
    await client.put(
        f"/v1/parties/{v_d['party']['id']}/goal",
        headers=h_d,
        json={
            "goal_type": "open_to_help",
            "movers": [v_d["seat_holders"][0]["id"]],
            "constraints": {},
        },
    )
    await client.put(
        f"/v1/parties/{v_c['party']['id']}/goal",
        headers=h_c,
        json={"goal_type": "lower", "movers": [v_c["seat_holders"][0]["id"]], "constraints": {}},
    )
    # Use specific_seats if lower doesn't match SL
    matches_cd = (
        await client.get(f"/v1/parties/{v_c['party']['id']}/matches?kind=pair", headers=h_c)
    ).json()["items"]
    if not matches_cd:
        await client.put(
            f"/v1/parties/{v_c['party']['id']}/goal",
            headers=h_c,
            json={
                "goal_type": "specific_seats",
                "movers": [v_c["seat_holders"][0]["id"]],
                "preferred_seats": ["B5-15"],
                "constraints": {},
            },
        )
        matches_cd = (
            await client.get(f"/v1/parties/{v_c['party']['id']}/matches?kind=pair", headers=h_c)
        ).json()["items"]
    assert matches_cd
    sw2 = (
        await client.post("/v1/swaps", headers=h_c, json={"card_id": matches_cd[0]["card_id"]})
    ).json()
    s2_1 = (
        await client.post(
            f"/v1/swaps/{sw2['id']}/accept",
            headers=h_c,
            json={"version": sw2["version"]},
        )
    ).json()
    s2_2 = (
        await client.post(
            f"/v1/swaps/{sw2['id']}/accept",
            headers=h_d,
            json={"version": s2_1["version"]},
        )
    ).json()
    assert s2_2["status"] == "confirmed"

    # C says yes -> completes & credits via chart_state == final
    comp = await client.post(
        f"/v1/swaps/{sw2['id']}/confirm-completion", headers=h_c, json={"answer": "yes"}
    )
    assert comp.status_code == 200
    assert comp.json()["status"] == "completed"
    k_d_before_dispute = (await client.get("/v1/karma", headers=h_d)).json()
    assert k_d_before_dispute["balance"] == 75

    # D disputes with did_not_board -> transitions to not_completed and reverses karma!
    disp = await client.post(
        f"/v1/swaps/{sw2['id']}/confirm-completion",
        headers=h_d,
        json={"answer": "did_not_board"},
    )
    assert disp.status_code == 200
    assert disp.json()["status"] == "not_completed"

    k_d_after_dispute = (await client.get("/v1/karma", headers=h_d)).json()
    assert k_d_after_dispute["balance"] == 0
    assert k_d_after_dispute["pending"] == 0
    assert any(
        row["state"] == "reversed" and row["delta"] == -75
        for row in k_d_after_dispute["history"]
    )
    credited_sum = sum(
        r["delta"] for r in k_d_after_dispute["history"] if r["state"] == "credited"
    )
    reversed_sum = sum(
        abs(r["delta"]) for r in k_d_after_dispute["history"] if r["state"] == "reversed"
    )
    assert k_d_after_dispute["balance"] == credited_sum - reversed_sum

    async with app.state.session_factory() as db:
        rev_notifs = (
            await db.execute(
                select(NotificationsOutbox).where(
                    NotificationsOutbox.event == "KarmaReversed"
                )
            )
        ).scalars().all()
        assert len(rev_notifs) >= 2


async def test_anti_fraud_daily_cap_same_pair_cap_and_device_collusion(
    client: AsyncClient,
    fake_messaging: FakeMessagingProvider,
) -> None:
    tok_a, uid_a = await _otp_login(client, fake_messaging, "9876543620")
    tok_b, uid_b = await _otp_login(client, fake_messaging, "9876543621")
    h_a = {"Authorization": f"Bearer {tok_a}"}
    h_b = {"Authorization": f"Bearer {tok_b}"}

    # Swap 1 between A and B -> completes normally
    _, _, sw1 = await _setup_confirmed_pair_swap(client, h_a, h_b)
    await client.post(
        f"/v1/swaps/{sw1['id']}/confirm-completion", headers=h_a, json={"answer": "yes"}
    )
    await client.post(
        f"/v1/swaps/{sw1['id']}/confirm-completion", headers=h_b, json={"answer": "yes"}
    )
    bal_after_1 = (await client.get("/v1/karma", headers=h_b)).json()["balance"]
    assert bal_after_1 >= 100

    # Swap 2 between SAME pair (A and B) on different date via SMS -> 90d cap blocks credit!
    future_doj = (datetime.now(UTC) + timedelta(days=15)).strftime("%d-%m-%y")
    sms_a = (
        f"PNR:4111111111 TRN:12951 DOJ:{future_doj} CLS:3A "
        "P1:CNF/B3/11/UB/68/F"
    )
    sms_b = (
        f"PNR:4222222222 TRN:12951 DOJ:{future_doj} CLS:3A "
        "P1:CNF/B3/20/LB/32/M"
    )
    va2 = (
        await client.post(
            "/v1/journeys/verify", headers=h_a, json={"mode": "train", "sms_text": sms_a}
        )
    ).json()
    vb2 = (
        await client.post(
            "/v1/journeys/verify", headers=h_b, json={"mode": "train", "sms_text": sms_b}
        )
    ).json()
    await client.put(
        f"/v1/parties/{vb2['party']['id']}/goal",
        headers=h_b,
        json={
            "goal_type": "open_to_help",
            "movers": [vb2["seat_holders"][0]["id"]],
            "constraints": {},
        },
    )
    await client.put(
        f"/v1/parties/{va2['party']['id']}/goal",
        headers=h_a,
        json={"goal_type": "lower", "movers": [va2["seat_holders"][0]["id"]], "constraints": {}},
    )
    m2 = (
        await client.get(
            f"/v1/parties/{va2['party']['id']}/matches?kind=pair", headers=h_a
        )
    ).json()["items"]
    assert m2
    sw2 = (await client.post("/v1/swaps", headers=h_a, json={"card_id": m2[0]["card_id"]})).json()
    s2_1 = (
        await client.post(
            f"/v1/swaps/{sw2['id']}/accept",
            headers=h_a,
            json={"version": sw2["version"]},
        )
    ).json()
    s2_2 = (
        await client.post(
            f"/v1/swaps/{sw2['id']}/accept",
            headers=h_b,
            json={"version": s2_1["version"]},
        )
    ).json()
    assert s2_2["status"] == "confirmed"
    await client.post(
        f"/v1/swaps/{sw2['id']}/confirm-completion", headers=h_a, json={"answer": "yes"}
    )
    await client.post(
        f"/v1/swaps/{sw2['id']}/confirm-completion", headers=h_b, json={"answer": "yes"}
    )

    bal_after_2 = (await client.get("/v1/karma", headers=h_b)).json()["balance"]
    assert bal_after_2 == bal_after_1

    # Daily cap (300) & Device collusion checks directly via service
    _, uid_c = await _otp_login(client, fake_messaging, "9876543622")
    _, uid_d = await _otp_login(client, fake_messaging, "9876543623")
    _, uid_e = await _otp_login(client, fake_messaging, "9876543624")
    app: Any = client.app  # type: ignore[attr-defined]
    yaml_cfg = load_yaml_configs(app.state.settings.config_dir)

    async with app.state.session_factory() as db:
        now = datetime.now(UTC)
        # Seed 270 credited today for C -> next 100pt swap should clamp to +30 (total 300)
        db.add(
            KarmaLedger(
                user_id=UUID(uid_c),
                proposal_id=None,
                delta=270,
                state="credited",
                reason="seed_daily_cap",
                created_at=now,
            )
        )
        # Share push_endpoint between D and E -> collusion block!
        db.add_all(
            [
                Device(
                    id=uuid7(),
                    user_id=UUID(uid_d),
                    push_endpoint="https://push.example/shared-endpoint-xyz",
                    push_p256dh="shared-key-123",
                ),
                Device(
                    id=uuid7(),
                    user_id=UUID(uid_e),
                    push_endpoint="https://push.example/shared-endpoint-xyz",
                    push_p256dh="shared-key-123",
                ),
            ]
        )
        ji = JourneyInstance(
            id=uuid7(),
            mode="train",
            carrier_code="IR",
            service_no="12953",
            service_date=(now + timedelta(days=4)).date(),
            departure_at=now + timedelta(days=4),
            arrival_at=now + timedelta(days=5),
            chart_state="final",
        )
        db.add(ji)
        await db.flush()

        # C swaps with F (or D/E); first test C's daily cap with a fresh non-colluding partner
        bk_c = Booking(
            id=uuid7(),
            journey_instance_id=ji.id,
            owner_user_id=UUID(uid_c),
            pnr_hash=b"cap-c",
            travel_class="3A",
            trust_tier="verified_provider",
            purge_after=now + timedelta(days=30),
        )
        bk_a = Booking(
            id=uuid7(),
            journey_instance_id=ji.id,
            owner_user_id=UUID(uid_a),
            pnr_hash=b"cap-a",
            travel_class="3A",
            trust_tier="verified_provider",
            purge_after=now + timedelta(days=30),
        )
        db.add_all([bk_c, bk_a])
        await db.flush()
        sh_c = SeatHolder(
            id=uuid7(),
            booking_id=bk_c.id,
            pax_seq=1,
            coach="B1",
            seat_no="1",
            seat_type="LB",
            age_band="adult",
            gender_band="M",
        )
        sh_a2 = SeatHolder(
            id=uuid7(),
            booking_id=bk_a.id,
            pax_seq=1,
            coach="B1",
            seat_no="3",
            seat_type="UB",
            age_band="adult",
            gender_band="M",
        )
        db.add_all([sh_c, sh_a2])
        await db.flush()
        prop_cap = SwapProposal(
            id=uuid7(),
            journey_instance_id=ji.id,
            initiator_user_id=UUID(uid_c),
            kind="pair",
            status="completed",
            expires_at=now + timedelta(hours=3),
            confirmed_at=now,
        )
        db.add(prop_cap)
        await db.flush()
        parts_cap = [
            SwapParticipant(
                proposal_id=prop_cap.id,
                seat_holder_id=sh_c.id,
                user_id=UUID(uid_c),
                alias="C",
                gives_seat="B1-1 LB",
                gets_seat="B1-3 UB",
                gives_seat_type="LB",
                gets_seat_type="UB",
                decision="accepted",
            ),
            SwapParticipant(
                proposal_id=prop_cap.id,
                seat_holder_id=sh_a2.id,
                user_id=UUID(uid_a),
                alias="A",
                gives_seat="B1-3 UB",
                gets_seat="B1-1 LB",
                gives_seat_type="UB",
                gets_seat_type="LB",
                decision="accepted",
            ),
        ]
        db.add_all(parts_cap)
        await db.flush()

        awarded_cap = await credit_for_completed_proposal(
            db=db,
            proposal=prop_cap,
            parts=parts_cap,
            ji=ji,
            yaml_configs=yaml_cfg,
        )
        assert awarded_cap[UUID(uid_c)] == 30  # 300 - 270 = 30 max allowed today!

        # Collusion swap between D and E
        bk_d = Booking(
            id=uuid7(),
            journey_instance_id=ji.id,
            owner_user_id=UUID(uid_d),
            pnr_hash=b"col-d",
            travel_class="3A",
            trust_tier="verified_provider",
            purge_after=now + timedelta(days=30),
        )
        bk_e = Booking(
            id=uuid7(),
            journey_instance_id=ji.id,
            owner_user_id=UUID(uid_e),
            pnr_hash=b"col-e",
            travel_class="3A",
            trust_tier="verified_provider",
            purge_after=now + timedelta(days=30),
        )
        db.add_all([bk_d, bk_e])
        await db.flush()
        sh_d = SeatHolder(
            id=uuid7(),
            booking_id=bk_d.id,
            pax_seq=1,
            coach="B2",
            seat_no="1",
            seat_type="LB",
        )
        sh_e = SeatHolder(
            id=uuid7(),
            booking_id=bk_e.id,
            pax_seq=1,
            coach="B2",
            seat_no="3",
            seat_type="UB",
        )
        db.add_all([sh_d, sh_e])
        await db.flush()
        prop_col = SwapProposal(
            id=uuid7(),
            journey_instance_id=ji.id,
            initiator_user_id=UUID(uid_d),
            kind="pair",
            status="completed",
            expires_at=now + timedelta(hours=3),
            confirmed_at=now,
        )
        db.add(prop_col)
        await db.flush()
        parts_col = [
            SwapParticipant(
                proposal_id=prop_col.id,
                seat_holder_id=sh_d.id,
                user_id=UUID(uid_d),
                alias="D",
                gives_seat="B2-1 LB",
                gets_seat="B2-3 UB",
                gives_seat_type="LB",
                gets_seat_type="UB",
                decision="accepted",
            ),
            SwapParticipant(
                proposal_id=prop_col.id,
                seat_holder_id=sh_e.id,
                user_id=UUID(uid_e),
                alias="E",
                gives_seat="B2-3 UB",
                gets_seat="B2-1 LB",
                gives_seat_type="UB",
                gets_seat_type="LB",
                decision="accepted",
            ),
        ]
        db.add_all(parts_col)
        await db.flush()

        awarded_col = await credit_for_completed_proposal(
            db=db,
            proposal=prop_col,
            parts=parts_col,
            ji=ji,
            yaml_configs=yaml_cfg,
        )
        assert awarded_col == {}
        audits = (
            await db.execute(
                select(AuditLog).where(
                    AuditLog.action.in_(
                        ("karma.collusion_blocked", "karma.same_pair_cap_blocked")
                    )
                )
            )
        ).scalars().all()
        actions = {a.action for a in audits}
        assert "karma.collusion_blocked" in actions
        assert "karma.same_pair_cap_blocked" in actions
        await db.commit()


async def test_all_five_badges_and_leaderboard_opt_in_zero_pii(
    client: AsyncClient,
    fake_messaging: FakeMessagingProvider,
) -> None:
    tok_a, uid_a = await _otp_login(client, fake_messaging, "9876543630")
    _, uid_b = await _otp_login(client, fake_messaging, "9876543631")
    h_a = {"Authorization": f"Bearer {tok_a}"}

    # Opt A into leaderboard, leave B opted out
    p_a = await client.patch(
        "/v1/me",
        headers=h_a,
        json={"leaderboard_opt_in": True, "display_alias": "HelpfulRail21"},
    )
    assert p_a.status_code == 200
    assert p_a.json()["leaderboard_opt_in"] is True

    app: Any = client.app  # type: ignore[attr-defined]
    async with app.state.session_factory() as db:
        # Mark A with 10 completed swaps for ten_swaps badge + exclude deleted user
        user_a = (await db.execute(select(User).where(User.id == UUID(uid_a)))).scalar_one()
        user_a.reliability_completed = 10
        user_b = (await db.execute(select(User).where(User.id == UUID(uid_b)))).scalar_one()
        user_b.display_alias = "HiddenHelper"
        user_b.leaderboard_opt_in = False

        deleted_opt_in = User(
            id=uuid7(),
            phone_enc=encrypt_phone("9876543699", app.state.settings.phone_aes_key),
            phone_bidx=blind_index("9876543699", app.state.settings.phone_blind_index_key),
            display_alias="ErasedUser",
            leaderboard_opt_in=True,
            status="deleted",
            erased_at=datetime.now(UTC),
        )
        db.add(deleted_opt_in)

        # Night owl IST 23:30 + family_uniter (together goal) + senior_saviour
        dep_night = datetime(2026, 12, 5, 18, 0, tzinfo=UTC)  # 23:30 IST
        ji = JourneyInstance(
            id=uuid7(),
            mode="train",
            carrier_code="IR",
            service_no="12955",
            service_date=dep_night.date(),
            departure_at=dep_night,
            arrival_at=dep_night + timedelta(hours=10),
            chart_state="final",
        )
        db.add(ji)
        await db.flush()

        bk_a = Booking(
            id=uuid7(),
            journey_instance_id=ji.id,
            owner_user_id=UUID(uid_a),
            pnr_hash=b"bdg-a",
            travel_class="3A",
            trust_tier="verified_provider",
            purge_after=dep_night + timedelta(days=30),
        )
        bk_b = Booking(
            id=uuid7(),
            journey_instance_id=ji.id,
            owner_user_id=UUID(uid_b),
            pnr_hash=b"bdg-b",
            travel_class="3A",
            trust_tier="verified_provider",
            purge_after=dep_night + timedelta(days=30),
        )
        db.add_all([bk_a, bk_b])
        await db.flush()

        sh_a = SeatHolder(
            id=uuid7(),
            booking_id=bk_a.id,
            pax_seq=1,
            coach="B1",
            seat_no="1",
            seat_type="LB",
            age_band="adult",
            gender_band="M",
        )
        sh_b = SeatHolder(
            id=uuid7(),
            booking_id=bk_b.id,
            pax_seq=1,
            coach="B1",
            seat_no="3",
            seat_type="UB",
            age_band="senior",
            gender_band="F",
        )
        db.add_all([sh_a, sh_b])
        await db.flush()

        party_b = Party(id=uuid7(), journey_instance_id=ji.id, leader_user_id=UUID(uid_b))
        db.add(party_b)
        await db.flush()
        db.add(PartyMember(party_id=party_b.id, seat_holder_id=sh_b.id))
        db.add(
            Goal(
                id=uuid7(),
                party_id=party_b.id,
                goal_type="together",
                movers=[sh_b.id],
                constraints={},
            )
        )

        prop = SwapProposal(
            id=uuid7(),
            journey_instance_id=ji.id,
            initiator_user_id=UUID(uid_a),
            kind="plan",
            status="completed",
            expires_at=dep_night - timedelta(hours=1),
            confirmed_at=dep_night - timedelta(hours=2),
        )
        db.add(prop)
        await db.flush()
        parts = [
            SwapParticipant(
                proposal_id=prop.id,
                seat_holder_id=sh_a.id,
                user_id=UUID(uid_a),
                alias="A",
                gives_seat="B1-1 LB",
                gets_seat="B1-3 UB",
                gives_seat_type="LB",
                gets_seat_type="UB",
                decision="accepted",
            ),
            SwapParticipant(
                proposal_id=prop.id,
                seat_holder_id=sh_b.id,
                user_id=UUID(uid_b),
                alias="B",
                gives_seat="B1-3 UB",
                gets_seat="B1-1 LB",
                gives_seat_type="UB",
                gets_seat_type="LB",
                decision="accepted",
            ),
        ]
        db.add_all(parts)
        await db.flush()

        awarded = await evaluate_and_award_badges(db=db, proposal=prop, parts=parts, ji=ji)
        assert set(awarded[UUID(uid_a)]) == {
            "first_swap",
            "ten_swaps",
            "senior_saviour",
            "family_uniter",
            "night_owl",
        }
        # Idempotent re-evaluation awards zero duplicates
        awarded_again = await evaluate_and_award_badges(db=db, proposal=prop, parts=parts, ji=ji)
        assert awarded_again == {}

        db.add(
            KarmaLedger(
                user_id=UUID(uid_a),
                proposal_id=prop.id,
                delta=150,
                state="credited",
                reason="swap_completed",
            )
        )
        await db.commit()

    wallet = (await client.get("/v1/karma", headers=h_a)).json()
    assert len(wallet["badges"]) == 5
    lb = wallet["leaderboard"]
    assert len(lb) == 1
    assert lb[0]["display_alias"] == "HelpfulRail21"
    assert lb[0]["points"] == 150
    assert set(lb[0].keys()) == {"rank", "display_alias", "points", "swaps_completed"}


async def test_rewards_catalogue_flag_gated_and_redemption(
    client: AsyncClient,
    fake_messaging: FakeMessagingProvider,
) -> None:
    tok_a, uid_a = await _otp_login(client, fake_messaging, "9876543640")
    h_a = {"Authorization": f"Bearer {tok_a}"}

    # Disabled by default -> 403 RFC 9457
    r_list_off = await client.get("/v1/karma/rewards", headers=h_a)
    assert r_list_off.status_code == 403
    assert r_list_off.headers["content-type"].startswith("application/problem+json")

    r_red_off = await client.post(
        "/v1/karma/rewards/redeem",
        headers=h_a,
        json={"reward_code": "chai_voucher"},
    )
    assert r_red_off.status_code == 403
    assert r_red_off.headers["content-type"].startswith("application/problem+json")

    app: Any = client.app  # type: ignore[attr-defined]
    async with app.state.session_factory() as db:
        flag = (
            await db.execute(
                select(FeatureFlag).where(FeatureFlag.key == "rewards_catalogue_enabled")
            )
        ).scalar_one_or_none()
        if flag is None:
            db.add(
                FeatureFlag(
                    key="rewards_catalogue_enabled",
                    value=True,
                    description="test",
                    updated_by="test",
                )
            )
        else:
            flag.value = True
        db.add(
            RewardItem(
                id=uuid7(),
                code="chai_voucher",
                title_en="Station Chai Voucher",
                title_hi="स्टेशन चाय वाउचर",
                description_en="Redeem for a hot masala chai.",
                description_hi="गरम मसाला चाय के लिए रिडीम करें।",
                cost_points=80,
                stock=1,
                active=True,
            )
        )
        await db.commit()

    try:
        # Insufficient balance -> 409
        insuff = await client.post(
            "/v1/karma/rewards/redeem",
            headers=h_a,
            json={"reward_code": "chai_voucher"},
        )
        assert insuff.status_code == 409

        # Credit 100 karma
        async with app.state.session_factory() as db:
            db.add(
                KarmaLedger(
                    user_id=UUID(uid_a),
                    proposal_id=None,
                    delta=100,
                    state="credited",
                    reason="test_credit",
                )
            )
            await db.commit()

        cat = await client.get("/v1/karma/rewards", headers=h_a)
        assert cat.status_code == 200
        assert cat.json()["enabled"] is True
        assert cat.json()["items"][0]["code"] == "chai_voucher"

        red = await client.post(
            "/v1/karma/rewards/redeem",
            headers=h_a,
            json={"reward_code": "chai_voucher"},
        )
        assert red.status_code == 201
        assert red.json()["points_spent"] == 80
        assert red.json()["status"] == "pending"

        wallet = (await client.get("/v1/karma", headers=h_a)).json()
        assert wallet["balance"] == 100
        assert wallet["redeemed_points"] == 80
        assert wallet["available_balance"] == 20

        async with app.state.session_factory() as db:
            db_reds = (
                await db.execute(
                    select(RewardRedemption).where(RewardRedemption.user_id == UUID(uid_a))
                )
            ).scalars().all()
            assert len(db_reds) == 1
            outbox_req = (
                await db.execute(
                    select(NotificationsOutbox).where(
                        NotificationsOutbox.user_id == UUID(uid_a),
                        NotificationsOutbox.event == "RewardRedemptionRequested",
                    )
                )
            ).scalars().all()
            assert len(outbox_req) == 1

        # Out of stock -> 409
        oos = await client.post(
            "/v1/karma/rewards/redeem",
            headers=h_a,
            json={"reward_code": "chai_voucher"},
        )
        assert oos.status_code == 409
    finally:
        async with app.state.session_factory() as db:
            flag = (
                await db.execute(
                    select(FeatureFlag).where(FeatureFlag.key == "rewards_catalogue_enabled")
                )
            ).scalar_one_or_none()
            if flag is not None:
                flag.value = False
                await db.commit()


async def test_cycle_helped_senior_and_senior_saviour_linked_to_giver(
    client: AsyncClient,
    fake_messaging: FakeMessagingProvider,
) -> None:
    _, uid_a = await _otp_login(client, fake_messaging, "9876543650")
    _, uid_b = await _otp_login(client, fake_messaging, "9876543651")
    _, uid_c = await _otp_login(client, fake_messaging, "9876543652")

    app: Any = client.app  # type: ignore[attr-defined]
    yaml_cfg = load_yaml_configs(app.state.settings.config_dir)

    async with app.state.session_factory() as db:
        now = datetime.now(UTC)
        ji = JourneyInstance(
            id=uuid7(),
            mode="train",
            carrier_code="IR",
            service_no="12957",
            service_date=(now + timedelta(days=5)).date(),
            departure_at=now + timedelta(days=5),
            arrival_at=now + timedelta(days=6),
            chart_state="final",
        )
        db.add(ji)
        await db.flush()

        bk_a = Booking(
            id=uuid7(),
            journey_instance_id=ji.id,
            owner_user_id=UUID(uid_a),
            pnr_hash=b"cyc-a",
            travel_class="3A",
            trust_tier="verified_provider",
            purge_after=now + timedelta(days=30),
        )
        bk_b = Booking(
            id=uuid7(),
            journey_instance_id=ji.id,
            owner_user_id=UUID(uid_b),
            pnr_hash=b"cyc-b",
            travel_class="3A",
            trust_tier="verified_provider",
            purge_after=now + timedelta(days=30),
        )
        bk_c = Booking(
            id=uuid7(),
            journey_instance_id=ji.id,
            owner_user_id=UUID(uid_c),
            pnr_hash=b"cyc-c",
            travel_class="3A",
            trust_tier="verified_provider",
            purge_after=now + timedelta(days=30),
        )
        db.add_all([bk_a, bk_b, bk_c])
        await db.flush()

        sh_a = SeatHolder(
            id=uuid7(),
            booking_id=bk_a.id,
            pax_seq=1,
            coach="B1",
            seat_no="1",
            seat_type="LB",
            age_band="adult",
            gender_band="M",
        )
        sh_b = SeatHolder(
            id=uuid7(),
            booking_id=bk_b.id,
            pax_seq=1,
            coach="B1",
            seat_no="2",
            seat_type="SL",
            age_band="adult",
            gender_band="M",
        )
        sh_c = SeatHolder(
            id=uuid7(),
            booking_id=bk_c.id,
            pax_seq=1,
            coach="B1",
            seat_no="3",
            seat_type="UB",
            age_band="senior",
            gender_band="M",
        )
        db.add_all([sh_a, sh_b, sh_c])
        await db.flush()

        prop = SwapProposal(
            id=uuid7(),
            journey_instance_id=ji.id,
            initiator_user_id=UUID(uid_a),
            kind="cycle3",
            status="completed",
            expires_at=now + timedelta(hours=3),
            confirmed_at=now,
        )
        db.add(prop)
        await db.flush()

        # Cycle: A gives LB to B (adult); B gives SL to C (senior); C gives UB to A
        parts = [
            SwapParticipant(
                proposal_id=prop.id,
                seat_holder_id=sh_a.id,
                user_id=UUID(uid_a),
                alias="A",
                gives_seat="B1-1 LB",
                gets_seat="B1-3 UB",
                gives_seat_type="LB",
                gets_seat_type="UB",
                decision="accepted",
            ),
            SwapParticipant(
                proposal_id=prop.id,
                seat_holder_id=sh_b.id,
                user_id=UUID(uid_b),
                alias="B",
                gives_seat="B1-2 SL",
                gets_seat="B1-1 LB",
                gives_seat_type="SL",
                gets_seat_type="LB",
                decision="accepted",
            ),
            SwapParticipant(
                proposal_id=prop.id,
                seat_holder_id=sh_c.id,
                user_id=UUID(uid_c),
                alias="C",
                gives_seat="B1-3 UB",
                gets_seat="B1-2 SL",
                gives_seat_type="UB",
                gets_seat_type="SL",
                decision="accepted",
            ),
        ]
        db.add_all(parts)
        await db.flush()

        ctxs = await _load_participant_contexts(db, parts)
        # A gave LB to adult B -> 100 (LB) + 10 (cycle) = 110 (no helped_senior)
        assert (
            calculate_participant_karma(
                user_id=UUID(uid_a),
                proposal=prop,
                contexts=ctxs,
                ji=ji,
                karma_config=yaml_cfg.karma,
            )
            == 110
        )
        # B gave SL to senior C -> 75 (SL) + 25 (helped_senior) + 10 (cycle) = 110
        assert (
            calculate_participant_karma(
                user_id=UUID(uid_b),
                proposal=prop,
                contexts=ctxs,
                ji=ji,
                karma_config=yaml_cfg.karma,
            )
            == 110
        )
        # C gave UB to adult A -> 50 (UB) + 10 (cycle) = 60
        assert (
            calculate_participant_karma(
                user_id=UUID(uid_c),
                proposal=prop,
                contexts=ctxs,
                ji=ji,
                karma_config=yaml_cfg.karma,
            )
            == 60
        )

        awarded = await evaluate_and_award_badges(db=db, proposal=prop, parts=parts, ji=ji)
        assert "senior_saviour" in awarded[UUID(uid_b)]
        assert "senior_saviour" not in awarded.get(UUID(uid_a), [])
        assert "senior_saviour" not in awarded.get(UUID(uid_c), [])
        await db.commit()
