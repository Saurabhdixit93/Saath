from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from uuid import UUID

from httpx import AsyncClient
from sqlalchemy import select

from saath_api.auth.models import Device
from saath_api.core.config import Settings
from saath_api.core.crypto import hmac_sha256_hex
from saath_api.core.ids import uuid7
from saath_api.journeys.models import JourneyInstance
from saath_api.notifications.models import NotificationsOutbox
from saath_api.notifications.service import deliver_outbox_batch
from saath_api.notifications.templates import (
    is_quiet_hours_ist,
    is_urgent_chart_bypass,
    next_quiet_hours_end_utc,
)
from saath_api.parties.models import Goal, Party
from saath_api.providers.messaging import FakeMessagingProvider
from saath_api.providers.push import FakeWebPushProvider


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


def test_quiet_hours_ist_and_urgent_chart_bypass() -> None:
    # 18:00 UTC == 23:30 IST (quiet)
    quiet_utc = datetime(2026, 11, 26, 18, 0, tzinfo=UTC)
    assert is_quiet_hours_ist(quiet_utc) is True
    wake = next_quiet_hours_end_utc(quiet_utc)
    # 06:00 IST next day == 00:30 UTC on 2026-11-27
    assert wake.astimezone(UTC) == datetime(2026, 11, 27, 0, 30, tzinfo=UTC)

    # 04:00 UTC == 09:30 IST (active)
    day_utc = datetime(2026, 11, 26, 4, 0, tzinfo=UTC)
    assert is_quiet_hours_ist(day_utc) is False

    # Urgent bypass within <2h of departure
    dep_soon = quiet_utc + timedelta(minutes=90)
    dep_far = quiet_utc + timedelta(hours=5)
    assert is_urgent_chart_bypass("BerthChanged", dep_soon, quiet_utc) is True
    assert is_urgent_chart_bypass("BerthChanged", dep_far, quiet_utc) is False
    assert is_urgent_chart_bypass("MatchFound", dep_soon, quiet_utc) is False


async def test_push_subscription_and_profile_notification_channels(
    client: AsyncClient,
    fake_messaging: FakeMessagingProvider,
) -> None:
    unauth = await client.post(
        "/v1/me/push-subscriptions",
        json={
            "endpoint": "https://push.example/1",
            "keys": {"p256dh": "p256dh-key-val", "auth": "auth-key"},
        },
    )
    assert unauth.status_code == 401

    tok, uid = await _otp_login(client, fake_messaging, "9876543801")
    hdr = {"Authorization": f"Bearer {tok}"}

    bad = await client.post(
        "/v1/me/push-subscriptions",
        headers=hdr,
        json={
            "endpoint": "ftp://invalid",
            "keys": {"p256dh": "p256dh-key-val", "auth": "auth-key"},
        },
    )
    assert bad.status_code == 422

    ok = await client.post(
        "/v1/me/push-subscriptions",
        headers=hdr,
        json={
            "endpoint": "https://push.example/sub-1",
            "keys": {"p256dh": "p256dh-key-val", "auth": "auth-key"},
        },
    )
    assert ok.status_code == 200
    assert ok.json()["subscribed"] is True

    patch_me = await client.patch(
        "/v1/me",
        headers=hdr,
        json={
            "locale": "hi",
            "notification_channels": {"push": True, "whatsapp": False, "sms": True},
        },
    )
    assert patch_me.status_code == 200
    assert patch_me.json()["notification_channels"]["whatsapp"] is False
    assert patch_me.json()["locale"] == "hi"


