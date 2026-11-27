from __future__ import annotations

import hashlib
import json
import uuid
from datetime import UTC, date, datetime, timedelta
from typing import Any
from uuid import UUID

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from httpx import AsyncClient
from pydantic import ValidationError
from redis.exceptions import RedisError
from sqlalchemy import select

from saath_api.admin.models import FeatureFlag
from saath_api.admin.service import verify_google_oidc_token
from saath_api.auth.dependencies import Actor
from saath_api.auth.models import AuditLog, Device, RefreshToken
from saath_api.core.config import Settings
from saath_api.core.crypto import create_admin_token
from saath_api.core.errors import ProblemDetailError
from saath_api.core.ids import uuid7
from saath_api.export_openapi import export_openapi_schema
from saath_api.journeys.models import Booking, JourneyInstance, SeatHolder
from saath_api.karma.models import KarmaLedger, RewardItem, RewardRedemption
from saath_api.notifications.models import NotificationsOutbox
from saath_api.providers.messaging import FakeMessagingProvider
from saath_api.swaps.models import SeatLock, SwapParticipant, SwapProposal


async def _otp_login(
    client: AsyncClient,
    fake_messaging: FakeMessagingProvider,
    phone: str,
) -> tuple[str, str, str]:
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
    payload = verify.json()
    return str(payload["access"]), str(payload["refresh"]), str(payload["user"]["id"])


async def _get_admin_headers(
    client: AsyncClient,
    email: str = "ops@saath.test",
) -> dict[str, str]:
    resp = await client.post("/v1/admin/auth/session", json={"email": email})
    assert resp.status_code == 200
    data = resp.json()
    assert data["access"] == data["token"]
    assert data["token_type"] == "bearer"
    assert data["email"] == email
    assert "admin" in data["scopes"]
    return {"Authorization": f"Bearer {data['access']}"}


def _assert_problem_json(resp: Any, expected_status: int) -> dict[str, Any]:
    assert resp.status_code == expected_status
    assert resp.headers["content-type"].startswith("application/problem+json")
    body = resp.json()
    assert body["status"] == expected_status
    assert body["code"]
    assert body["title"]
    assert body["detail"]
    return body  # type: ignore[no-any-return]


async def test_admin_rbac_and_allowlist_isolation(
    client: AsyncClient,
    fake_messaging: FakeMessagingProvider,
) -> None:
    admin_get_routes = (
        "/v1/admin/analytics/funnel",
        "/v1/admin/providers/health",
        "/v1/admin/moderation/queue",
        "/v1/admin/fraud/graph",
        "/v1/admin/flags",
        "/v1/admin/disputes",
        "/v1/admin/redemptions",
        "/v1/admin/audit-log",
    )

    for path in admin_get_routes:
        unauth = await client.get(path)
        _assert_problem_json(unauth, 401)

    anon = await client.post("/v1/auth/anonymous", json={"turnstile": "ok"})
    anon_headers = {"Authorization": f"Bearer {anon.json()['access']}"}
    user_token, _, _ = await _otp_login(client, fake_messaging, "9876548001")
    user_headers = {"Authorization": f"Bearer {user_token}"}

    for path in admin_get_routes:
        _assert_problem_json(await client.get(path, headers=anon_headers), 403)
        _assert_problem_json(await client.get(path, headers=user_headers), 403)

    # Admin JWT missing "admin" scope is rejected with 403
    app_ref: Any = client.app  # type: ignore[attr-defined]
    scoped_token, _ = create_admin_token(
        app_ref.state.settings,
        email="ops@saath.test",
        scopes=("viewer",),
    )
    bad_scope = await client.get(
        "/v1/admin/flags",
        headers={"Authorization": f"Bearer {scoped_token}"},
    )
    _assert_problem_json(bad_scope, 403)

    # Non-allowlisted email rejected on session creation
    denied = await client.post(
        "/v1/admin/auth/session",
        json={"email": "intruder@example.com"},
    )
    _assert_problem_json(denied, 403)

    # Allowlisted session writes admin.session_created to audit_log
    admin_headers = await _get_admin_headers(client, "ops@saath.test")
    audit = await client.get(
        "/v1/admin/audit-log?action=admin.session_created",
        headers=admin_headers,
    )
    assert audit.status_code == 200
    assert audit.json()["total"] >= 1
    assert audit.json()["items"][0]["actor"] == "admin:ops@saath.test"


