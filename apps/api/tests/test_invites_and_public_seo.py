from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from httpx import AsyncClient
from sqlalchemy import select

from saath_api.admin.models import FeatureFlag
from saath_api.ai.models import AiUsageLog
from saath_api.auth.models import AuditLog
from saath_api.core.crypto import hash_invite_token
from saath_api.karma.models import Badge, KarmaLedger, RewardItem, RewardRedemption
from saath_api.providers.flight.layouts import AIRCRAFT_LAYOUTS
from saath_api.public.models import SeatInvite
from saath_api.public.train_catalog import get_train_entry, is_valid_train_no, train_catalog_count

_FORBIDDEN_PII_KEYS = {
    "name",
    "full_name",
    "passenger_name",
    "pax_name",
    "age",
    "dob",
    "gender",
    "gender_self",
    "gender_band",
    "phone",
    "phone_enc",
    "phone_bidx",
    "mobile",
    "email",
    "pnr",
    "raw_pnr",
    "pnr_hash",
    "seat_no",
    "berth_no",
}


def _assert_zero_pii(payload: Any, forbidden_values: list[str] | None = None) -> None:
    if isinstance(payload, dict):
        for k, v in payload.items():
            assert k.lower() not in _FORBIDDEN_PII_KEYS, f"Forbidden PII key leaked: {k}"
            _assert_zero_pii(v, forbidden_values)
    elif isinstance(payload, list):
        for item in payload:
            _assert_zero_pii(item, forbidden_values)
    elif isinstance(payload, str) and forbidden_values:
        for secret in forbidden_values:
            assert secret not in payload, f"Forbidden PII value leaked: {secret}"


async def _login_user(client: AsyncClient, phone: str) -> tuple[str, str]:
    start = await client.post(
        "/v1/auth/otp/start",
        json={"phone": phone, "channel": "whatsapp", "turnstile": "ok", "locale": "en"},
    )
    assert start.status_code == 200
    request_id = start.json()["request_id"]
    app: Any = client.app  # type: ignore[attr-defined]
    sent = [m for m in app.state.messaging_provider.sent_otps if m.phone_e164.endswith(phone)]
    code = sent[-1].code
    verify = await client.post(
        "/v1/auth/otp/verify",
        json={"request_id": request_id, "code": code},
    )
    assert verify.status_code == 200
    data = verify.json()
    return data["access"], data["user"]["id"]


def test_train_catalog_and_flight_layouts_counts() -> None:
    assert train_catalog_count() == 3000
    assert is_valid_train_no("12951") is True
    assert is_valid_train_no("00000") is False
    entry = get_train_entry("12951")
    assert entry is not None
    assert entry.from_code == "NDLS"
    assert len(AIRCRAFT_LAYOUTS) == 25


async def test_m5_models_imported_and_feature_flags_accessible(client: AsyncClient) -> None:
    # Verify M5 ORM classes are cleanly wired into metadata
    for cls in (
        SeatInvite,
        KarmaLedger,
        Badge,
        FeatureFlag,
        RewardItem,
        RewardRedemption,
        AiUsageLog,
    ):
        assert cls.__tablename__
    resp = await client.get("/v1/public/stats")
    assert resp.status_code == 200
    assert "cache-control" in {k.lower() for k in resp.headers}
    body = resp.json()
    assert body["active_trains_catalog_count"] == 3000
    assert body["flight_layouts_count"] == 25