async def test_outbox_delivery_fallback_idempotency_and_dead_letter(
    client: AsyncClient,
    test_settings: Settings,
    fake_messaging: FakeMessagingProvider,
) -> None:
    tok, uid_str = await _otp_login(client, fake_messaging, "9876543802")
    uid = UUID(uid_str)
    hdr = {"Authorization": f"Bearer {tok}"}
    await client.post(
        "/v1/me/push-subscriptions",
        headers=hdr,
        json={
            "endpoint": "https://push.example/sub-expired",
            "keys": {"p256dh": "p256dh-key-val", "auth": "auth-key"},
        },
    )

    app = client.app  # type: ignore[attr-defined]
    fake_push = FakeWebPushProvider()
    fake_push.expired_endpoints.add("https://push.example/sub-expired")

    daytime = datetime(2026, 11, 26, 6, 0, tzinfo=UTC)
    async with app.state.session_factory() as db:
        row1 = NotificationsOutbox(
            user_id=uid,
            event="MatchFound",
            payload={"journey_instance_id": str(uuid7()), "service_no": "12951"},
            idempotency_key="outbox-test-1",
        )
        db.add(row1)
        await db.commit()

        # Expired push falls back to WhatsApp
        res1 = await deliver_outbox_batch(
            settings=test_settings,
            db=db,
            redis=app.state.redis,
            web_push_provider=fake_push,
            messaging_provider=fake_messaging,
            now_override=daytime,
        )
        assert res1["sent"] == 1
        assert len(fake_messaging.sent_templates) == 1
        assert fake_messaging.sent_templates[0].channel == "whatsapp"

        # Expired endpoint was cleared from Device
        devs = (await db.execute(select(Device).where(Device.user_id == uid))).scalars().all()
        assert all(d.push_endpoint is None for d in devs)

        # Dead-letter after 5 failed attempts across all channels
        fake_messaging.fail_channels.update({"whatsapp", "sms"})
        row_fail = NotificationsOutbox(
            user_id=uid,
            event="SwapProposed",
            payload={"swap_id": str(uuid7())},
            idempotency_key="outbox-fail-5",
        )
        db.add(row_fail)
        await db.commit()

        t_cursor = daytime
        for _ in range(5):
            await deliver_outbox_batch(
                settings=test_settings,
                db=db,
                redis=app.state.redis,
                web_push_provider=fake_push,
                messaging_provider=fake_messaging,
                now_override=t_cursor,
            )
            t_cursor = t_cursor + timedelta(hours=2)

        refreshed = (
            await db.execute(
                select(NotificationsOutbox).where(
                    NotificationsOutbox.idempotency_key == "outbox-fail-5"
                )
            )
        ).scalar_one()
        assert refreshed.status == "dead_letter"
        assert refreshed.attempts == 5

        # Quiet hours deferral vs urgent <2h BerthChanged bypass
        fake_messaging.fail_channels.clear()
        quiet_utc = datetime(2026, 11, 26, 18, 30, tzinfo=UTC)  # 00:00 IST
        ji_soon = JourneyInstance(
            id=uuid7(),
            mode="train",
            carrier_code="IR",
            service_no="12951",
            service_date=quiet_utc.date() + timedelta(days=1),
            departure_at=quiet_utc + timedelta(minutes=45),
            chart_state="final",
        )
        db.add(ji_soon)
        await db.flush()

        db.add(
            NotificationsOutbox(
                user_id=uid,
                event="MatchFound",
                payload={"journey_instance_id": str(ji_soon.id)},
                idempotency_key="outbox-quiet-defer",
            )
        )
        db.add(
            NotificationsOutbox(
                user_id=uid,
                event="BerthChanged",
                payload={
                    "journey_instance_id": str(ji_soon.id),
                    "new_coach": "B5",
                    "new_seat": "12",
                },
                idempotency_key="outbox-urgent-bypass",
            )
        )
        await db.commit()

        res_quiet = await deliver_outbox_batch(
            settings=test_settings,
            db=db,
            redis=app.state.redis,
            web_push_provider=fake_push,
            messaging_provider=fake_messaging,
            now_override=quiet_utc,
        )
        assert res_quiet["deferred"] == 1
        assert res_quiet["sent"] == 1


