from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from typing import Any

import jwt
from httpx import AsyncClient
from sqlalchemy import select

from saath_api.auth.models import AuditLog, User
from saath_api.providers.base import ProviderError
from saath_api.providers.messaging import FakeMessagingProvider, OtpChannel


async def test_otp_happy_path_whatsapp_and_sms_plus_anon_merge(
    client: AsyncClient,
    fake_messaging: FakeMessagingProvider,
) -> None:
    anon_resp = await client.post("/v1/auth/anonymous", json={"turnstile": "ok"})
    anon_token = anon_resp.json()["access"]

    start_resp = await client.post(
        "/v1/auth/otp/start",
        json={"phone": "9876543210", "channel": "whatsapp", "turnstile": "ok"},
    )
    assert start_resp.status_code == 200
    request_id = start_resp.json()["request_id"]
    assert start_resp.json()["resend_after"] == 30
    assert len(fake_messaging.sent_messages) == 1
    sent = fake_messaging.sent_messages[0]
    assert sent.phone_e164 == "+919876543210"
    assert sent.channel == "whatsapp"

    verify_resp = await client.post(
        "/v1/auth/otp/verify",
        headers={"Authorization": f"Bearer {anon_token}"},
        json={"request_id": request_id, "code": sent.code},
    )
    assert verify_resp.status_code == 200
    data = verify_resp.json()
    assert data["access"]
    assert data["refresh"]
    assert data["user"]["locale"] == "en"
    assert "phone" not in data["user"]

    app: Any = client.app  # type: ignore[attr-defined]
    async with app.state.session_factory() as db:
        users = (await db.execute(select(User))).scalars().all()
        assert len(users) == 1
        assert b"9876543210" not in users[0].phone_enc
        audits = (await db.execute(select(AuditLog))).scalars().all()
        actions = {a.action for a in audits}
        assert "auth.otp_verified" in actions
        assert "auth.anon_merged" in actions

    # Second phone via SMS channel
    start_sms = await client.post(
        "/v1/auth/otp/start",
        json={"phone": "+91 9123456789", "channel": "sms", "turnstile": "ok", "locale": "hi"},
    )
    assert start_sms.status_code == 200
    sms_sent = fake_messaging.sent_messages[-1]
    assert sms_sent.channel == "sms"
    verify_sms = await client.post(
        "/v1/auth/otp/verify",
        json={"request_id": start_sms.json()["request_id"], "code": sms_sent.code},
    )
    assert verify_sms.status_code == 200
    assert verify_sms.json()["user"]["locale"] == "hi"


async def test_otp_invalid_phone_returns_422(client: AsyncClient) -> None:
    resp = await client.post(
        "/v1/auth/otp/start",
        json={"phone": "1234567890", "channel": "sms", "turnstile": "ok"},
    )
    assert resp.status_code == 422
    assert resp.json()["code"] == "invalid_phone"


async def test_otp_resend_cooldown_and_ip_rate_limit(client: AsyncClient) -> None:
    first = await client.post(
        "/v1/auth/otp/start",
        json={"phone": "9876543211", "channel": "whatsapp", "turnstile": "ok"},
    )
    assert first.status_code == 200

    cooldown = await client.post(
        "/v1/auth/otp/start",
        json={"phone": "9876543211", "channel": "whatsapp", "turnstile": "ok"},
    )
    assert cooldown.status_code == 429
    assert cooldown.json()["code"] == "otp_resend_cooldown"
    assert int(cooldown.headers["retry-after"]) >= 1

    # Different phones hit IP 5/min rate limit
    for suffix in ["2", "3", "4", "5"]:
        ok_resp = await client.post(
            "/v1/auth/otp/start",
            json={"phone": f"987654321{suffix}", "channel": "sms", "turnstile": "ok"},
        )
        assert ok_resp.status_code == 200

    rate_limited = await client.post(
        "/v1/auth/otp/start",
        json={"phone": "9876543216", "channel": "sms", "turnstile": "ok"},
    )
    assert rate_limited.status_code == 429
    assert rate_limited.json()["code"] == "rate_limited"


async def test_otp_wrong_code_and_5_attempt_lockout(
    client: AsyncClient,
    fake_messaging: FakeMessagingProvider,
) -> None:
    start_resp = await client.post(
        "/v1/auth/otp/start",
        json={"phone": "9876543299", "channel": "whatsapp", "turnstile": "ok"},
    )
    request_id = start_resp.json()["request_id"]
    real_code = fake_messaging.sent_messages[-1].code
    wrong_code = "000000" if real_code != "000000" else "111111"

    for _ in range(5):
        bad = await client.post(
            "/v1/auth/otp/verify",
            json={"request_id": request_id, "code": wrong_code},
        )
        assert bad.status_code == 401
        assert bad.json()["code"] == "otp_invalid"

    locked = await client.post(
        "/v1/auth/otp/verify",
        json={"request_id": request_id, "code": real_code},
    )
    assert locked.status_code == 429
    assert locked.json()["code"] == "otp_max_attempts"


