from __future__ import annotations

from typing import Any

from httpx import AsyncClient
from sqlalchemy import select

from saath_api.auth.models import AuditLog, RefreshToken
from saath_api.providers.messaging import FakeMessagingProvider


async def _login_user(
    client: AsyncClient, fake_messaging: FakeMessagingProvider, phone: str
) -> dict[str, Any]:
    start = await client.post(
        "/v1/auth/otp/start",
        json={"phone": phone, "channel": "whatsapp", "turnstile": "ok"},
    )
    code = fake_messaging.sent_messages[-1].code
    verify = await client.post(
        "/v1/auth/otp/verify",
        json={"request_id": start.json()["request_id"], "code": code},
    )
    assert verify.status_code == 200
    return verify.json()  # type: ignore[no-any-return]


async def test_refresh_rotation_and_reuse_revokes_entire_family(
    client: AsyncClient,
    fake_messaging: FakeMessagingProvider,
) -> None:
    tokens_1 = await _login_user(client, fake_messaging, "9876540001")
    refresh_1 = tokens_1["refresh"]

    rot_resp = await client.post("/v1/auth/refresh", json={"refresh": refresh_1})
    assert rot_resp.status_code == 200
    tokens_2 = rot_resp.json()
    refresh_2 = tokens_2["refresh"]
    assert refresh_2 != refresh_1

    # Replay stolen/old refresh_1 -> must revoke entire family (including refresh_2)
    reuse_resp = await client.post("/v1/auth/refresh", json={"refresh": refresh_1})
    assert reuse_resp.status_code == 401
    assert reuse_resp.json()["code"] == "refresh_token_reused"

    # Now refresh_2 must also be revoked!
    after_reuse = await client.post("/v1/auth/refresh", json={"refresh": refresh_2})
    assert after_reuse.status_code == 401
    assert after_reuse.json()["code"] == "refresh_token_reused"

    app: Any = client.app  # type: ignore[attr-defined]
    async with app.state.session_factory() as db:
        rows = (await db.execute(select(RefreshToken))).scalars().all()
        assert len(rows) == 2
        assert all(r.revoked_at is not None for r in rows)
        audits = (await db.execute(select(AuditLog))).scalars().all()
        assert any(a.action == "auth.refresh_reuse_detected" for a in audits)


async def test_logout_revokes_device_refresh_token(
    client: AsyncClient,
    fake_messaging: FakeMessagingProvider,
) -> None:
    tokens = await _login_user(client, fake_messaging, "9876540002")
    logout_resp = await client.post(
        "/v1/auth/logout",
        headers={"Authorization": f"Bearer {tokens['access']}"},
    )
    assert logout_resp.status_code == 200
    assert logout_resp.json() == {"ok": True}

    refresh_after = await client.post("/v1/auth/refresh", json={"refresh": tokens["refresh"]})
    assert refresh_after.status_code == 401
    assert refresh_after.json()["code"] == "refresh_token_reused"
