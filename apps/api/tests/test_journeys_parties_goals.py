from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from httpx import AsyncClient
from sqlalchemy import select

from saath_api.notifications.models import NotificationsOutbox
from saath_api.parties.models import Goal, Party
from saath_api.providers.messaging import FakeMessagingProvider


async def _otp_login(
    client: AsyncClient,
    fake_messaging: FakeMessagingProvider,
    phone: str,
    *,
    anon_token: str | None = None,
) -> tuple[str, str]:
    start = await client.post(
        "/v1/auth/otp/start",
        json={"phone": phone, "channel": "whatsapp", "turnstile": "ok"},
    )
    assert start.status_code == 200
    code = fake_messaging.sent_messages[-1].code
    headers = {"Authorization": f"Bearer {anon_token}"} if anon_token else {}
    verify = await client.post(
        "/v1/auth/otp/verify",
        headers=headers,
        json={"request_id": start.json()["request_id"], "code": code},
    )
    assert verify.status_code == 200
    body = verify.json()
    return str(body["access"]), str(body["user"]["id"])


async def test_anon_verify_merges_to_otp_user_and_journey_hub_crud(
    client: AsyncClient,
    fake_messaging: FakeMessagingProvider,
) -> None:
    anon_token = (await client.post("/v1/auth/anonymous", json={"turnstile": "ok"})).json()[
        "access"
    ]

    # Bus mode returns clean 422
    bus_resp = await client.post(
        "/v1/journeys/verify",
        headers={"Authorization": f"Bearer {anon_token}"},
        json={"mode": "bus"},
    )
    assert bus_resp.status_code == 422
    assert bus_resp.json()["code"] == "bus_coming_soon"

    # Simulated upstream provider failure returns 503 problem+json in test mode
    fail_resp = await client.post(
        "/v1/journeys/verify",
        headers={
            "Authorization": f"Bearer {anon_token}",
            "X-Simulate-Provider-Failure": "true",
        },
        json={"mode": "train", "pnr": "2415678901"},
    )
    assert fail_resp.status_code == 503
    assert fail_resp.headers["content-type"].startswith("application/problem+json")
    assert fail_resp.json()["code"] == "rail_provider_unavailable"

    # Verify train PNR anonymously
    verify_resp = await client.post(
        "/v1/journeys/verify",
        headers={"Authorization": f"Bearer {anon_token}"},
        json={"mode": "train", "pnr": "2415678901"},
    )
    assert verify_resp.status_code == 200
    vbody = verify_resp.json()
    journey_id = vbody["journey"]["id"]
    assert "2415678901" not in verify_resp.text
    assert len(vbody["seat_holders"]) == 2

    # Merge anonymous booking & party into OTP user
    user_token, _ = await _otp_login(client, fake_messaging, "9876543210", anon_token=anon_token)
    user_headers = {"Authorization": f"Bearer {user_token}"}

    list_resp = await client.get("/v1/journeys", headers=user_headers)
    assert list_resp.status_code == 200
    assert len(list_resp.json()["items"]) == 1

    hub_resp = await client.get(f"/v1/journeys/{journey_id}", headers=user_headers)
    assert hub_resp.status_code == 200
    hub = hub_resp.json()
    assert hub["party"]["leader_is_me"] is True
    assert any(s["code"] == "senior_upper_to_lower" for s in hub["suggestions"])
    assert any(s["code"] == "split_coaches" for s in hub["suggestions"])

    # Another user gets 403 on journey detail
    other_token, _ = await _otp_login(client, fake_messaging, "9876543211")
    forbidden_hub = await client.get(
        f"/v1/journeys/{journey_id}",
        headers={"Authorization": f"Bearer {other_token}"},
    )
    assert forbidden_hub.status_code == 403

    # Reverify with X-Simulate-Chart-Change emits BerthChanged outbox event
    reverify_resp = await client.post(
        f"/v1/journeys/{journey_id}/reverify",
        headers={**user_headers, "X-Simulate-Chart-Change": "true"},
    )
    assert reverify_resp.status_code == 200
    assert reverify_resp.json()["chart"]["state"] == "final"

    app: Any = client.app  # type: ignore[attr-defined]
    async with app.state.session_factory() as db:
        outbox = (
            (
                await db.execute(
                    select(NotificationsOutbox).where(NotificationsOutbox.event == "BerthChanged")
                )
            )
            .scalars()
            .all()
        )
        assert len(outbox) == 1

    # Delete journey booking
    del_resp = await client.delete(f"/v1/journeys/{journey_id}", headers=user_headers)
    assert del_resp.status_code == 200
    after_list = await client.get("/v1/journeys", headers=user_headers)
    assert after_list.json()["items"] == []