async def test_admin_production_sso_rejects_passwordless_and_accepts_verified_oidc(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    app_ref: Any = client.app  # type: ignore[attr-defined]
    orig_settings: Settings = app_ref.state.settings

    prod_like = orig_settings.model_copy(
        update={
            "env": "production",
            "admin_sso_client_id": "test-google-client.apps.googleusercontent.com",
            "admin_sso_allowed_emails": "lead@saath.in,ops@saath.in",
        }
    )
    monkeypatch.setattr(app_ref.state, "settings", prod_like)

    # Passwordless email-only login MUST be rejected in production
    no_sso = await client.post("/v1/admin/auth/session", json={"email": "lead@saath.in"})
    err = _assert_problem_json(no_sso, 403)
    assert err["code"] == "admin_sso_required"

    # Unconfigured allowlist in production MUST fail closed
    no_allowlist = prod_like.model_copy(update={"admin_sso_allowed_emails": ""})
    monkeypatch.setattr(app_ref.state, "settings", no_allowlist)
    misconfigured = await client.post(
        "/v1/admin/auth/session",
        json={"id_token": "fake-oidc-jwt"},
    )
    assert _assert_problem_json(misconfigured, 403)["code"] == "admin_sso_not_configured"
    monkeypatch.setattr(app_ref.state, "settings", prod_like)

    # Verified OIDC email NOT in allowlist rejected with 403
    async def _mock_non_allowlisted(
        _settings: Settings,
        *,
        id_token: str | None = None,
        code: str | None = None,
        redirect_uri: str | None = None,
    ) -> str:
        _ = (id_token, code, redirect_uri)
        return "stranger@gmail.com"

    monkeypatch.setattr(app_ref.state, "admin_oidc_verifier", _mock_non_allowlisted, raising=False)
    blocked = await client.post("/v1/admin/auth/session", json={"id_token": "valid-jwt"})
    assert _assert_problem_json(blocked, 403)["code"] == "admin_not_allowlisted"

    # Verified OIDC email IN allowlist succeeds and mints admin JWT accepted by endpoints
    async def _mock_allowlisted(
        _settings: Settings,
        *,
        id_token: str | None = None,
        code: str | None = None,
        redirect_uri: str | None = None,
    ) -> str:
        _ = (id_token, code, redirect_uri)
        return "lead@saath.in"

    monkeypatch.setattr(app_ref.state, "admin_oidc_verifier", _mock_allowlisted, raising=False)
    ok = await client.post("/v1/admin/auth/session", json={"id_token": "valid-oidc-jwt"})
    assert ok.status_code == 200
    token = ok.json()["access"]
    assert ok.json()["email"] == "lead@saath.in"

    flags = await client.get("/v1/admin/flags", headers={"Authorization": f"Bearer {token}"})
    assert flags.status_code == 200


async def test_verify_google_oidc_token_cryptographic_verification(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public_jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(private_key.public_key()))
    public_jwk["kid"] = "google-test-kid-1"

    client_id = "12345.apps.googleusercontent.com"
    now = datetime.now(UTC)
    valid_id_token = jwt.encode(
        {
            "sub": "google-uid-1",
            "aud": client_id,
            "iss": "https://accounts.google.com",
            "iat": int(now.timestamp()),
            "exp": int((now + timedelta(minutes=10)).timestamp()),
            "email": "OpsLead@Saath.in",
            "email_verified": True,
        },
        private_key,
        algorithm="RS256",
        headers={"kid": "google-test-kid-1"},
    )

    class _FakeResp:
        def __init__(self, status_code: int, payload: dict[str, Any]) -> None:
            self.status_code = status_code
            self._payload = payload

        def raise_for_status(self) -> None:
            if self.status_code >= 400:
                raise RuntimeError("HTTP error")

        def json(self) -> dict[str, Any]:
            return self._payload

    class _FakeAsyncClient:
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            _ = (args, kwargs)

        async def __aenter__(self) -> _FakeAsyncClient:
            return self

        async def __aexit__(self, *args: Any) -> None:
            return None

        async def get(self, _url: str) -> _FakeResp:
            return _FakeResp(200, {"keys": [public_jwk]})

        async def post(self, _url: str, data: dict[str, str]) -> _FakeResp:
            _ = data
            return _FakeResp(200, {"id_token": valid_id_token})

    monkeypatch.setattr("saath_api.admin.service.httpx.AsyncClient", _FakeAsyncClient)
    settings = Settings(
        env="test",
        admin_sso_client_id=client_id,
        admin_sso_client_secret="secret-1",
    )

    email = await verify_google_oidc_token(settings, id_token=valid_id_token)
    assert email == "opslead@saath.in"

    email_from_code = await verify_google_oidc_token(settings, code="auth-code-123")
    assert email_from_code == "opslead@saath.in"

    # Unverified email claim fails closed
    unverified_token = jwt.encode(
        {
            "sub": "google-uid-1",
            "aud": client_id,
            "iss": "https://accounts.google.com",
            "iat": int(now.timestamp()),
            "exp": int((now + timedelta(minutes=10)).timestamp()),
            "email": "opslead@saath.in",
            "email_verified": False,
        },
        private_key,
        algorithm="RS256",
        headers={"kid": "google-test-kid-1"},
    )
    with pytest.raises(Exception) as exc:
        await verify_google_oidc_token(settings, id_token=unverified_token)
    assert getattr(exc.value, "code", None) == "oidc_email_unverified"


def test_settings_admin_ttl_and_actor_backward_compat(tmp_path: Any) -> None:
    with pytest.raises(ValidationError):
        Settings(env="test", admin_jwt_ttl_seconds=0)

    five_arg_actor = Actor(
        kind="user",
        user_id=uuid.uuid4(),
        anon_id=None,
        device_id=uuid.uuid4(),
        scopes=frozenset({"user"}),
    )
    assert five_arg_actor.admin_email is None

    out_file = tmp_path / "openapi.json"
    export_openapi_schema(out_file)
    schema = json.loads(out_file.read_text(encoding="utf-8"))
    for path in (
        "/v1/admin/auth/session",
        "/v1/admin/analytics/funnel",
        "/v1/admin/providers/health",
        "/v1/admin/moderation/queue",
        "/v1/admin/moderation/{report_id}/action",
        "/v1/admin/fraud/graph",
        "/v1/admin/flags",
        "/v1/admin/flags/{key}",
        "/v1/admin/disputes",
        "/v1/admin/disputes/{dispute_id}/override",
        "/v1/admin/redemptions",
        "/v1/admin/redemptions/{redemption_id}/review",
        "/v1/admin/audit-log",
    ):
        assert path in schema["paths"]
        ops = schema["paths"][path]
        for method_spec in ops.values():
            if "401" in method_spec["responses"]:
                assert "application/problem+json" in method_spec["responses"]["401"]["content"]


async def test_admin_funnel_and_providers_health(
    client: AsyncClient,
    fake_messaging: FakeMessagingProvider,
) -> None:
    tok_a, _, uid_a = await _otp_login(client, fake_messaging, "9876548010")
    tok_b, _, uid_b = await _otp_login(client, fake_messaging, "9876548011")
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
        json={
            "goal_type": "lower",
            "movers": [va["seat_holders"][0]["id"]],
            "constraints": {},
        },
    )
    matches = (
        await client.get(f"/v1/parties/{va['party']['id']}/matches?kind=pair", headers=h_a)
    ).json()["items"]
    swap = (
        await client.post("/v1/swaps", headers=h_a, json={"card_id": matches[0]["card_id"]})
    ).json()
    a1 = (
        await client.post(
            f"/v1/swaps/{swap['id']}/accept",
            headers=h_a,
            json={"version": swap["version"]},
        )
    ).json()
    await client.post(
        f"/v1/swaps/{swap['id']}/accept",
        headers=h_b,
        json={"version": a1["version"]},
    )

    app_ref: Any = client.app  # type: ignore[attr-defined]
    await app_ref.state.redis.set("cb:rail:fake_rail:open", "1", ex=25)
    await app_ref.state.redis.set("cb:rail:fake_rail:failures", "5", ex=60)

    async with app_ref.state.session_factory() as db:
        ji = (
            await db.execute(
                select(JourneyInstance).where(JourneyInstance.id == UUID(va["journey"]["id"]))
            )
        ).scalar_one()
        service_no = ji.service_no
        service_date = ji.service_date

        # Seed a second route on a different date + outbox states
        ji2 = JourneyInstance(
            id=uuid7(),
            mode="train",
            carrier_code="IR",
            service_no="12301",
            service_date=service_date + timedelta(days=5),
            chart_state="pending",
        )
        db.add(ji2)
        db.add(
            Booking(
                id=uuid7(),
                journey_instance_id=ji2.id,
                owner_user_id=UUID(uid_a),
                pnr_hash=b"hash-12301",
                from_code="HWH",
                to_code="NDLS",
                trust_tier="verified_provider",
                purge_after=datetime.now(UTC) + timedelta(days=3),
            )
        )
        db.add_all(
            [
                NotificationsOutbox(
                    user_id=UUID(uid_a),
                    event="TestQueued",
                    payload={},
                    idempotency_key="adm-test-q",
                    status="queued",
                    created_at=datetime.now(UTC) - timedelta(seconds=42),
                ),
                NotificationsOutbox(
                    user_id=UUID(uid_b),
                    event="TestSent",
                    payload={},
                    idempotency_key="adm-test-s",
                    status="sent",
                    sent_at=datetime.now(UTC),
                ),
                NotificationsOutbox(
                    user_id=UUID(uid_b),
                    event="TestDLQ",
                    payload={},
                    idempotency_key="adm-test-d",
                    status="dead_letter",
                ),
            ]
        )
        await db.commit()

    admin_headers = await _get_admin_headers(client)

    funnel_all = await client.get("/v1/admin/analytics/funnel", headers=admin_headers)
    assert funnel_all.status_code == 200
    f_body = funnel_all.json()
    assert f_body["verified"] >= 3
    assert f_body["goal_set"] >= 2
    assert f_body["matched"] >= 1
    assert f_body["swap_created"] >= 1
    assert f_body["swap_confirmed"] >= 1
    assert f_body["match_rate"] > 0
    assert f_body["notification_delivery"]["queued"] >= 1
    assert f_body["notification_delivery"]["sent"] >= 1
    assert f_body["notification_delivery"]["dead_letter"] >= 1
    assert len(f_body["routes"]) >= 2

    funnel_filtered = await client.get(
        f"/v1/admin/analytics/funnel?route={service_no}&from_date={service_date.isoformat()}&to_date={service_date.isoformat()}",
        headers=admin_headers,
    )
    assert funnel_filtered.status_code == 200
    filtered = funnel_filtered.json()
    assert len(filtered["routes"]) == 1
    assert filtered["routes"][0]["service_no"] == service_no

    health = await client.get("/v1/admin/providers/health", headers=admin_headers)
    assert health.status_code == 200
    h_body = health.json()
    rail_items = [p for p in h_body["providers"] if p["category"] == "rail"]
    assert rail_items
    assert any(
        p["circuit_state"] == "open" and p["failures"] == 5 and p["open_ttl_seconds"] > 0
        for p in rail_items
    )
    categories = {p["category"] for p in h_body["providers"]}
    assert {"rail", "flight", "messaging", "push", "llm", "turnstile", "payment"}.issubset(
        categories
    )
    assert h_body["outbox"]["queued"] >= 1
    assert h_body["outbox"]["sent"] >= 1
    assert h_body["outbox"]["dead_letter"] >= 1
    assert h_body["outbox"]["lag_seconds"] >= 30.0