async def test_whatsapp_webhook_hmac_dedupe_and_pnr_bot(
    client: AsyncClient,
    fake_messaging: FakeMessagingProvider,
) -> None:
    app = client.app  # type: ignore[attr-defined]
    app.state.settings.whatsapp_app_secret = "wa-test-secret"
    app.state.settings.whatsapp_verify_token = ""

    empty_tok_challenge = await client.get(
        "/v1/webhooks/whatsapp",
        params={"hub.mode": "subscribe", "hub.verify_token": "", "hub.challenge": "12345"},
    )
    assert empty_tok_challenge.status_code == 403

    app.state.settings.whatsapp_verify_token = "wa-verify-tok"

    bad_challenge = await client.get(
        "/v1/webhooks/whatsapp",
        params={"hub.mode": "subscribe", "hub.verify_token": "wrong", "hub.challenge": "12345"},
    )
    assert bad_challenge.status_code == 403

    good_challenge = await client.get(
        "/v1/webhooks/whatsapp",
        params={
            "hub.mode": "subscribe",
            "hub.verify_token": "wa-verify-tok",
            "hub.challenge": "12345",
        },
    )
    assert good_challenge.status_code == 200
    assert good_challenge.text == "12345"

    body = json.dumps(
        {
            "entry": [
                {
                    "changes": [
                        {
                            "value": {
                                "messages": [
                                    {
                                        "id": "wamid.abc123",
                                        "from": "919876543899",
                                        "type": "text",
                                        "text": {"body": "My PNR is 4111111111"},
                                    }
                                ]
                            }
                        }
                    ]
                }
            ]
        }
    ).encode("utf-8")

    bad_sig = await client.post(
        "/v1/webhooks/whatsapp",
        content=body,
        headers={"X-Hub-Signature-256": "sha256=deadbeef"},
    )
    assert bad_sig.status_code == 403

    sig = hmac_sha256_hex("wa-test-secret", body)
    ok_res = await client.post(
        "/v1/webhooks/whatsapp",
        content=body,
        headers={"X-Hub-Signature-256": f"sha256={sig}", "content-type": "application/json"},
    )
    assert ok_res.status_code == 200
    assert ok_res.json()["processed"] == 1
    assert len(fake_messaging.sent_whatsapp_replies) == 1
    assert "12951" in fake_messaging.sent_whatsapp_replies[0].text

    # Replay same wamid -> deduped
    dup_res = await client.post(
        "/v1/webhooks/whatsapp",
        content=body,
        headers={"X-Hub-Signature-256": f"sha256={sig}", "content-type": "application/json"},
    )
    assert dup_res.status_code == 200
    assert dup_res.json()["deduped"] == 1
    assert len(fake_messaging.sent_whatsapp_replies) == 1

    # Interactive "Find me a lower" reply -> sets goal_type="lower" with party movers and
    # returns 200
    lower_body = json.dumps(
        {
            "entry": [
                {
                    "changes": [
                        {
                            "value": {
                                "messages": [
                                    {
                                        "id": "wamid.lower123",
                                        "from": "919876543899",
                                        "type": "interactive",
                                        "interactive": {
                                            "button_reply": {
                                                "id": "goal_lower",
                                                "title": "Find me a lower",
                                            }
                                        },
                                    }
                                ]
                            }
                        }
                    ]
                }
            ]
        }
    ).encode("utf-8")
    lower_sig = hmac_sha256_hex("wa-test-secret", lower_body)
    lower_res = await client.post(
        "/v1/webhooks/whatsapp",
        content=lower_body,
        headers={"X-Hub-Signature-256": f"sha256={lower_sig}", "content-type": "application/json"},
    )
    assert lower_res.status_code == 200
    assert lower_res.json()["processed"] == 1
    assert len(fake_messaging.sent_whatsapp_replies) == 2
    assert "Goal saved (lower)" in fake_messaging.sent_whatsapp_replies[1].text

    async with app.state.session_factory() as db:
        goal_row = (
            await db.execute(
                select(Goal)
                .join(Party, Party.id == Goal.party_id)
                .where(Goal.active.is_(True))
                .order_by(Goal.updated_at.desc())
                .limit(1)
            )
        ).scalar_one()
        assert goal_row.goal_type == "lower"
        assert len(goal_row.movers) >= 1


async def test_whatsapp_webhook_rejects_empty_app_secret_in_production(
    client: AsyncClient,
) -> None:
    app = client.app  # type: ignore[attr-defined]
    orig_env = app.state.settings.env
    orig_secret = app.state.settings.whatsapp_app_secret
    try:
        app.state.settings.env = "production"
        app.state.settings.whatsapp_app_secret = ""
        body = b'{"entry":[]}'
        forged_sig = hmac_sha256_hex("", body)
        resp = await client.post(
            "/v1/webhooks/whatsapp",
            content=body,
            headers={
                "X-Hub-Signature-256": f"sha256={forged_sig}",
                "content-type": "application/json",
            },
        )
        assert resp.status_code == 403
        assert resp.json()["code"] == "whatsapp_secret_missing"
    finally:
        app.state.settings.env = orig_env
        app.state.settings.whatsapp_app_secret = orig_secret