async def test_party_invite_join_expiry_cross_journey_and_women_only_guard(
    client: AsyncClient,
    fake_messaging: FakeMessagingProvider,
) -> None:
    leader_tok, _ = await _otp_login(client, fake_messaging, "9876543220")
    joiner_tok, _ = await _otp_login(client, fake_messaging, "9876543221")
    leader_h = {"Authorization": f"Bearer {leader_tok}"}
    joiner_h = {"Authorization": f"Bearer {joiner_tok}"}

    v1 = (
        await client.post(
            "/v1/journeys/verify",
            headers=leader_h,
            json={"mode": "train", "pnr": "2415678903"},  # male adult B5-14
        )
    ).json()
    j1_id = v1["journey"]["id"]
    party_id = v1["party_id"]
    mover_id = v1["seat_holders"][0]["id"]

    # Male / undisclosed cannot enable women_only -> 403 women_only_not_eligible
    bad_goal = await client.put(
        f"/v1/parties/{party_id}/goal",
        headers=leader_h,
        json={
            "goal_type": "lower",
            "movers": [mover_id],
            "constraints": {"women_only": True},
        },
    )
    assert bad_goal.status_code == 403
    assert bad_goal.json()["code"] == "women_only_not_eligible"

    # Valid goal succeeds
    ok_goal = await client.put(
        f"/v1/parties/{party_id}/goal",
        headers=leader_h,
        json={
            "goal_type": "lower",
            "movers": [mover_id],
            "constraints": {"no_middle": True, "women_only": False},
        },
    )
    assert ok_goal.status_code == 200
    assert ok_goal.json()["goal"]["goal_type"] == "lower"

    # Invite token + cross-journey rejection (422) + valid same-journey merge
    inv = (await client.post(f"/v1/journeys/{j1_id}/party/invite", headers=leader_h)).json()
    invite_token = inv["invite_token"]

    cross = await client.post(
        "/v1/party/join",
        headers=joiner_h,
        json={"invite_token": invite_token, "mode": "train", "pnr": "2415678971"},
    )
    assert cross.status_code == 422
    assert cross.json()["code"] == "cross_journey_join_forbidden"

    same = await client.post(
        "/v1/party/join",
        headers=joiner_h,
        json={"invite_token": invite_token, "mode": "train", "pnr": "2415678902"},
    )
    assert same.status_code == 200
    assert same.json()["party"]["member_count"] == 2

    # Non-leader cannot create party invite (403)
    non_leader_inv = await client.post(f"/v1/journeys/{j1_id}/party/invite", headers=joiner_h)
    assert non_leader_inv.status_code == 403

    # Non-leader cannot remove a member (403)
    joined_sh_id = [m["id"] for m in same.json()["party"]["members"] if m["id"] != mover_id][0]
    non_leader_rm = await client.delete(
        f"/v1/party/{party_id}/members/{joined_sh_id}",
        headers=joiner_h,
    )
    assert non_leader_rm.status_code == 403

    # Set a goal covering both members, then remove joined_sh_id -> Goal.movers pruned
    both_goal = await client.put(
        f"/v1/parties/{party_id}/goal",
        headers=leader_h,
        json={
            "goal_type": "together",
            "movers": [mover_id, joined_sh_id],
            "constraints": {"women_only": False},
        },
    )
    assert both_goal.status_code == 200

    # Leader can remove joined member & Goal.movers is pruned
    leader_rm = await client.delete(
        f"/v1/party/{party_id}/members/{joined_sh_id}",
        headers=leader_h,
    )
    assert leader_rm.status_code == 200
    assert leader_rm.json()["party"]["member_count"] == 1
    assert leader_rm.json()["goal"]["movers"] == [mover_id]

    # Re-joining after removal succeeds without outbox idempotency collision
    rejoin = await client.post(
        "/v1/party/join",
        headers=joiner_h,
        json={"invite_token": invite_token, "mode": "train", "pnr": "2415678902"},
    )
    assert rejoin.status_code == 200
    assert rejoin.json()["party"]["member_count"] == 2

    # If leader deletes their journey while other member remains, leadership transfers & Goal.movers prunes
    del_leader = await client.delete(f"/v1/journeys/{j1_id}", headers=leader_h)
    assert del_leader.status_code == 200
    joiner_hub = await client.get(f"/v1/journeys/{j1_id}", headers=joiner_h)
    assert joiner_hub.status_code == 200
    assert joiner_hub.json()["party"]["leader_is_me"] is True
    assert joiner_hub.json()["goal"] is None  # movers became empty for non-open_to_help goal

    # Expired 48h invite returns 410 Gone
    app: Any = client.app  # type: ignore[attr-defined]
    async with app.state.session_factory() as db:
        party = (await db.execute(select(Party).where(Party.id == party_id))).scalar_one()
        assert party.leader_user_id is not None
        goals = (
            (await db.execute(select(Goal).where(Goal.party_id == party_id, Goal.active.is_(True))))
            .scalars()
            .all()
        )
        assert goals == []
        party.invite_expires_at = datetime.now(UTC) - timedelta(minutes=1)
        await db.commit()

    expired_join = await client.post(
        "/v1/party/join",
        headers=joiner_h,
        json={"invite_token": invite_token, "mode": "train", "pnr": "2415678904"},
    )
    assert expired_join.status_code == 410
    assert expired_join.json()["code"] == "invite_expired"

    # Female user can set women_only goal, but NOT if a male mover is selected
    female_tok, _ = await _otp_login(client, fake_messaging, "9876543222")
    female_h = {"Authorization": f"Bearer {female_tok}"}
    await client.patch("/v1/me", headers=female_h, json={"gender_self": "female"})
    fv_mixed = (
        await client.post(
            "/v1/journeys/verify",
            headers=female_h,
            json={"mode": "train", "pnr": "2415678901"},  # pax 1=F, pax 2=M
        )
    ).json()
    mixed_bad = await client.put(
        f"/v1/parties/{fv_mixed['party_id']}/goal",
        headers=female_h,
        json={
            "goal_type": "together",
            "movers": [sh["id"] for sh in fv_mixed["seat_holders"]],
            "constraints": {"women_only": True},
        },
    )
    assert mixed_bad.status_code == 403
    assert mixed_bad.json()["code"] == "women_only_not_eligible"

    fv = (
        await client.post(
            "/v1/journeys/verify",
            headers=female_h,
            json={
                "mode": "train",
                "sms_text": "PNR 2415678998 Train 12951 DOJ 25-11-26 3A CNF/B2/10/MB",
            },
        )
    ).json()
    assert fv["trust_tier"] == "verified_doc"
    fg = await client.put(
        f"/v1/parties/{fv['party_id']}/goal",
        headers=female_h,
        json={
            "goal_type": "lower",
            "movers": [fv["seat_holders"][0]["id"]],
            "constraints": {"women_only": True},
        },
    )
    assert fg.status_code == 200
    assert fg.json()["goal"]["constraints"]["women_only"] is True