async def test_moderation_queue_actions_audit_and_ban_enforcement(
    client: AsyncClient,
    fake_messaging: FakeMessagingProvider,
) -> None:
    tok_rep, _, _ = await _otp_login(client, fake_messaging, "9876548020")
    tok_off, ref_off, uid_off = await _otp_login(client, fake_messaging, "9876548021")
    h_rep = {"Authorization": f"Bearer {tok_rep}"}
    h_off = {"Authorization": f"Bearer {tok_off}"}

    v_rep = (
        await client.post(
            "/v1/journeys/verify",
            headers=h_rep,
            json={"mode": "train", "pnr": "4111111111"},
        )
    ).json()
    v_off = (
        await client.post(
            "/v1/journeys/verify",
            headers=h_off,
            json={"mode": "train", "pnr": "4222222222"},
        )
    ).json()
    await client.put(
        f"/v1/parties/{v_off['party']['id']}/goal",
        headers=h_off,
        json={
            "goal_type": "open_to_help",
            "movers": [v_off["seat_holders"][0]["id"]],
            "constraints": {},
        },
    )
    await client.put(
        f"/v1/parties/{v_rep['party']['id']}/goal",
        headers=h_rep,
        json={"goal_type": "lower", "movers": [v_rep["seat_holders"][0]["id"]], "constraints": {}},
    )
    matches = (
        await client.get(f"/v1/parties/{v_rep['party']['id']}/matches?kind=pair", headers=h_rep)
    ).json()["items"]
    card_id = matches[0]["card_id"]

    # Create a pending swap so ban invalidates it and releases seat lock
    swap = (await client.post("/v1/swaps", headers=h_rep, json={"card_id": card_id})).json()

    convo = (
        await client.post("/v1/conversations", headers=h_rep, json={"card_id": card_id})
    ).json()
    convo_id = convo["id"]
    m1 = (
        await client.post(
            f"/v1/conversations/{convo_id}/messages",
            headers=h_off,
            json={"body": "Harassing message 1", "client_id": "m-off-1"},
        )
    ).json()
    m2 = (
        await client.post(
            f"/v1/conversations/{convo_id}/messages",
            headers=h_off,
            json={"body": "Harassing message 2", "client_id": "m-off-2"},
        )
    ).json()

    rep1 = (
        await client.post(
            "/v1/reports",
            headers=h_rep,
            json={"conversation_id": convo_id, "message_id": m1["id"], "reason": "abuse"},
        )
    ).json()
    rep2 = (
        await client.post(
            "/v1/reports",
            headers=h_rep,
            json={"conversation_id": convo_id, "message_id": m2["id"], "reason": "spam"},
        )
    ).json()

    admin_headers = await _get_admin_headers(client)

    # Audit log must increment immediately upon viewing moderation queue
    before_audit = (await client.get("/v1/admin/audit-log", headers=admin_headers)).json()["total"]
    queue = await client.get("/v1/admin/moderation/queue", headers=admin_headers)
    assert queue.status_code == 200
    assert queue.json()["total"] >= 2
    after_audit = (await client.get("/v1/admin/audit-log", headers=admin_headers)).json()["total"]
    assert after_audit > before_audit

    # Validation & 404 checks
    bad_action = await client.post(
        f"/v1/admin/moderation/{rep1['report_id']}/action",
        headers=admin_headers,
        json={"action": "invalid_action_xyz"},
    )
    _assert_problem_json(bad_action, 422)

    missing_rep = await client.post(
        f"/v1/admin/moderation/{uuid.uuid4()}/action",
        headers=admin_headers,
        json={"action": "dismiss"},
    )
    _assert_problem_json(missing_rep, 404)

    # 1. Hide message
    hide_res = await client.post(
        f"/v1/admin/moderation/{rep1['report_id']}/action",
        headers=admin_headers,
        json={"action": "hide", "note": "Verified abuse"},
    )
    assert hide_res.status_code == 200
    assert hide_res.json()["message_moderation"] == "hidden"
    msgs_for_rep = (
        await client.get(f"/v1/conversations/{convo_id}/messages", headers=h_rep)
    ).json()["items"]
    assert all(item["id"] != m1["id"] for item in msgs_for_rep)

    # 2. Dismiss second report
    dismiss_res = await client.post(
        f"/v1/admin/moderation/{rep2['report_id']}/action",
        headers=admin_headers,
        json={"action": "dismiss"},
    )
    assert dismiss_res.status_code == 200
    assert dismiss_res.json()["report_status"] == "dismissed"

    # 3. Restrict offender -> chat send returns 403
    restrict_res = await client.post(
        f"/v1/admin/moderation/{rep1['report_id']}/action",
        headers=admin_headers,
        json={"action": "restrict"},
    )
    assert restrict_res.status_code == 200
    assert restrict_res.json()["target_user_status"] == "restricted"

    blocked_send = await client.post(
        f"/v1/conversations/{convo_id}/messages",
        headers=h_off,
        json={"body": "Still trying", "client_id": "m-off-3"},
    )
    _assert_problem_json(blocked_send, 403)

    # 4. Ban offender -> revokes refresh tokens, invalidates pending swap, /v1/me returns 403
    ban_res = await client.post(
        f"/v1/admin/moderation/{rep1['report_id']}/action",
        headers=admin_headers,
        json={"action": "ban", "note": "Repeat offender"},
    )
    assert ban_res.status_code == 200
    assert ban_res.json()["target_user_status"] == "banned"
    assert ban_res.json()["revoked_tokens"] >= 1
    assert ban_res.json()["invalidated_swaps"] >= 1

    me_after_ban = await client.get("/v1/me", headers=h_off)
    _assert_problem_json(me_after_ban, 403)

    refresh_after_ban = await client.post("/v1/auth/refresh", json={"refresh": ref_off})
    _assert_problem_json(refresh_after_ban, 401)

    app_ref: Any = client.app  # type: ignore[attr-defined]
    async with app_ref.state.session_factory() as db:
        sp = (
            await db.execute(select(SwapProposal).where(SwapProposal.id == UUID(swap["id"])))
        ).scalar_one()
        assert sp.status == "invalidated"
        locks = (
            (await db.execute(select(SeatLock).where(SeatLock.proposal_id == sp.id)))
            .scalars()
            .all()
        )
        assert locks == []
        revoked_rows = (
            (await db.execute(select(RefreshToken).where(RefreshToken.user_id == UUID(uid_off))))
            .scalars()
            .all()
        )
        assert all(rt.revoked_at is not None for rt in revoked_rows)


async def test_fraud_graph_hashes_devices_and_writes_audit_log(
    client: AsyncClient,
    fake_messaging: FakeMessagingProvider,
) -> None:
    _, _, uid_1 = await _otp_login(client, fake_messaging, "9876548030")
    _, _, uid_2 = await _otp_login(client, fake_messaging, "9876548031")
    u1, u2 = UUID(uid_1), UUID(uid_2)

    raw_endpoint = "https://fcm.googleapis.com/fcm/send/secret-device-token-123"
    raw_p256dh = "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u"
    expected_ep_hash = hashlib.sha256(raw_endpoint.encode("utf-8")).hexdigest()[:16]

    app_ref: Any = client.app  # type: ignore[attr-defined]
    async with app_ref.state.session_factory() as db:
        db.add_all(
            [
                Device(
                    id=uuid7(),
                    user_id=u1,
                    push_endpoint=raw_endpoint,
                    push_p256dh=raw_p256dh,
                ),
                Device(
                    id=uuid7(),
                    user_id=u2,
                    push_endpoint=raw_endpoint,
                    push_p256dh=raw_p256dh,
                ),
            ]
        )
        ji = JourneyInstance(
            id=uuid7(),
            mode="train",
            carrier_code="IR",
            service_no="12951",
            service_date=date.today() + timedelta(days=2),
            chart_state="final",
        )
        db.add(ji)
        b1 = Booking(
            id=uuid7(),
            journey_instance_id=ji.id,
            owner_user_id=u1,
            pnr_hash=b"pnr-f1",
            trust_tier="verified_provider",
            purge_after=datetime.now(UTC) + timedelta(days=3),
        )
        b2 = Booking(
            id=uuid7(),
            journey_instance_id=ji.id,
            owner_user_id=u2,
            pnr_hash=b"pnr-f2",
            trust_tier="verified_provider",
            purge_after=datetime.now(UTC) + timedelta(days=3),
        )
        db.add_all([b1, b2])
        sh1 = SeatHolder(id=uuid7(), booking_id=b1.id, pax_seq=1, coach="B1", seat_no="10")
        sh2 = SeatHolder(id=uuid7(), booking_id=b2.id, pax_seq=1, coach="B1", seat_no="12")
        db.add_all([sh1, sh2])

        for idx in range(2):
            sp = SwapProposal(
                id=uuid7(),
                journey_instance_id=ji.id,
                initiator_user_id=u1,
                kind="pair",
                status="completed" if idx == 0 else "not_completed",
                expires_at=datetime.now(UTC) + timedelta(hours=1),
            )
            db.add(sp)
            db.add_all(
                [
                    SwapParticipant(
                        proposal_id=sp.id,
                        seat_holder_id=sh1.id,
                        user_id=u1,
                        alias="A",
                        gives_seat="B1-10",
                        gets_seat="B1-12",
                        decision="accepted",
                    ),
                    SwapParticipant(
                        proposal_id=sp.id,
                        seat_holder_id=sh2.id,
                        user_id=u2,
                        alias="B",
                        gives_seat="B1-12",
                        gets_seat="B1-10",
                        decision="accepted",
                    ),
                ]
            )
            db.add(
                KarmaLedger(
                    user_id=u1,
                    proposal_id=sp.id,
                    delta=100,
                    state="credited",
                    reason="swap_completed",
                )
            )
            if idx == 1:
                db.add(
                    KarmaLedger(
                        user_id=u1,
                        proposal_id=sp.id,
                        delta=-100,
                        state="reversed",
                        reason="dispute:no",
                    )
                )

        db.add(
            AuditLog(
                actor="system:karma",
                action="karma.collusion_blocked",
                resource=f"swap:{uuid7()}",
                meta={"user_id": str(u1), "reason": "shared_device_push_key"},
            )
        )
        await db.commit()

    admin_headers = await _get_admin_headers(client)
    before = (await client.get("/v1/admin/audit-log", headers=admin_headers)).json()["total"]
    graph_resp = await client.get("/v1/admin/fraud/graph", headers=admin_headers)
    assert graph_resp.status_code == 200
    raw_text = graph_resp.text
    assert raw_endpoint not in raw_text
    assert raw_p256dh not in raw_text

    g = graph_resp.json()
    assert any(sd["fingerprint_hash"] == expected_ep_hash for sd in g["shared_devices"])
    assert len(g["flagged_pairs"]) >= 1
    assert set(g["flagged_pairs"][0]["reasons"]) >= {
        "shared_device_push_key",
        "repeat_swap_pair",
        "karma_reversed",
    }
    assert any(a["action"] == "karma.collusion_blocked" for a in g["anomalies"])

    after = (await client.get("/v1/admin/audit-log", headers=admin_headers)).json()["total"]
    assert after > before