async def test_seat_invite_lifecycle_authz_and_conversion(client: AsyncClient) -> None:
    inviter_token, _ = await _login_user(client, "9876500191")
    other_token, _ = await _login_user(client, "9876500192")
    visitor_token, _ = await _login_user(client, "9876500193")

    # Unauthenticated invite creation -> 401 RFC 9457
    unauth = await client.post(
        "/v1/journeys/00000000-0000-0000-0000-000000000001/invite-seat",
        json={"coach": "B5"},
    )
    assert unauth.status_code == 401
    assert unauth.headers["content-type"].startswith("application/problem+json")

    v_inv = await client.post(
        "/v1/journeys/verify",
        headers={"Authorization": f"Bearer {inviter_token}"},
        json={"mode": "train", "pnr": "4111111111"},
    )
    assert v_inv.status_code == 200
    j_inv_id = v_inv.json()["journey"]["id"]
    p_inv_id = v_inv.json()["party"]["id"]
    h_inv_id = v_inv.json()["seat_holders"][0]["id"]

    await client.put(
        f"/v1/parties/{p_inv_id}/goal",
        headers={"Authorization": f"Bearer {inviter_token}"},
        json={"goal_type": "lower", "movers": [h_inv_id], "constraints": {}},
    )

    # Non-owner -> 403 RFC 9457
    non_owner = await client.post(
        f"/v1/journeys/{j_inv_id}/invite-seat",
        headers={"Authorization": f"Bearer {other_token}"},
        json={"coach": "B5"},
    )
    assert non_owner.status_code in (403, 404)
    assert non_owner.headers["content-type"].startswith("application/problem+json")

    # Out-of-range target -> 422 RFC 9457
    bad_target = await client.post(
        f"/v1/journeys/{j_inv_id}/invite-seat",
        headers={"Authorization": f"Bearer {inviter_token}"},
        json={"coach": "Z99", "seat_no": "999"},
    )
    assert bad_target.status_code == 422
    assert bad_target.headers["content-type"].startswith("application/problem+json")

    # Valid invite creation -> 201
    created = await client.post(
        f"/v1/journeys/{j_inv_id}/invite-seat",
        headers={"Authorization": f"Bearer {inviter_token}"},
        json={"coach": "B5", "seat_no": "11"},
    )
    assert created.status_code == 201
    c_body = created.json()
    assert "/j/" in c_body["invite_url"]
    assert len(c_body["message_en"]) > 10
    assert any("\u0900" <= ch <= "\u097f" for ch in c_body["message_hi"])

    # Public lookup -> 200 zero PII
    pub = await client.get(f"/v1/public/invites/{c_body['token']}")
    assert pub.status_code == 200
    pub_body = pub.json()
    assert pub_body["valid"] is True
    assert pub_body["service_no"] == "12951"
    assert pub_body["target_coach"] == "B5"
    assert pub_body["target_seat_no"] == "11"
    _assert_zero_pii(pub_body, ["4111111111"])

    # Visitor verifies WITHOUT open_to_help -> goal stays null
    v_other = await client.post(
        "/v1/journeys/verify",
        headers={"Authorization": f"Bearer {other_token}"},
        json={
            "mode": "train",
            "pnr": "4333333333",
            "invite_token": c_body["token"],
            "open_to_help": False,
        },
    )
    assert v_other.status_code == 200
    hub_other = await client.get(
        f"/v1/journeys/{v_other.json()['journey']['id']}",
        headers={"Authorization": f"Bearer {other_token}"},
    )
    assert hub_other.json()["goal"] is None

    # Visitor verifies WITH open_to_help -> creates open_to_help goal & match for inviter
    v_vis = await client.post(
        "/v1/journeys/verify",
        headers={"Authorization": f"Bearer {visitor_token}"},
        json={
            "mode": "train",
            "pnr": "4222222222",
            "invite_token": c_body["token"],
            "open_to_help": True,
        },
    )
    assert v_vis.status_code == 200

    matches = await client.get(
        f"/v1/parties/{p_inv_id}/matches",
        headers={"Authorization": f"Bearer {inviter_token}"},
    )
    assert matches.status_code == 200
    assert len(matches.json()["items"]) >= 1

    # Verify conversion counter & audit log
    pub_after = await client.get(f"/v1/public/invites/{c_body['token']}")
    assert pub_after.json()["conversions_count"] == 2

    app: Any = client.app  # type: ignore[attr-defined]
    async with app.state.session_factory() as db:
        audits = (
            (await db.execute(select(AuditLog).where(AuditLog.action == "seat_invite.converted")))
            .scalars()
            .all()
        )
        assert len(audits) == 2

        # Expire the token and verify 410 Gone
        token_hash = hash_invite_token(c_body["token"], app.state.settings.invite_token_secret)
        row = (
            await db.execute(select(SeatInvite).where(SeatInvite.token_hash == token_hash))
        ).scalar_one()
        row.expires_at = datetime.now(UTC) - timedelta(minutes=5)
        await db.commit()

    expired = await client.get(f"/v1/public/invites/{c_body['token']}")
    assert expired.status_code == 410
    assert expired.headers["content-type"].startswith("application/problem+json")

    missing = await client.get("/v1/public/invites/unknown-token-99999")
    assert missing.status_code == 404
    assert missing.headers["content-type"].startswith("application/problem+json")


async def test_public_seo_endpoints_zero_pii_and_errors(client: AsyncClient) -> None:
    # PNR status valid -> 200 + zero PII + Cache-Control
    pnr_ok = await client.get("/v1/public/pnr-status/2415678901")
    assert pnr_ok.status_code == 200
    assert "max-age=" in pnr_ok.headers.get("cache-control", "")
    _assert_zero_pii(pnr_ok.json(), ["2415678901"])
    assert pnr_ok.json()["train_no"] == "12951"
    assert pnr_ok.json()["passenger_count"] == 2

    # PNR status invalid / flushed / cancelled -> 404/422 RFC 9457
    for bad_pnr in ("ABC123", "9999999991", "9999999992", "1111111111"):
        bad = await client.get(f"/v1/public/pnr-status/{bad_pnr}")
        assert bad.status_code in (404, 422)
        assert bad.headers["content-type"].startswith("application/problem+json")

    # Train live / composition / chart-time -> 200 for 12951, 404 for 00000
    for suffix in ("live", "composition", "chart-time"):
        ok_resp = await client.get(f"/v1/public/train/12951/{suffix}")
        assert ok_resp.status_code == 200
        assert "max-age=" in ok_resp.headers.get("cache-control", "")

        err_resp = await client.get(f"/v1/public/train/00000/{suffix}")
        assert err_resp.status_code == 404
        assert err_resp.headers["content-type"].startswith("application/problem+json")

    # Flight layouts -> 200 matching list and empty list for unknown
    fl_ok = await client.get("/v1/public/flight-layouts?airline=6E&aircraft=A320neo")
    assert fl_ok.status_code == 200
    assert len(fl_ok.json()["items"]) == 1
    assert fl_ok.json()["items"][0]["layout_ref"] == "6E:A320neo"

    fl_empty = await client.get("/v1/public/flight-layouts?airline=XX&aircraft=BAD999")
    assert fl_empty.status_code == 200
    assert fl_empty.json()["items"] == []
