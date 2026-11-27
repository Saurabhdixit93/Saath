from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

from httpx import AsyncClient
from sqlalchemy import select

from saath_api.auth.models import AuditLog, User
from saath_api.matching.models import Block
from saath_api.notifications.models import NotificationsOutbox
from saath_api.notifications.templates import render_notification
from saath_api.providers.messaging import FakeMessagingProvider
from saath_api.swaps.cards import verify_swap_card_signature
from saath_api.swaps.models import SeatLock, SwapCard, SwapProposal
from saath_api.swaps.service import (
    expire_pending_swaps,
    invalidate_pending_swaps_for_user_pair,
)


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


async def test_concurrent_accept_race_and_stale_version_conflict(
    client: AsyncClient,
    fake_messaging: FakeMessagingProvider,
) -> None:
    tok_a, _ = await _otp_login(client, fake_messaging, "9876543401")
    tok_b, _ = await _otp_login(client, fake_messaging, "9876543402")
    tok_c, _ = await _otp_login(client, fake_messaging, "9876543403")
    h_a = {"Authorization": f"Bearer {tok_a}"}
    h_b = {"Authorization": f"Bearer {tok_b}"}
    h_c = {"Authorization": f"Bearer {tok_c}"}

    v_a = (
        await client.post(
            "/v1/journeys/verify", headers=h_a, json={"mode": "train", "pnr": "4111111111"}
        )
    ).json()
    v_b = (
        await client.post(
            "/v1/journeys/verify", headers=h_b, json={"mode": "train", "pnr": "4222222222"}
        )
    ).json()
    v_c = (
        await client.post(
            "/v1/journeys/verify", headers=h_c, json={"mode": "train", "pnr": "4333333333"}
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
        f"/v1/parties/{v_c['party']['id']}/goal",
        headers=h_c,
        json={
            "goal_type": "open_to_help",
            "movers": [v_c["seat_holders"][0]["id"]],
            "constraints": {},
        },
    )
    await client.put(
        f"/v1/parties/{v_a['party']['id']}/goal",
        headers=h_a,
        json={"goal_type": "lower", "movers": [v_a["seat_holders"][0]["id"]], "constraints": {}},
    )

    matches = (
        await client.get(f"/v1/parties/{v_a['party']['id']}/matches?kind=pair", headers=h_a)
    ).json()["items"]
    assert len(matches) >= 2

    s1 = (
        await client.post("/v1/swaps", headers=h_a, json={"card_id": matches[0]["card_id"]})
    ).json()
    s2 = (
        await client.post("/v1/swaps", headers=h_a, json={"card_id": matches[1]["card_id"]})
    ).json()

    r1, r2 = await asyncio.gather(
        client.post(f"/v1/swaps/{s1['id']}/accept", headers=h_a, json={"version": s1["version"]}),
        client.post(f"/v1/swaps/{s2['id']}/accept", headers=h_a, json={"version": s2["version"]}),
    )
    assert sorted([r1.status_code, r2.status_code]) == [200, 409]

    winner = r1.json() if r1.status_code == 200 else r2.json()
    loser_id = s2["id"] if r1.status_code == 200 else s1["id"]

    # Stale version rejected with 409
    partner_hdr = h_b if any(o["alias"] in str(winner) for o in [winner]) else h_b
    stale = await client.post(
        f"/v1/swaps/{winner['id']}/accept",
        headers=partner_hdr,
        json={"version": 0},
    )
    assert stale.status_code in (403, 409)

    # Initiator cannot be cancelled by non-initiator (403)
    non_init_cancel = await client.post(f"/v1/swaps/{loser_id}/cancel", headers=h_b)
    assert non_init_cancel.status_code == 403

    # Initiator cancel frees cleanly and preserves deterministic card_id for re-proposal
    cancelled = await client.post(f"/v1/swaps/{loser_id}/cancel", headers=h_a)
    assert cancelled.status_code == 200
    assert cancelled.json()["status"] == "cancelled"

    winner_card_id = matches[0]["card_id"] if r1.status_code == 200 else matches[1]["card_id"]
    # After winner is also declined, the original deterministic card_id works without re-fetching matches
    dec_winner = await client.post(
        f"/v1/swaps/{winner['id']}/decline", headers=h_a, json={"reason": "Reset"}
    )
    assert dec_winner.status_code == 200
    repropose = await client.post(
        "/v1/swaps",
        headers=h_a,
        json={"card_id": winner_card_id},
    )
    assert repropose.status_code == 201
    assert repropose.json()["status"] == "pending"


async def test_3way_decline_expiry_chart_invalidation_card_and_completion(
    client: AsyncClient,
    fake_messaging: FakeMessagingProvider,
) -> None:
    tok_a, uid_a = await _otp_login(client, fake_messaging, "9876543411")
    tok_b, _ = await _otp_login(client, fake_messaging, "9876543412")
    tok_c, _ = await _otp_login(client, fake_messaging, "9876543413")
    h_a = {"Authorization": f"Bearer {tok_a}"}
    h_b = {"Authorization": f"Bearer {tok_b}"}
    h_c = {"Authorization": f"Bearer {tok_c}"}

    v_a = (
        await client.post(
            "/v1/journeys/verify", headers=h_a, json={"mode": "train", "pnr": "4111111111"}
        )
    ).json()
    v_b = (
        await client.post(
            "/v1/journeys/verify", headers=h_b, json={"mode": "train", "pnr": "4222222222"}
        )
    ).json()
    v_c = (
        await client.post(
            "/v1/journeys/verify", headers=h_c, json={"mode": "train", "pnr": "4333333333"}
        )
    ).json()

    await client.put(
        f"/v1/parties/{v_b['party']['id']}/goal",
        headers=h_b,
        json={"goal_type": "upper", "movers": [v_b["seat_holders"][0]["id"]], "constraints": {}},
    )
    await client.put(
        f"/v1/parties/{v_c['party']['id']}/goal",
        headers=h_c,
        json={
            "goal_type": "specific_seats",
            "movers": [v_c["seat_holders"][0]["id"]],
            "preferred_seats": ["B3-20"],
            "constraints": {},
        },
    )
    await client.put(
        f"/v1/parties/{v_a['party']['id']}/goal",
        headers=h_a,
        json={"goal_type": "lower", "movers": [v_a["seat_holders"][0]["id"]], "constraints": {}},
    )

    c3_items = (
        await client.get(f"/v1/parties/{v_a['party']['id']}/matches?kind=cycle", headers=h_a)
    ).json()["items"]
    assert any(m["kind"] == "cycle3" for m in c3_items)
    c3_card = next(m for m in c3_items if m["kind"] == "cycle3")

    # 3-way proposal -> B accepts -> C declines -> locks released
    p_dec = (
        await client.post("/v1/swaps", headers=h_a, json={"card_id": c3_card["card_id"]})
    ).json()
    b_acc = await client.post(
        f"/v1/swaps/{p_dec['id']}/accept", headers=h_b, json={"version": p_dec["version"]}
    )
    assert b_acc.status_code == 200
    c_dec = await client.post(
        f"/v1/swaps/{p_dec['id']}/decline", headers=h_c, json={"reason": "No thanks"}
    )
    assert c_dec.status_code == 200
    assert c_dec.json()["status"] == "declined"

    app: Any = client.app  # type: ignore[attr-defined]
    async with app.state.session_factory() as db:
        locks = (
            (await db.execute(select(SeatLock).where(SeatLock.proposal_id == UUID(p_dec["id"]))))
            .scalars()
            .all()
        )
        assert locks == []

    # Re-propose & test expiry job
    p_exp = (
        await client.post("/v1/swaps", headers=h_a, json={"card_id": c3_card["card_id"]})
    ).json()
    async with app.state.session_factory() as db:
        prop = (
            await db.execute(select(SwapProposal).where(SwapProposal.id == UUID(p_exp["id"])))
        ).scalar_one()
        prop.expires_at = datetime.now(UTC) - timedelta(minutes=1)
        await db.commit()
        expired_count = await expire_pending_swaps(db=db, redis=app.state.redis)
        assert expired_count == 1

    # Re-propose & confirm all 3 -> Ed25519 SwapCard + SVG/PNG + public verify
    p_ok = (
        await client.post("/v1/swaps", headers=h_a, json={"card_id": c3_card["card_id"]})
    ).json()
    a1 = (
        await client.post(
            f"/v1/swaps/{p_ok['id']}/accept", headers=h_a, json={"version": p_ok["version"]}
        )
    ).json()
    a2 = (
        await client.post(
            f"/v1/swaps/{p_ok['id']}/accept", headers=h_b, json={"version": a1["version"]}
        )
    ).json()
    a3 = (
        await client.post(
            f"/v1/swaps/{p_ok['id']}/accept", headers=h_c, json={"version": a2["version"]}
        )
    ).json()
    assert a3["status"] == "confirmed"

    card_json = (await client.get(f"/v1/swaps/{p_ok['id']}/card?format=json", headers=h_a)).json()
    assert card_json["public_code"].startswith("SW-")
    async with app.state.session_factory() as db:
        sc = (
            await db.execute(select(SwapCard).where(SwapCard.proposal_id == UUID(p_ok["id"])))
        ).scalar_one()
        assert verify_swap_card_signature(
            sc.payload_json, bytes(sc.signature), app.state.settings.swap_card_signing_public_key
        )

    svg_res = await client.get(f"/v1/swaps/{p_ok['id']}/card?format=svg", headers=h_a)
    assert svg_res.status_code == 200
    assert "<svg" in svg_res.text

    png_res = await client.get(f"/v1/swaps/{p_ok['id']}/card?format=png", headers=h_a)
    assert png_res.status_code == 200
    assert png_res.content[:4] == b"\x89PNG"

    pub_ok = await client.get(f"/v1/public/swap-cards/{card_json['public_code']}")
    assert pub_ok.status_code == 200
    assert pub_ok.json()["valid"] is True
    assert pub_ok.json()["revoked"] is False

    # Post-journey confirmation -> completed & reliability incremented
    await client.post(
        f"/v1/swaps/{p_ok['id']}/confirm-completion", headers=h_a, json={"answer": "yes"}
    )
    # Conflicting answer rejected
    conflict = await client.post(
        f"/v1/swaps/{p_ok['id']}/confirm-completion", headers=h_a, json={"answer": "no"}
    )
    assert conflict.status_code == 409

    await client.post(
        f"/v1/swaps/{p_ok['id']}/confirm-completion", headers=h_b, json={"answer": "yes"}
    )
    fin = await client.post(
        f"/v1/swaps/{p_ok['id']}/confirm-completion", headers=h_c, json={"answer": "yes"}
    )
    assert fin.status_code == 200
    assert fin.json()["status"] == "completed"

    async with app.state.session_factory() as db:
        u_a = (await db.execute(select(User).where(User.id == UUID(uid_a)))).scalar_one()
        assert u_a.reliability_accepted >= 1
        assert u_a.reliability_completed >= 1


async def test_chart_change_invalidates_confirmed_swap_and_revokes_card(
    client: AsyncClient,
    fake_messaging: FakeMessagingProvider,
) -> None:
    tok_a, _ = await _otp_login(client, fake_messaging, "9876543421")
    tok_b, _ = await _otp_login(client, fake_messaging, "9876543422")
    h_a = {"Authorization": f"Bearer {tok_a}"}
    h_b = {"Authorization": f"Bearer {tok_b}"}

    v_a = (
        await client.post(
            "/v1/journeys/verify", headers=h_a, json={"mode": "train", "pnr": "4111111111"}
        )
    ).json()
    v_b = (
        await client.post(
            "/v1/journeys/verify", headers=h_b, json={"mode": "train", "pnr": "4222222222"}
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
        json={"goal_type": "lower", "movers": [v_a["seat_holders"][0]["id"]], "constraints": {}},
    )

    matches = (
        await client.get(f"/v1/parties/{v_a['party']['id']}/matches?kind=pair", headers=h_a)
    ).json()["items"]
    swap = (
        await client.post("/v1/swaps", headers=h_a, json={"card_id": matches[0]["card_id"]})
    ).json()
    a1 = (
        await client.post(
            f"/v1/swaps/{swap['id']}/accept", headers=h_a, json={"version": swap["version"]}
        )
    ).json()
    a2 = (
        await client.post(
            f"/v1/swaps/{swap['id']}/accept", headers=h_b, json={"version": a1["version"]}
        )
    ).json()
    assert a2["status"] == "confirmed"

    code = (await client.get(f"/v1/swaps/{swap['id']}/card?format=json", headers=h_a)).json()[
        "public_code"
    ]

    rev = await client.post(
        f"/v1/journeys/{v_a['journey']['id']}/reverify",
        headers={**h_a, "X-Simulate-Chart-Change": "true"},
    )
    assert rev.status_code == 200

    detail_after = (await client.get(f"/v1/swaps/{swap['id']}", headers=h_a)).json()
    assert detail_after["status"] == "invalidated"

    pub_after = (await client.get(f"/v1/public/swap-cards/{code}")).json()
    assert pub_after["revoked"] is True
    assert pub_after["valid"] is False


async def test_delete_journey_booking_invalidates_active_swap_and_revokes_card(
    client: AsyncClient,
    fake_messaging: FakeMessagingProvider,
) -> None:
    tok_a, _ = await _otp_login(client, fake_messaging, "9876543431")
    tok_b, _ = await _otp_login(client, fake_messaging, "9876543432")
    h_a = {"Authorization": f"Bearer {tok_a}"}
    h_b = {"Authorization": f"Bearer {tok_b}"}

    v_a = (
        await client.post(
            "/v1/journeys/verify", headers=h_a, json={"mode": "train", "pnr": "4111111111"}
        )
    ).json()
    v_b = (
        await client.post(
            "/v1/journeys/verify", headers=h_b, json={"mode": "train", "pnr": "4222222222"}
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
        json={"goal_type": "lower", "movers": [v_a["seat_holders"][0]["id"]], "constraints": {}},
    )

    matches = (
        await client.get(f"/v1/parties/{v_a['party']['id']}/matches?kind=pair", headers=h_a)
    ).json()["items"]
    swap = (
        await client.post("/v1/swaps", headers=h_a, json={"card_id": matches[0]["card_id"]})
    ).json()
    a1 = (
        await client.post(
            f"/v1/swaps/{swap['id']}/accept", headers=h_a, json={"version": swap["version"]}
        )
    ).json()
    a2 = (
        await client.post(
            f"/v1/swaps/{swap['id']}/accept", headers=h_b, json={"version": a1["version"]}
        )
    ).json()
    assert a2["status"] == "confirmed"

    code = (await client.get(f"/v1/swaps/{swap['id']}/card?format=json", headers=h_a)).json()[
        "public_code"
    ]

    del_res = await client.delete(f"/v1/journeys/{v_a['journey']['id']}", headers=h_a)
    assert del_res.status_code == 200

    detail_b = (await client.get(f"/v1/swaps/{swap['id']}", headers=h_b)).json()
    assert detail_b["status"] == "invalidated"

    app: Any = client.app  # type: ignore[attr-defined]
    async with app.state.session_factory() as db:
        locks = (
            (await db.execute(select(SeatLock).where(SeatLock.proposal_id == UUID(swap["id"]))))
            .scalars()
            .all()
        )
        assert locks == []

    pub_after = (await client.get(f"/v1/public/swap-cards/{code}")).json()
    assert pub_after["revoked"] is True
    assert pub_after["valid"] is False


async def test_block_invalidates_pending_swap_releases_locks_and_blocks_create_or_accept(
    client: AsyncClient,
    fake_messaging: FakeMessagingProvider,
) -> None:
    tok_a, uid_a = await _otp_login(client, fake_messaging, "9876543441")
    tok_b, uid_b = await _otp_login(client, fake_messaging, "9876543442")
    tok_c, uid_c = await _otp_login(client, fake_messaging, "9876543443")
    h_a = {"Authorization": f"Bearer {tok_a}"}
    h_b = {"Authorization": f"Bearer {tok_b}"}
    h_c = {"Authorization": f"Bearer {tok_c}"}

    v_a = (
        await client.post(
            "/v1/journeys/verify", headers=h_a, json={"mode": "train", "pnr": "4111111111"}
        )
    ).json()
    v_b = (
        await client.post(
            "/v1/journeys/verify", headers=h_b, json={"mode": "train", "pnr": "4222222222"}
        )
    ).json()
    v_c = (
        await client.post(
            "/v1/journeys/verify", headers=h_c, json={"mode": "train", "pnr": "4333333333"}
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
        f"/v1/parties/{v_c['party']['id']}/goal",
        headers=h_c,
        json={
            "goal_type": "open_to_help",
            "movers": [v_c["seat_holders"][0]["id"]],
            "constraints": {},
        },
    )
    await client.put(
        f"/v1/parties/{v_a['party']['id']}/goal",
        headers=h_a,
        json={"goal_type": "lower", "movers": [v_a["seat_holders"][0]["id"]], "constraints": {}},
    )

    matches = (
        await client.get(f"/v1/parties/{v_a['party']['id']}/matches?kind=pair", headers=h_a)
    ).json()["items"]
    assert len(matches) >= 2
    card_0 = matches[0]["card_id"]
    alias_0 = matches[0]["others"][0]["alias"]

    # 1. A proposes on matches[0] and accepts first (creates SeatLock for A's seat)
    swap_0 = (await client.post("/v1/swaps", headers=h_a, json={"card_id": card_0})).json()
    is_b_first = (await client.get(f"/v1/swaps/{swap_0['id']}", headers=h_b)).status_code == 200
    h_p1, uid_p1 = (h_b, uid_b) if is_b_first else (h_c, uid_c)
    h_p2, uid_p2 = (h_c, uid_c) if is_b_first else (h_b, uid_b)

    acc_a = await client.post(
        f"/v1/swaps/{swap_0['id']}/accept", headers=h_a, json={"version": swap_0["version"]}
    )
    assert acc_a.status_code == 200

    app: Any = client.app  # type: ignore[attr-defined]
    async with app.state.session_factory() as db:
        locks_before = (
            (await db.execute(select(SeatLock).where(SeatLock.proposal_id == UUID(swap_0["id"]))))
            .scalars()
            .all()
        )
        assert len(locks_before) == 1

    # 2. A blocks partner 1 -> pending swap invalidated, SeatLock released, neutral SwapInvalidated outbox written
    blk_res = await client.post("/v1/users/block", headers=h_a, json={"alias_ref": alias_0})
    assert blk_res.status_code == 200
    assert blk_res.json()["blocked"] is True

    detail_p1 = (await client.get(f"/v1/swaps/{swap_0['id']}", headers=h_p1)).json()
    assert detail_p1["status"] == "invalidated"

    async with app.state.session_factory() as db:
        locks_after = (
            (await db.execute(select(SeatLock).where(SeatLock.proposal_id == UUID(swap_0["id"]))))
            .scalars()
            .all()
        )
        assert locks_after == []
        outbox_rows = (
            (
                await db.execute(
                    select(NotificationsOutbox).where(
                        NotificationsOutbox.event == "SwapInvalidated",
                        NotificationsOutbox.user_id.in_([UUID(uid_a), UUID(uid_p1)]),
                    )
                )
            )
            .scalars()
            .all()
        )
        assert len(outbox_rows) == 2
        for row in outbox_rows:
            assert row.payload.get("reason") == "user_blocked"
            rendered_en = render_notification(event=row.event, payload=row.payload, locale="en")
            rendered_hi = render_notification(event=row.event, payload=row.payload, locale="hi")
            assert "Train chart updated" not in rendered_en.body
            assert rendered_en.title == "Swap proposal closed"
            assert "चार्ट" not in rendered_hi.body

    # 3. Race-window guard: Block created after match card fetch rejects accept & create with 403 user_blocked
    matches_after_p1 = (
        await client.get(f"/v1/parties/{v_a['party']['id']}/matches?kind=pair", headers=h_a)
    ).json()["items"]
    assert len(matches_after_p1) >= 1
    fresh_card_p2 = matches_after_p1[0]["card_id"]

    swap_p2 = (await client.post("/v1/swaps", headers=h_a, json={"card_id": fresh_card_p2})).json()
    async with app.state.session_factory() as db:
        db.add(Block(blocker=UUID(uid_p2), blocked=UUID(uid_a)))
        await db.commit()

    # accept_swap detects block in SERIALIZABLE tx -> invalidates proposal & returns 403 user_blocked
    acc_p2_blocked = await client.post(
        f"/v1/swaps/{swap_p2['id']}/accept",
        headers=h_p2,
        json={"version": swap_p2["version"]},
    )
    assert acc_p2_blocked.status_code == 403
    assert acc_p2_blocked.json()["code"] == "user_blocked"

    detail_p2 = (await client.get(f"/v1/swaps/{swap_p2['id']}", headers=h_a)).json()
    assert detail_p2["status"] == "invalidated"

    # create_swap_proposal detects block -> returns 403 user_blocked
    recreate_blocked = await client.post(
        "/v1/swaps",
        headers=h_a,
        json={"card_id": fresh_card_p2},
    )
    assert recreate_blocked.status_code == 403
    assert recreate_blocked.json()["code"] == "user_blocked"


async def test_block_does_not_invalidate_confirmed_swap_or_release_locks(
    client: AsyncClient,
    fake_messaging: FakeMessagingProvider,
) -> None:
    tok_a, uid_a = await _otp_login(client, fake_messaging, "9876543451")
    tok_b, uid_b = await _otp_login(client, fake_messaging, "9876543452")
    h_a = {"Authorization": f"Bearer {tok_a}"}
    h_b = {"Authorization": f"Bearer {tok_b}"}

    v_a = (
        await client.post(
            "/v1/journeys/verify", headers=h_a, json={"mode": "train", "pnr": "4111111111"}
        )
    ).json()
    v_b = (
        await client.post(
            "/v1/journeys/verify", headers=h_b, json={"mode": "train", "pnr": "4222222222"}
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
        json={"goal_type": "lower", "movers": [v_a["seat_holders"][0]["id"]], "constraints": {}},
    )

    matches = (
        await client.get(f"/v1/parties/{v_a['party']['id']}/matches?kind=pair", headers=h_a)
    ).json()["items"]
    assert len(matches) >= 1
    card = matches[0]
    partner_alias = card["others"][0]["alias"]

    swap = (await client.post("/v1/swaps", headers=h_a, json={"card_id": card["card_id"]})).json()
    acc1 = (
        await client.post(
            f"/v1/swaps/{swap['id']}/accept", headers=h_a, json={"version": swap["version"]}
        )
    ).json()
    acc2 = (
        await client.post(
            f"/v1/swaps/{swap['id']}/accept", headers=h_b, json={"version": acc1["version"]}
        )
    ).json()
    assert acc2["status"] == "confirmed"

    code = (await client.get(f"/v1/swaps/{swap['id']}/card?format=json", headers=h_a)).json()[
        "public_code"
    ]

    # Subsequent block must NOT invalidate an already-confirmed swap or release its SeatLocks
    blk_res = await client.post("/v1/users/block", headers=h_a, json={"alias_ref": partner_alias})
    assert blk_res.status_code == 200
    assert blk_res.json()["blocked"] is True

    detail_after = (await client.get(f"/v1/swaps/{swap['id']}", headers=h_a)).json()
    assert detail_after["status"] == "confirmed"

    pub_after = (await client.get(f"/v1/public/swap-cards/{code}")).json()
    assert pub_after["revoked"] is False
    assert pub_after["valid"] is True

    app: Any = client.app  # type: ignore[attr-defined]
    async with app.state.session_factory() as db:
        locks = (
            (await db.execute(select(SeatLock).where(SeatLock.proposal_id == UUID(swap["id"]))))
            .scalars()
            .all()
        )
        assert len(locks) == 2
        res = await invalidate_pending_swaps_for_user_pair(
            db=db, user_a=UUID(uid_a), user_b=UUID(uid_b)
        )
        assert res == []


async def test_pre_accept_swap_note_redaction_moderation_and_restricted_user(
    client: AsyncClient,
    fake_messaging: FakeMessagingProvider,
) -> None:
    tok_a, uid_a = await _otp_login(client, fake_messaging, "9876543461")
    tok_b, _ = await _otp_login(client, fake_messaging, "9876543462")
    h_a = {"Authorization": f"Bearer {tok_a}"}
    h_b = {"Authorization": f"Bearer {tok_b}"}

    v_a = (
        await client.post(
            "/v1/journeys/verify", headers=h_a, json={"mode": "train", "pnr": "4111111111"}
        )
    ).json()
    v_b = (
        await client.post(
            "/v1/journeys/verify", headers=h_b, json={"mode": "train", "pnr": "4222222222"}
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
        await client.get(f"/v1/parties/{v_a['party']['id']}/matches?kind=pair", headers=h_a)
    ).json()["items"]
    assert len(matches) >= 1
    card_id = matches[0]["card_id"]

    # Scam/harassment note is rejected with 422 and logged to AuditLog
    bad_note = await client.post(
        "/v1/swaps",
        headers=h_a,
        json={
            "card_id": card_id,
            "note": "Send advance money and share your otp before swapping",
        },
    )
    assert bad_note.status_code == 422
    assert bad_note.json()["code"] == "note_moderated"

    app: Any = client.app  # type: ignore[attr-defined]
    async with app.state.session_factory() as db:
        audit_row = (
            await db.execute(
                select(AuditLog).where(
                    AuditLog.actor == "system:moderation",
                    AuditLog.action == "swap_note.hidden",
                    AuditLog.resource == f"user:{uid_a}",
                )
            )
        ).scalar_one_or_none()
        assert audit_row is not None

    # Pre-accept contact info in note is redacted with ••• and up to 300 chars allowed
    padded_note = "Call me on 9876543210 or paytm asha@okicici. " + ("x" * 240)
    assert len(padded_note) <= 300
    redacted_swap = await client.post(
        "/v1/swaps",
        headers=h_a,
        json={"card_id": card_id, "note": padded_note},
    )
    assert redacted_swap.status_code == 201
    persisted_note = redacted_swap.json()["note"]
    assert "•••" in persisted_note
    assert "9876543210" not in persisted_note
    assert "okicici" not in persisted_note

    # Cancel to release locks, then verify restricted user cannot propose swap
    await client.post(f"/v1/swaps/{redacted_swap.json()['id']}/cancel", headers=h_a)
    async with app.state.session_factory() as db:
        user_a = (await db.execute(select(User).where(User.id == UUID(uid_a)))).scalar_one()
        user_a.status = "restricted"
        await db.commit()

    restricted_resp = await client.post(
        "/v1/swaps",
        headers=h_a,
        json={"card_id": card_id, "note": "Polite note"},
    )
    assert restricted_resp.status_code == 403
    assert restricted_resp.json()["code"] == "account_restricted"