async def test_flags_disputes_redemptions_and_audit_filters(
    client: AsyncClient,
    fake_messaging: FakeMessagingProvider,
) -> None:
    admin_headers = await _get_admin_headers(client)

    # 1. Feature flags (preserve seeded state!)
    flags_resp = await client.get("/v1/admin/flags", headers=admin_headers)
    assert flags_resp.status_code == 200
    flags = {f["key"]: f for f in flags_resp.json()["items"]}
    assert {
        "rewards_catalogue_enabled",
        "ai_concierge_enabled",
        "maintenance_banner",
        "sms_parser_llm_fallback",
    }.issubset(flags.keys())
    orig_val = flags["rewards_catalogue_enabled"]["value"]

    missing_flag = await client.patch(
        "/v1/admin/flags/nonexistent_flag",
        headers=admin_headers,
        json={"value": True},
    )
    _assert_problem_json(missing_flag, 404)

    try:
        patched = await client.patch(
            "/v1/admin/flags/rewards_catalogue_enabled",
            headers=admin_headers,
            json={"value": True, "description": "Enable rewards for admin test"},
        )
        assert patched.status_code == 200
        assert patched.json()["value"] is True
        assert patched.json()["updated_by"] == "admin:ops@saath.test"
    finally:
        await client.patch(
            "/v1/admin/flags/rewards_catalogue_enabled",
            headers=admin_headers,
            json={"value": orig_val},
        )

    # 2. Disputes (swap dispute + claim conflict) & Redemptions
    _, _, uid_1 = await _otp_login(client, fake_messaging, "9876548040")
    _, _, uid_2 = await _otp_login(client, fake_messaging, "9876548041")
    u1, u2 = UUID(uid_1), UUID(uid_2)

    app_ref: Any = client.app  # type: ignore[attr-defined]
    async with app_ref.state.session_factory() as db:
        ji = JourneyInstance(
            id=uuid7(),
            mode="train",
            carrier_code="IR",
            service_no="12952",
            service_date=date.today() + timedelta(days=3),
            chart_state="final",
        )
        db.add(ji)
        b1 = Booking(
            id=uuid7(),
            journey_instance_id=ji.id,
            owner_user_id=u1,
            pnr_hash=b"pnr-d1",
            trust_tier="verified_provider",
            claim_conflict_flagged=True,
            purge_after=datetime.now(UTC) + timedelta(days=3),
        )
        b2 = Booking(
            id=uuid7(),
            journey_instance_id=ji.id,
            owner_user_id=u2,
            pnr_hash=b"pnr-d2",
            trust_tier="verified_provider",
            purge_after=datetime.now(UTC) + timedelta(days=3),
        )
        db.add_all([b1, b2])
        sh1 = SeatHolder(
            id=uuid7(), booking_id=b1.id, pax_seq=1, coach="B2", seat_no="1", seat_type="LB"
        )
        sh2 = SeatHolder(
            id=uuid7(), booking_id=b2.id, pax_seq=1, coach="B2", seat_no="2", seat_type="MB"
        )
        db.add_all([sh1, sh2])

        sp = SwapProposal(
            id=uuid7(),
            journey_instance_id=ji.id,
            initiator_user_id=u1,
            kind="pair",
            status="not_completed",
            expires_at=datetime.now(UTC) + timedelta(hours=1),
        )
        db.add(sp)
        db.add_all(
            [
                SwapParticipant(
                    proposal_id=sp.id,
                    seat_holder_id=sh1.id,
                    user_id=u1,
                    alias="A",
                    gives_seat="B2-1",
                    gets_seat="B2-2",
                    decision="accepted",
                    post_confirm="yes",
                ),
                SwapParticipant(
                    proposal_id=sp.id,
                    seat_holder_id=sh2.id,
                    user_id=u2,
                    alias="B",
                    gives_seat="B2-2",
                    gets_seat="B2-1",
                    decision="accepted",
                    post_confirm="no",
                ),
            ]
        )
        db.add_all(
            [
                KarmaLedger(
                    user_id=u1,
                    proposal_id=sp.id,
                    delta=100,
                    state="credited",
                    reason="swap_completed",
                ),
                KarmaLedger(
                    user_id=u1,
                    proposal_id=sp.id,
                    delta=-100,
                    state="reversed",
                    reason="dispute:no",
                ),
            ]
        )

        reward = RewardItem(
            id=uuid7(),
            code="CHAI_100",
            title_en="Station Chai",
            title_hi="चाय",
            cost_points=50,
            stock=2,
            active=True,
        )
        db.add(reward)
        red_ok = RewardRedemption(
            id=uuid7(),
            user_id=u1,
            reward_item_id=reward.id,
            points_spent=50,
            status="pending",
        )
        red_reject = RewardRedemption(
            id=uuid7(),
            user_id=u2,
            reward_item_id=reward.id,
            points_spent=50,
            status="pending",
        )
        db.add_all([red_ok, red_reject])
        await db.commit()

    disputes = await client.get("/v1/admin/disputes?status=open", headers=admin_headers)
    assert disputes.status_code == 200
    d_ids = {d["dispute_id"] for d in disputes.json()["items"]}
    assert str(sp.id) in d_ids
    assert str(b1.id) in d_ids

    # Override swap dispute -> complete
    ov_swap = await client.post(
        f"/v1/admin/disputes/{sp.id}/override",
        headers=admin_headers,
        json={"action": "complete", "note": "Verified with conductor"},
    )
    assert ov_swap.status_code == 200
    assert ov_swap.json()["status"] == "completed"
    assert str(u2) in ov_swap.json()["karma_credited_users"]

    # Override booking claim conflict -> clear_conflict
    ov_booking = await client.post(
        f"/v1/admin/disputes/{b1.id}/override",
        headers=admin_headers,
        json={"action": "clear_conflict", "note": "Legitimate boarding pass"},
    )
    assert ov_booking.status_code == 200
    assert ov_booking.json()["dispute_type"] == "claim_conflict"

    _assert_problem_json(
        await client.post(
            f"/v1/admin/disputes/{uuid.uuid4()}/override",
            headers=admin_headers,
            json={"action": "dismiss"},
        ),
        404,
    )

    # Redemptions review: approve -> double-approve 409 -> fulfill; reject restores stock and
    # blocks repeat review (409)
    reds = await client.get("/v1/admin/redemptions", headers=admin_headers)
    assert reds.status_code == 200
    assert reds.json()["total"] == 2

    app_r = await client.post(
        f"/v1/admin/redemptions/{red_ok.id}/review",
        headers=admin_headers,
        json={"action": "approve"},
    )
    assert app_r.status_code == 200
    assert app_r.json()["status"] == "approved"

    double_app_r = await client.post(
        f"/v1/admin/redemptions/{red_ok.id}/review",
        headers=admin_headers,
        json={"action": "approve"},
    )
    assert _assert_problem_json(double_app_r, 409)["code"] == "invalid_redemption_state"

    ful_r = await client.post(
        f"/v1/admin/redemptions/{red_ok.id}/review",
        headers=admin_headers,
        json={"action": "fulfill"},
    )
    assert ful_r.status_code == 200
    assert ful_r.json()["status"] == "fulfilled"

    rej_r = await client.post(
        f"/v1/admin/redemptions/{red_reject.id}/review",
        headers=admin_headers,
        json={"action": "reject", "note": "Duplicate request"},
    )
    assert rej_r.status_code == 200
    assert rej_r.json()["status"] == "rejected"

    repeat_r = await client.post(
        f"/v1/admin/redemptions/{red_reject.id}/review",
        headers=admin_headers,
        json={"action": "approve"},
    )
    _assert_problem_json(repeat_r, 409)

    async with app_ref.state.session_factory() as db:
        refreshed_item = (
            await db.execute(select(RewardItem).where(RewardItem.id == reward.id))
        ).scalar_one()
        assert refreshed_item.stock == 3

    # 3. Audit log filtering & pagination
    audit_page = await client.get(
        "/v1/admin/audit-log?action=admin.dispute_override&limit=1&offset=0",
        headers=admin_headers,
    )
    assert audit_page.status_code == 200
    ap = audit_page.json()
    assert ap["total"] >= 2
    assert len(ap["items"]) == 1
    assert ap["limit"] == 1
    assert ap["offset"] == 0
    assert ap["items"][0]["action"] == "admin.dispute_override"