async def test_otp_expired_returns_401(
    client: AsyncClient,
    fake_messaging: FakeMessagingProvider,
) -> None:
    start_resp = await client.post(
        "/v1/auth/otp/start",
        json={"phone": "9876543288", "channel": "whatsapp", "turnstile": "ok"},
    )
    request_id = start_resp.json()["request_id"]
    real_code = fake_messaging.sent_messages[-1].code

    app: Any = client.app  # type: ignore[attr-defined]
    await app.state.redis.delete(f"otp:req:{request_id}")

    expired = await client.post(
        "/v1/auth/otp/verify",
        json={"request_id": request_id, "code": real_code},
    )
    assert expired.status_code == 401
    assert expired.json()["code"] == "otp_expired"


async def test_otp_verify_ignores_expired_anon_jwt_and_succeeds(
    client: AsyncClient,
    fake_messaging: FakeMessagingProvider,
) -> None:
    app: Any = client.app  # type: ignore[attr-defined]
    settings = app.state.settings
    past = datetime.now(UTC) - timedelta(hours=3)
    expired_anon = jwt.encode(
        {
            "sub": "anon:0193632e-0000-7000-8000-000000000099",
            "kind": "anon",
            "scopes": ["anon"],
            "iat": int((past - timedelta(hours=2)).timestamp()),
            "exp": int(past.timestamp()),
            "jti": "expired-anon-jti",
        },
        settings.jwt_private_key,
        algorithm="EdDSA",
    )

    start_resp = await client.post(
        "/v1/auth/otp/start",
        json={"phone": "9876543277", "channel": "whatsapp", "turnstile": "ok"},
    )
    assert start_resp.status_code == 200
    request_id = start_resp.json()["request_id"]
    real_code = fake_messaging.sent_messages[-1].code

    verify_resp = await client.post(
        "/v1/auth/otp/verify",
        headers={"Authorization": f"Bearer {expired_anon}"},
        json={"request_id": request_id, "code": real_code},
    )
    assert verify_resp.status_code == 200
    assert verify_resp.json()["access"]
    assert verify_resp.json()["refresh"]


async def test_otp_concurrent_verify_prevents_replay_and_duplicate_insert(
    client: AsyncClient,
    fake_messaging: FakeMessagingProvider,
) -> None:
    start_resp = await client.post(
        "/v1/auth/otp/start",
        json={"phone": "9876543266", "channel": "whatsapp", "turnstile": "ok"},
    )
    assert start_resp.status_code == 200
    request_id = start_resp.json()["request_id"]
    real_code = fake_messaging.sent_messages[-1].code

    res1, res2 = await asyncio.gather(
        client.post("/v1/auth/otp/verify", json={"request_id": request_id, "code": real_code}),
        client.post("/v1/auth/otp/verify", json={"request_id": request_id, "code": real_code}),
    )
    statuses = sorted([res1.status_code, res2.status_code])
    assert statuses == [200, 401]


async def test_otp_start_provider_failure_skips_cooldown_and_returns_503(
    client: AsyncClient,
) -> None:
    class FailingMessaging:
        async def send_otp(
            self,
            *,
            phone_e164: str,
            code: str,
            locale: str,
            channel: OtpChannel,
        ) -> None:
            _ = (phone_e164, code, locale, channel)
            raise ProviderError("upstream down")

    app: Any = client.app  # type: ignore[attr-defined]
    orig_provider = app.state.messaging_provider
    app.state.messaging_provider = FailingMessaging()
    try:
        fail_resp = await client.post(
            "/v1/auth/otp/start",
            json={"phone": "9876543255", "channel": "sms", "turnstile": "ok"},
        )
        assert fail_resp.status_code == 503
        assert fail_resp.json()["code"] == "messaging_unavailable"
    finally:
        app.state.messaging_provider = orig_provider

    # Immediate retry succeeds without 30s cooldown lockout
    retry_resp = await client.post(
        "/v1/auth/otp/start",
        json={"phone": "9876543255", "channel": "sms", "turnstile": "ok"},
    )
    assert retry_resp.status_code == 200


async def test_otp_verify_wrong_attempt_preserves_ttl_without_resurrecting_expired(
    client: AsyncClient,
    fake_messaging: FakeMessagingProvider,
) -> None:
    start_resp = await client.post(
        "/v1/auth/otp/start",
        json={"phone": "9876543244", "channel": "whatsapp", "turnstile": "ok"},
    )
    request_id = start_resp.json()["request_id"]
    real_code = fake_messaging.sent_messages[-1].code
    wrong_code = "000000" if real_code != "000000" else "111111"

    app: Any = client.app  # type: ignore[attr-defined]
    otp_key = f"otp:req:{request_id}"
    await app.state.redis.pexpire(otp_key, 400)

    bad = await client.post(
        "/v1/auth/otp/verify",
        json={"request_id": request_id, "code": wrong_code},
    )
    assert bad.status_code == 401
    pttl_after = await app.state.redis.pttl(otp_key)
    assert pttl_after <= 400


async def test_otp_unicode_digits_rejected_422(client: AsyncClient) -> None:
    resp = await client.post(
        "/v1/auth/otp/verify",
        json={"request_id": "req-unicode", "code": "१२३४५६"},
    )
    assert resp.status_code == 422