async def test_admin_auth_staging_prod_allowlist_jwt_and_oidc_errors(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    app_ref: Any = client.app  # type: ignore[attr-defined]
    orig_settings: Settings = app_ref.state.settings

    # Empty body -> 422 missing_admin_credentials
    empty_sess = await client.post("/v1/admin/auth/session", json={})
    assert _assert_problem_json(empty_sess, 422)["code"] == "missing_admin_credentials"

    # Extra field -> 422 validation_error
    extra_sess = await client.post(
        "/v1/admin/auth/session",
        json={"email": "ops@saath.test", "unexpected": True},
    )
    assert _assert_problem_json(extra_sess, 422)["code"] == "validation_error"

    # Expired and malformed admin JWT -> 401
    past = int((datetime.now(UTC) - timedelta(minutes=10)).timestamp())
    expired_jwt = jwt.encode(
        {
            "sub": "admin:ops@saath.test",
            "email": "ops@saath.test",
            "kind": "admin",
            "scopes": ["admin"],
            "iat": past - 60,
            "exp": past,
        },
        orig_settings.jwt_private_key,
        algorithm="EdDSA",
    )
    exp_resp = await client.get(
        "/v1/admin/flags",
        headers={"Authorization": f"Bearer {expired_jwt}"},
    )
    assert _assert_problem_json(exp_resp, 401)["code"] == "token_expired"

    malformed_resp = await client.get(
        "/v1/admin/flags",
        headers={"Authorization": "Bearer invalid.jwt.token"},
    )
    assert _assert_problem_json(malformed_resp, 401)["code"] == "invalid_token"

    # Valid admin JWT in test mode, then switched to prod/staging with empty/changed allowlist
    valid_token, _ = create_admin_token(orig_settings, email="lead@saath.in")
    valid_headers = {"Authorization": f"Bearer {valid_token}"}

    prod_empty_allow = orig_settings.model_copy(
        update={
            "env": "production",
            "admin_sso_client_id": "test-google-client.apps.googleusercontent.com",
            "admin_sso_allowed_emails": "",
        }
    )
    monkeypatch.setattr(app_ref.state, "settings", prod_empty_allow)
    prod_empty_resp = await client.get("/v1/admin/flags", headers=valid_headers)
    assert _assert_problem_json(prod_empty_resp, 403)["code"] == "admin_not_allowlisted"

    staging_empty_allow = orig_settings.model_copy(
        update={
            "env": "staging",
            "admin_sso_allowed_emails": "",
        }
    )
    monkeypatch.setattr(app_ref.state, "settings", staging_empty_allow)
    stg_empty_resp = await client.get("/v1/admin/flags", headers=valid_headers)
    assert _assert_problem_json(stg_empty_resp, 403)["code"] == "admin_not_allowlisted"
    # Staging session creation with empty allowlist also fails closed
    assert (
        _assert_problem_json(
            await client.post("/v1/admin/auth/session", json={"email": "ops@saath.test"}), 403
        )["code"]
        == "admin_not_allowlisted"
    )

    # Removed from allowlist in production -> 403
    prod_other_allow = orig_settings.model_copy(
        update={
            "env": "production",
            "admin_sso_client_id": "test-google-client.apps.googleusercontent.com",
            "admin_sso_allowed_emails": "other@saath.in",
        }
    )
    monkeypatch.setattr(app_ref.state, "settings", prod_other_allow)
    prod_other_resp = await client.get("/v1/admin/flags", headers=valid_headers)
    assert _assert_problem_json(prod_other_resp, 403)["code"] == "admin_not_allowlisted"

    # Missing admin_sso_client_id in production -> 403 admin_sso_not_configured
    prod_no_client = orig_settings.model_copy(
        update={
            "env": "production",
            "admin_sso_client_id": "",
            "admin_sso_allowed_emails": "lead@saath.in",
        }
    )
    monkeypatch.setattr(app_ref.state, "settings", prod_no_client)
    assert (
        _assert_problem_json(
            await client.post("/v1/admin/auth/session", json={"id_token": "oidc-jwt"}), 403
        )["code"]
        == "admin_sso_not_configured"
    )

    # Email mismatch in both production and non-production OIDC flows -> 403 admin_email_mismatch
    async def _mock_lead(
        _settings: Settings,
        *,
        id_token: str | None = None,
        code: str | None = None,
        redirect_uri: str | None = None,
    ) -> str:
        _ = (id_token, code, redirect_uri)
        return "lead@saath.in"

    monkeypatch.setattr(app_ref.state, "admin_oidc_verifier", _mock_lead, raising=False)
    prod_ok = orig_settings.model_copy(
        update={
            "env": "production",
            "admin_sso_client_id": "cid-1",
            "admin_sso_allowed_emails": "lead@saath.in,ops@saath.in",
        }
    )
    monkeypatch.setattr(app_ref.state, "settings", prod_ok)
    mismatch_prod = await client.post(
        "/v1/admin/auth/session",
        json={"id_token": "valid-jwt", "email": "ops@saath.in"},
    )
    assert _assert_problem_json(mismatch_prod, 403)["code"] == "admin_email_mismatch"

    nonprod_ok = orig_settings.model_copy(
        update={
            "env": "test",
            "admin_sso_client_id": "cid-1",
            "admin_sso_allowed_emails": "lead@saath.in,ops@saath.in",
        }
    )
    monkeypatch.setattr(app_ref.state, "settings", nonprod_ok)
    mismatch_nonprod = await client.post(
        "/v1/admin/auth/session",
        json={"id_token": "valid-jwt", "email": "ops@saath.in"},
    )
    assert _assert_problem_json(mismatch_nonprod, 403)["code"] == "admin_email_mismatch"

    ok_nonprod = await client.post(
        "/v1/admin/auth/session",
        json={"id_token": "valid-jwt", "email": "lead@saath.in"},
    )
    assert ok_nonprod.status_code == 200
    assert ok_nonprod.json()["email"] == "lead@saath.in"


async def test_verify_google_oidc_token_error_branches(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    other_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public_jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(private_key.public_key()))
    public_jwk["kid"] = "kid-1"
    client_id = "cid-errors.apps.googleusercontent.com"
    now = datetime.now(UTC)

    def _make_tok(
        *,
        key: Any = private_key,
        aud: str = client_id,
        iss: str = "https://accounts.google.com",
        exp_delta: timedelta = timedelta(minutes=5),
        headers: dict[str, Any] | None = None,
    ) -> str:
        return jwt.encode(
            {
                "sub": "g-1",
                "aud": aud,
                "iss": iss,
                "iat": int((now - timedelta(minutes=10)).timestamp()),
                "exp": int((now + exp_delta).timestamp()),
                "email": "ops@saath.in",
                "email_verified": True,
            },
            key,
            algorithm="RS256",
            headers=headers,
        )

    # 1. Missing client_id / client_secret -> 403 admin_sso_not_configured
    with pytest.raises(ProblemDetailError) as exc_no_cid:
        await verify_google_oidc_token(Settings(env="test", admin_sso_client_id=""), id_token="abc")
    assert exc_no_cid.value.code == "admin_sso_not_configured"

    with pytest.raises(ProblemDetailError) as exc_no_secret:
        await verify_google_oidc_token(
            Settings(env="test", admin_sso_client_id=client_id, admin_sso_client_secret=""),
            code="auth-code",
        )
    assert exc_no_secret.value.code == "admin_sso_not_configured"

    # 2. Missing kid header in ID token -> 401 invalid_oidc_token
    no_kid_token = _make_tok(headers=None)
    with pytest.raises(ProblemDetailError) as exc_no_kid:
        await verify_google_oidc_token(
            Settings(env="test", admin_sso_client_id=client_id),
            id_token=no_kid_token,
        )
    assert exc_no_kid.value.code == "invalid_oidc_token"

    # 3. Code exchange errors: HTTP error, status >= 400, invalid JSON
    class _StubResp:
        def __init__(self, status_code: int, payload: Any = None, json_err: bool = False) -> None:
            self.status_code = status_code
            self._payload = payload
            self._json_err = json_err

        def raise_for_status(self) -> None:
            if self.status_code >= 400:
                raise httpx.HTTPStatusError(
                    "err",
                    request=httpx.Request("POST", "https://example.com"),
                    response=httpx.Response(self.status_code),
                )

        def json(self) -> Any:
            if self._json_err:
                raise ValueError("bad json")
            return self._payload

    settings = Settings(env="test", admin_sso_client_id=client_id, admin_sso_client_secret="sec")

    class _CodeHttpErrClient:
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            _ = (args, kwargs)

        async def __aenter__(self) -> _CodeHttpErrClient:
            return self

        async def __aexit__(self, *args: Any) -> None:
            return None

        async def post(self, _url: str, data: dict[str, str]) -> _StubResp:
            _ = data
            raise httpx.ConnectError("network down")

    monkeypatch.setattr("saath_api.admin.service.httpx.AsyncClient", _CodeHttpErrClient)
    with pytest.raises(ProblemDetailError) as exc_conn:
        await verify_google_oidc_token(settings, code="c1")
    assert exc_conn.value.code == "invalid_oidc_code"

    class _CodeBadStatusClient(_CodeHttpErrClient):
        async def post(self, _url: str, data: dict[str, str]) -> _StubResp:
            _ = data
            return _StubResp(400, {"error": "invalid_grant"})

    monkeypatch.setattr("saath_api.admin.service.httpx.AsyncClient", _CodeBadStatusClient)
    with pytest.raises(ProblemDetailError) as exc_400:
        await verify_google_oidc_token(settings, code="c1")
    assert exc_400.value.code == "invalid_oidc_code"

    class _CodeBadJsonClient(_CodeHttpErrClient):
        async def post(self, _url: str, data: dict[str, str]) -> _StubResp:
            _ = data
            return _StubResp(200, json_err=True)

    monkeypatch.setattr("saath_api.admin.service.httpx.AsyncClient", _CodeBadJsonClient)
    with pytest.raises(ProblemDetailError) as exc_bad_json:
        await verify_google_oidc_token(settings, code="c1")
    assert exc_bad_json.value.code == "invalid_oidc_code"

    # 4. JWKS unavailable -> 503 oidc_jwks_unavailable
    class _JwksDownClient(_CodeHttpErrClient):
        async def get(self, _url: str) -> _StubResp:
            raise httpx.ConnectError("jwks unreachable")

    monkeypatch.setattr("saath_api.admin.service.httpx.AsyncClient", _JwksDownClient)
    valid_hdr_tok = _make_tok(headers={"kid": "kid-1"})
    with pytest.raises(ProblemDetailError) as exc_jwks:
        await verify_google_oidc_token(settings, id_token=valid_hdr_tok)
    assert exc_jwks.value.status_code == 503
    assert exc_jwks.value.code == "oidc_jwks_unavailable"

    # 5. Expired token, unknown kid, wrong signature, wrong audience, wrong issuer -> 401
    class _JwksOkClient(_CodeHttpErrClient):
        async def get(self, _url: str) -> _StubResp:
            return _StubResp(200, {"keys": [public_jwk]})

    monkeypatch.setattr("saath_api.admin.service.httpx.AsyncClient", _JwksOkClient)

    expired_tok = _make_tok(exp_delta=timedelta(minutes=-5), headers={"kid": "kid-1"})
    with pytest.raises(ProblemDetailError) as exc_exp:
        await verify_google_oidc_token(settings, id_token=expired_tok)
    assert exc_exp.value.code == "oidc_token_expired"

    for bad_tok in (
        _make_tok(headers={"kid": "unknown-kid"}),
        _make_tok(key=other_key, headers={"kid": "kid-1"}),
        _make_tok(aud="wrong-client-id", headers={"kid": "kid-1"}),
        _make_tok(iss="https://evil.example.com", headers={"kid": "kid-1"}),
    ):
        with pytest.raises(ProblemDetailError) as exc_bad:
            await verify_google_oidc_token(settings, id_token=bad_tok)
        assert exc_bad.value.code == "invalid_oidc_token"


async def test_funnel_empty_invalid_dates_and_provider_health_redis_resilience(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    admin_headers = await _get_admin_headers(client)

    # Empty DB funnel -> zeros and empty routes
    empty_funnel = await client.get("/v1/admin/analytics/funnel", headers=admin_headers)
    assert empty_funnel.status_code == 200
    ef = empty_funnel.json()
    assert ef["verified"] == 0
    assert ef["goal_set"] == 0
    assert ef["matched"] == 0
    assert ef["swap_created"] == 0
    assert ef["swap_confirmed"] == 0
    assert ef["swap_completed"] == 0
    assert ef["match_rate"] == 0.0
    assert ef["routes"] == []
    assert ef["notification_delivery"]["total"] == 0

    # from_date > to_date -> 422 invalid_date_range
    bad_dates = await client.get(
        "/v1/admin/analytics/funnel?from_date=2026-12-10&to_date=2026-12-01",
        headers=admin_headers,
    )
    assert _assert_problem_json(bad_dates, 422)["code"] == "invalid_date_range"

    app_ref: Any = client.app  # type: ignore[attr-defined]
    # Malformed Redis failure counter degrades gracefully to failures=0
    await app_ref.state.redis.set("cb:rail:fake_rail:failures", "not-an-integer")
    health_malformed = await client.get("/v1/admin/providers/health", headers=admin_headers)
    assert health_malformed.status_code == 200
    rail_items = [p for p in health_malformed.json()["providers"] if p["category"] == "rail"]
    assert all(p["failures"] == 0 for p in rail_items)

    # RedisError on exists/get/ttl degrades gracefully without 500
    class _BrokenRedis:
        async def exists(self, _key: str) -> int:
            raise RedisError("redis connection lost")

        async def get(self, _key: str) -> str | None:
            raise RedisError("redis connection lost")

        async def ttl(self, _key: str) -> int:
            raise RedisError("redis connection lost")

    monkeypatch.setattr(app_ref.state, "redis", _BrokenRedis())
    health_down = await client.get("/v1/admin/providers/health", headers=admin_headers)
    assert health_down.status_code == 200
    down_rail = [p for p in health_down.json()["providers"] if p["category"] == "rail"]
    assert down_rail
    assert all(
        p["circuit_state"] == "closed" and p["failures"] == 0 and p["open_ttl_seconds"] == 0
        for p in down_rail
    )


async def test_moderation_filters_restrict_swaps_and_ban_blocks_otp_verify(
    client: AsyncClient,
    fake_messaging: FakeMessagingProvider,
) -> None:
    tok_rep, _, _ = await _otp_login(client, fake_messaging, "9876548120")
    tok_off, _, uid_off = await _otp_login(client, fake_messaging, "9876548121")
    h_rep = {"Authorization": f"Bearer {tok_rep}"}
    h_off = {"Authorization": f"Bearer {tok_off}"}

    await client.patch(
        "/v1/me",
        headers=h_off,
        json={"display_alias": "OffenderAlias"},
    )
    v_rep = (
        await client.post(
            "/v1/journeys/verify",
            headers=h_rep,
            json={"mode": "train", "pnr": "4111111111"},
        )
    ).json()
    v_off = (
        await client.post(
            "/v1/journeys/verify",
            headers=h_off,
            json={"mode": "train", "pnr": "4222222222"},
        )
    ).json()
    await client.put(
        f"/v1/parties/{v_off['party']['id']}/goal",
        headers=h_off,
        json={
            "goal_type": "open_to_help",
            "movers": [v_off["seat_holders"][0]["id"]],
            "constraints": {},
        },
    )
    await client.put(
        f"/v1/parties/{v_rep['party']['id']}/goal",
        headers=h_rep,
        json={"goal_type": "lower", "movers": [v_rep["seat_holders"][0]["id"]], "constraints": {}},
    )
    matches = (
        await client.get(f"/v1/parties/{v_rep['party']['id']}/matches?kind=pair", headers=h_rep)
    ).json()["items"]
    card_id = matches[0]["card_id"]
    convo_id = (
        await client.post("/v1/conversations", headers=h_rep, json={"card_id": card_id})
    ).json()["id"]
    msg = (
        await client.post(
            f"/v1/conversations/{convo_id}/messages",
            headers=h_off,
            json={"body": "Send money now", "client_id": "m-mod-1"},
        )
    ).json()
    r_open = (
        await client.post(
            "/v1/reports",
            headers=h_rep,
            json={"conversation_id": convo_id, "message_id": msg["id"], "reason": "scam"},
        )
    ).json()
    r_dismiss = (
        await client.post(
            "/v1/reports",
            headers=h_rep,
            json={"conversation_id": convo_id, "reason": "noise"},
        )
    ).json()

    admin_headers = await _get_admin_headers(client)

    # Invalid status query param -> 422
    _assert_problem_json(
        await client.get("/v1/admin/moderation/queue?status=bogus", headers=admin_headers),
        422,
    )

    # Open queue verifies joined fields and exact AuditLog entry
    q_open = await client.get(
        "/v1/admin/moderation/queue?status=open&limit=1&offset=0",
        headers=admin_headers,
    )
    assert q_open.status_code == 200
    assert q_open.json()["total"] == 2
    assert len(q_open.json()["items"]) == 1

    q_all = await client.get("/v1/admin/moderation/queue?status=all", headers=admin_headers)
    assert q_all.status_code == 200
    by_id = {item["report_id"]: item for item in q_all.json()["items"]}
    assert by_id[r_open["report_id"]]["target_display_alias"] == "OffenderAlias"
    assert by_id[r_open["report_id"]]["message_body"] == "Send money now"
    assert by_id[r_open["report_id"]]["journey_instance_id"] == v_rep["journey"]["id"]

    logs_q = await client.get(
        "/v1/admin/audit-log?action=admin.moderation_queue_viewed"
        "&actor=admin:ops@saath.test&resource=moderation:queue",
        headers=admin_headers,
    )
    assert logs_q.status_code == 200
    assert logs_q.json()["total"] >= 2

    # Dismiss one, restrict on the other
    await client.post(
        f"/v1/admin/moderation/{r_dismiss['report_id']}/action",
        headers=admin_headers,
        json={"action": "dismiss"},
    )
    await client.post(
        f"/v1/admin/moderation/{r_open['report_id']}/action",
        headers=admin_headers,
        json={"action": "restrict", "note": "Warning issued"},
    )

    q_dismissed = await client.get(
        "/v1/admin/moderation/queue?status=dismissed", headers=admin_headers
    )
    assert [i["report_id"] for i in q_dismissed.json()["items"]] == [r_dismiss["report_id"]]
    q_actioned = await client.get(
        "/v1/admin/moderation/queue?status=actioned", headers=admin_headers
    )
    assert [i["report_id"] for i in q_actioned.json()["items"]] == [r_open["report_id"]]

    # Restricted user blocked from chat AND POST /v1/swaps with code == "account_restricted"
    chat_blocked = await client.post(
        f"/v1/conversations/{convo_id}/messages",
        headers=h_off,
        json={"body": "Blocked", "client_id": "m-mod-2"},
    )
    assert _assert_problem_json(chat_blocked, 403)["code"] == "account_restricted"

    swap_blocked = await client.post("/v1/swaps", headers=h_off, json={"card_id": card_id})
    assert _assert_problem_json(swap_blocked, 403)["code"] == "account_restricted"

    # Ban user -> restrict afterward preserves banned status; OTP verify is blocked with 403
    ban_res = await client.post(
        f"/v1/admin/moderation/{r_open['report_id']}/action",
        headers=admin_headers,
        json={"action": "ban"},
    )
    assert ban_res.status_code == 200
    assert ban_res.json()["target_user_status"] == "banned"

    restrict_after_ban = await client.post(
        f"/v1/admin/moderation/{r_open['report_id']}/action",
        headers=admin_headers,
        json={"action": "restrict"},
    )
    assert restrict_after_ban.status_code == 200
    assert restrict_after_ban.json()["target_user_status"] == "banned"

    otp_start = await client.post(
        "/v1/auth/otp/start",
        json={"phone": "9876548121", "channel": "whatsapp", "turnstile": "ok"},
    )
    assert otp_start.status_code == 200
    otp_code = fake_messaging.sent_messages[-1].code
    otp_verify = await client.post(
        "/v1/auth/otp/verify",
        json={"request_id": otp_start.json()["request_id"], "code": otp_code},
    )
    assert _assert_problem_json(otp_verify, 403)["code"] == "account_disabled"
    assert uid_off


async def test_fraud_graph_cap_anomalies_nodes_and_p256dh_clusters(
    client: AsyncClient,
    fake_messaging: FakeMessagingProvider,
) -> None:
    _, _, uid_1 = await _otp_login(client, fake_messaging, "9876548130")
    _, _, uid_2 = await _otp_login(client, fake_messaging, "9876548131")
    u1, u2 = UUID(uid_1), UUID(uid_2)

    raw_p256dh = "p256dh-shared-secret-key-only"
    expected_p256dh_hash = hashlib.sha256(raw_p256dh.encode("utf-8")).hexdigest()[:16]

    app_ref: Any = client.app  # type: ignore[attr-defined]
    async with app_ref.state.session_factory() as db:
        db.add_all(
            [
                Device(id=uuid7(), user_id=u1, push_endpoint=None, push_p256dh=raw_p256dh),
                Device(id=uuid7(), user_id=u2, push_endpoint=None, push_p256dh=raw_p256dh),
                KarmaLedger(
                    user_id=u1,
                    proposal_id=None,
                    delta=100,
                    state="credited",
                    reason="test",
                ),
                KarmaLedger(
                    user_id=u1,
                    proposal_id=None,
                    delta=-40,
                    state="reversed",
                    reason="test_rev",
                ),
                AuditLog(
                    actor="system:karma",
                    action="karma.same_pair_cap_blocked",
                    resource=f"swap:{uuid7()}",
                    meta={"user_id": str(u1)},
                ),
                AuditLog(
                    actor="system:karma",
                    action="karma.daily_cap_blocked",
                    resource=f"swap:{uuid7()}",
                    meta={"user_id": str(u2)},
                ),
            ]
        )
        await db.commit()

    admin_headers = await _get_admin_headers(client)
    graph_resp = await client.get("/v1/admin/fraud/graph", headers=admin_headers)
    assert graph_resp.status_code == 200
    assert raw_p256dh not in graph_resp.text
    g = graph_resp.json()

    assert any(
        sd["signal"] == "push_p256dh" and sd["fingerprint_hash"] == expected_p256dh_hash
        for sd in g["shared_devices"]
    )
    anomaly_actions = {a["action"] for a in g["anomalies"]}
    assert {"karma.same_pair_cap_blocked", "karma.daily_cap_blocked"}.issubset(anomaly_actions)

    nodes_by_id = {n["user_id"]: n for n in g["nodes"]}
    assert nodes_by_id[uid_1]["karma_credited"] == 100
    assert nodes_by_id[uid_1]["karma_reversed"] == 40
    assert nodes_by_id[uid_2]["karma_credited"] == 0

    audit_fg = await client.get(
        "/v1/admin/audit-log?action=admin.fraud_graph_viewed&resource=fraud:graph",
        headers=admin_headers,
    )
    assert audit_fg.status_code == 200
    assert audit_fg.json()["total"] == 1


async def test_disputes_lifecycle_dismiss_re_reversal_and_redemption_cancel(
    client: AsyncClient,
    fake_messaging: FakeMessagingProvider,
) -> None:
    tok_1, _, uid_1 = await _otp_login(client, fake_messaging, "9876548140")
    _, _, uid_2 = await _otp_login(client, fake_messaging, "9876548141")
    u1, u2 = UUID(uid_1), UUID(uid_2)
    h1 = {"Authorization": f"Bearer {tok_1}"}

    app_ref: Any = client.app  # type: ignore[attr-defined]
    async with app_ref.state.session_factory() as db:
        ji = JourneyInstance(
            id=uuid7(),
            mode="train",
            carrier_code="IR",
            service_no="12953",
            service_date=date.today() + timedelta(days=4),
            chart_state="final",
        )
        db.add(ji)
        b_conflict = Booking(
            id=uuid7(),
            journey_instance_id=ji.id,
            owner_user_id=u1,
            pnr_hash=b"pnr-disp-c",
            trust_tier="verified_provider",
            claim_conflict_flagged=True,
            purge_after=datetime.now(UTC) + timedelta(days=3),
        )
        b_other = Booking(
            id=uuid7(),
            journey_instance_id=ji.id,
            owner_user_id=u2,
            pnr_hash=b"pnr-disp-o",
            trust_tier="verified_provider",
            purge_after=datetime.now(UTC) + timedelta(days=3),
        )
        db.add_all([b_conflict, b_other])
        sh1 = SeatHolder(
            id=uuid7(),
            booking_id=b_conflict.id,
            pax_seq=1,
            coach="B3",
            seat_no="1",
            seat_type="LB",
        )
        sh2 = SeatHolder(
            id=uuid7(),
            booking_id=b_other.id,
            pax_seq=1,
            coach="B3",
            seat_no="2",
            seat_type="MB",
        )
        db.add_all([sh1, sh2])

        # 1. Swap where user dispute already created NotificationsOutbox karma_reversed
        sp_cycle = SwapProposal(
            id=uuid7(),
            journey_instance_id=ji.id,
            initiator_user_id=u1,
            kind="pair",
            status="not_completed",
            expires_at=datetime.now(UTC) + timedelta(hours=1),
        )
        # 2. Completed swap with spurious negative post_confirm -> dismiss keeps completed
        sp_completed_dismiss = SwapProposal(
            id=uuid7(),
            journey_instance_id=ji.id,
            initiator_user_id=u1,
            kind="pair",
            status="completed",
            expires_at=datetime.now(UTC) + timedelta(hours=1),
        )
        # 3. Awaiting-confirmation swap with negative confirm -> dismiss resolves cleanly
        sp_awaiting_dismiss = SwapProposal(
            id=uuid7(),
            journey_instance_id=ji.id,
            initiator_user_id=u1,
            kind="pair",
            status="awaiting_confirmation",
            expires_at=datetime.now(UTC) + timedelta(hours=1),
        )
        # 4. Non-disputable pending swap -> 409 invalid_dispute_state
        sp_pending = SwapProposal(
            id=uuid7(),
            journey_instance_id=ji.id,
            initiator_user_id=u1,
            kind="pair",
            status="pending",
            expires_at=datetime.now(UTC) + timedelta(hours=1),
        )
        db.add_all([sp_cycle, sp_completed_dismiss, sp_awaiting_dismiss, sp_pending])
        db.add_all(
            [
                SwapParticipant(
                    proposal_id=sp_cycle.id,
                    seat_holder_id=sh1.id,
                    user_id=u1,
                    alias="A",
                    gives_seat="B3-1",
                    gets_seat="B3-2",
                    decision="accepted",
                    post_confirm="no",
                ),
                SwapParticipant(
                    proposal_id=sp_cycle.id,
                    seat_holder_id=sh2.id,
                    user_id=u2,
                    alias="B",
                    gives_seat="B3-2",
                    gets_seat="B3-1",
                    decision="accepted",
                    post_confirm="yes",
                ),
                SwapParticipant(
                    proposal_id=sp_completed_dismiss.id,
                    seat_holder_id=sh1.id,
                    user_id=u1,
                    alias="A",
                    gives_seat="B3-1",
                    gets_seat="B3-2",
                    decision="accepted",
                    post_confirm="yes",
                ),
                SwapParticipant(
                    proposal_id=sp_completed_dismiss.id,
                    seat_holder_id=sh2.id,
                    user_id=u2,
                    alias="B",
                    gives_seat="B3-2",
                    gets_seat="B3-1",
                    decision="accepted",
                    post_confirm="no",
                ),
                SwapParticipant(
                    proposal_id=sp_awaiting_dismiss.id,
                    seat_holder_id=sh1.id,
                    user_id=u1,
                    alias="A",
                    gives_seat="B3-1",
                    gets_seat="B3-2",
                    decision="accepted",
                    post_confirm="did_not_board",
                ),
                SwapParticipant(
                    proposal_id=sp_awaiting_dismiss.id,
                    seat_holder_id=sh2.id,
                    user_id=u2,
                    alias="B",
                    gives_seat="B3-2",
                    gets_seat="B3-1",
                    decision="accepted",
                    post_confirm="yes",
                ),
                KarmaLedger(
                    user_id=u1,
                    proposal_id=sp_cycle.id,
                    delta=100,
                    state="credited",
                    reason="swap_completed",
                ),
                KarmaLedger(
                    user_id=u1,
                    proposal_id=sp_cycle.id,
                    delta=-100,
                    state="reversed",
                    reason="dispute:no",
                ),
                NotificationsOutbox(
                    user_id=u1,
                    event="KarmaReversed",
                    payload={"swap_id": str(sp_cycle.id), "points": 100},
                    idempotency_key=f"karma_reversed:{sp_cycle.id}:{u1}",
                ),
                KarmaLedger(
                    user_id=u1,
                    proposal_id=sp_completed_dismiss.id,
                    delta=100,
                    state="credited",
                    reason="swap_completed",
                ),
            ]
        )

        # Enable rewards & seed item + pending redemption for u1
        flag = (
            await db.execute(
                select(FeatureFlag).where(FeatureFlag.key == "rewards_catalogue_enabled")
            )
        ).scalar_one()
        flag.value = True
        reward = RewardItem(
            id=uuid7(),
            code="MEAL_200",
            title_en="Train Meal",
            title_hi="भोजन",
            cost_points=80,
            stock=1,
            active=True,
        )
        db.add(reward)
        red_cancel = RewardRedemption(
            id=uuid7(),
            user_id=u1,
            reward_item_id=reward.id,
            points_spent=80,
            status="pending",
        )
        db.add(red_cancel)
        await db.commit()

    admin_headers = await _get_admin_headers(client)

    try:
        # Invalid status query param & extra="forbid" body checks -> 422
        _assert_problem_json(
            await client.get("/v1/admin/disputes?status=invalid", headers=admin_headers),
            422,
        )
        _assert_problem_json(
            await client.get("/v1/admin/redemptions?status=invalid", headers=admin_headers),
            422,
        )
        _assert_problem_json(
            await client.patch(
                "/v1/admin/flags/maintenance_banner",
                headers=admin_headers,
                json={"value": False, "extra_field": 1},
            ),
            422,
        )
        _assert_problem_json(
            await client.post(
                f"/v1/admin/disputes/{sp_cycle.id}/override",
                headers=admin_headers,
                json={"action": "complete", "extra_field": 1},
            ),
            422,
        )
        _assert_problem_json(
            await client.post(
                f"/v1/admin/redemptions/{red_cancel.id}/review",
                headers=admin_headers,
                json={"action": "approve", "extra_field": 1},
            ),
            422,
        )

        # Non-disputable pending swap -> 409 invalid_dispute_state
        non_disp = await client.post(
            f"/v1/admin/disputes/{sp_pending.id}/override",
            headers=admin_headers,
            json={"action": "complete"},
        )
        assert _assert_problem_json(non_disp, 409)["code"] == "invalid_dispute_state"

        # Invalid action cross-checks: clear_conflict on swap, complete on booking -> 409
        assert (
            _assert_problem_json(
                await client.post(
                    f"/v1/admin/disputes/{sp_cycle.id}/override",
                    headers=admin_headers,
                    json={"action": "clear_conflict"},
                ),
                409,
            )["code"]
            == "invalid_dispute_action"
        )
        assert (
            _assert_problem_json(
                await client.post(
                    f"/v1/admin/disputes/{b_conflict.id}/override",
                    headers=admin_headers,
                    json={"action": "complete"},
                ),
                409,
            )["code"]
            == "invalid_dispute_action"
        )

        # Dismiss completed swap keeps status="completed" and does NOT reverse karma
        dismiss_completed = await client.post(
            f"/v1/admin/disputes/{sp_completed_dismiss.id}/override",
            headers=admin_headers,
            json={"action": "dismiss", "note": "Verified completed"},
        )
        assert dismiss_completed.status_code == 200
        assert dismiss_completed.json()["status"] == "completed"
        assert dismiss_completed.json()["karma_reversed_users"] == []

        # Dismiss awaiting_confirmation swap keeps awaiting_confirmation & moves out of open
        dismiss_awaiting = await client.post(
            f"/v1/admin/disputes/{sp_awaiting_dismiss.id}/override",
            headers=admin_headers,
            json={"action": "dismiss", "note": "Spurious report"},
        )
        assert dismiss_awaiting.status_code == 200
        assert dismiss_awaiting.json()["status"] == "awaiting_confirmation"
        assert dismiss_awaiting.json()["karma_reversed_users"] == []

        # Override sp_cycle: complete -> then reverse_karma (no outbox UniqueViolation)
        ov_comp = await client.post(
            f"/v1/admin/disputes/{sp_cycle.id}/override",
            headers=admin_headers,
            json={"action": "complete"},
        )
        assert ov_comp.status_code == 200
        assert ov_comp.json()["status"] == "completed"

        ov_rev = await client.post(
            f"/v1/admin/disputes/{sp_cycle.id}/override",
            headers=admin_headers,
            json={"action": "reverse_karma", "note": "Re-reversed after audit"},
        )
        assert ov_rev.status_code == 200
        assert ov_rev.json()["status"] == "not_completed"
        assert str(u1) in ov_rev.json()["karma_reversed_users"]

        # Repeat override with not_completed is idempotent and stays resolved
        ov_not_comp = await client.post(
            f"/v1/admin/disputes/{sp_cycle.id}/override",
            headers=admin_headers,
            json={"action": "not_completed", "note": "Confirmed not completed"},
        )
        assert ov_not_comp.status_code == 200
        assert ov_not_comp.json()["status"] == "not_completed"
        assert ov_not_comp.json()["karma_reversed_users"] == []

        # Override booking conflict -> moves to status=resolved
        ov_bk = await client.post(
            f"/v1/admin/disputes/{b_conflict.id}/override",
            headers=admin_headers,
            json={"action": "clear_conflict"},
        )
        assert ov_bk.status_code == 200

        # Disputes open vs resolved vs all + admin.disputes_viewed audit log
        d_open = await client.get("/v1/admin/disputes?status=open", headers=admin_headers)
        assert d_open.status_code == 200
        assert d_open.json()["total"] == 0

        d_resolved = await client.get("/v1/admin/disputes?status=resolved", headers=admin_headers)
        assert d_resolved.status_code == 200
        res_map = {item["dispute_id"]: item for item in d_resolved.json()["items"]}
        assert str(sp_cycle.id) in res_map
        assert str(sp_completed_dismiss.id) in res_map
        assert str(sp_awaiting_dismiss.id) in res_map
        assert str(b_conflict.id) in res_map
        assert res_map[str(b_conflict.id)]["status"] == "resolved"
        assert res_map[str(b_conflict.id)]["claim_conflict_flagged"] is False

        d_all = await client.get("/v1/admin/disputes?status=all", headers=admin_headers)
        assert d_all.status_code == 200
        assert {item["dispute_id"] for item in d_all.json()["items"]} >= {
            str(sp_cycle.id),
            str(sp_completed_dismiss.id),
            str(sp_awaiting_dismiss.id),
            str(b_conflict.id),
        }

        disputes_audit = await client.get(
            "/v1/admin/audit-log?action=admin.disputes_viewed&resource=disputes:list",
            headers=admin_headers,
        )
        assert disputes_audit.status_code == 200
        assert disputes_audit.json()["total"] >= 3

        # Redemptions: filter by status, cancel restores stock & balance, unknown -> 404
        _assert_problem_json(
            await client.post(
                f"/v1/admin/redemptions/{uuid.uuid4()}/review",
                headers=admin_headers,
                json={"action": "approve"},
            ),
            404,
        )

        wallet_before = (await client.get("/v1/karma", headers=h1)).json()
        assert wallet_before["redeemed_points"] == 80

        reds_pending = await client.get(
            "/v1/admin/redemptions?status=pending", headers=admin_headers
        )
        assert reds_pending.status_code == 200
        assert reds_pending.json()["total"] == 1

        cancelled = await client.post(
            f"/v1/admin/redemptions/{red_cancel.id}/review",
            headers=admin_headers,
            json={"action": "cancel", "note": "User requested cancel"},
        )
        assert cancelled.status_code == 200
        assert cancelled.json()["status"] == "cancelled"

        reds_cancelled = await client.get(
            "/v1/admin/redemptions?status=cancelled", headers=admin_headers
        )
        assert reds_cancelled.status_code == 200
        assert reds_cancelled.json()["total"] == 1

        wallet_after = (await client.get("/v1/karma", headers=h1)).json()
        assert wallet_after["redeemed_points"] == 0
        assert wallet_after["available_balance"] == wallet_before["available_balance"] + 80

        async with app_ref.state.session_factory() as db:
            item_row = (
                await db.execute(select(RewardItem).where(RewardItem.id == reward.id))
            ).scalar_one()
            assert item_row.stock == 2
            outbox_row = (
                await db.execute(
                    select(NotificationsOutbox).where(
                        NotificationsOutbox.idempotency_key
                        == f"reward_redemption_review:{red_cancel.id}:cancelled"
                    )
                )
            ).scalar_one_or_none()
            assert outbox_row is not None
            assert outbox_row.event == "RewardRedemptionUpdated"
    finally:
        async with app_ref.state.session_factory() as db:
            flag_restore = (
                await db.execute(
                    select(FeatureFlag).where(FeatureFlag.key == "rewards_catalogue_enabled")
                )
            ).scalar_one()
            flag_restore.value = False
            await db.commit()
