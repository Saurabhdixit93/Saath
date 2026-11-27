from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from typing import Any

from httpx import AsyncClient
from sqlalchemy import update

from saath_api.core.config import Settings, load_yaml_configs
from saath_api.main import create_app
from saath_api.pricing.models import Entitlement
from saath_api.providers.messaging import FakeMessagingProvider
from saath_api.providers.payment.sandbox import SandboxPaymentAdapter


async def _login_user(
    client: AsyncClient, fake_messaging: FakeMessagingProvider, phone: str
) -> str:
    start = await client.post(
        "/v1/auth/otp/start",
        json={"phone": phone, "channel": "whatsapp", "turnstile": "ok"},
    )
    code = fake_messaging.sent_messages[-1].code
    verify = await client.post(
        "/v1/auth/otp/verify",
        json={"request_id": start.json()["request_id"], "code": code},
    )
    return str(verify.json()["access"])


async def test_pricing_plans_no_seat_sale_invariant_and_checkout_gate(
    client: AsyncClient,
    fake_messaging: FakeMessagingProvider,
) -> None:
    plans_resp = await client.get("/v1/pricing/plans")
    assert plans_resp.status_code == 200
    pdata = plans_resp.json()
    assert pdata["anti_seat_sale_guarantee"] is True
    for plan in pdata["plans"]:
        assert plan["priority_seat_bump"] is False

    org_tok = await _login_user(client, fake_messaging, "9876543300")
    org_h = {"Authorization": f"Bearer {org_tok}"}

    # Verify 2-pax PNR (2 members)
    v1 = (
        await client.post(
            "/v1/journeys/verify",
            headers=org_h,
            json={"mode": "train", "pnr": "2415678901"},
        )
    ).json()
    journey_id = v1["journey"]["id"]
    party_id = v1["party_id"]
    invite_token = (
        await client.post(f"/v1/journeys/{journey_id}/party/invite", headers=org_h)
    ).json()["invite_token"]

    # Join 2 more pax -> total 4 (allowed under Free tier)
    j1_tok = await _login_user(client, fake_messaging, "9876543301")
    r_join_4 = await client.post(
        "/v1/party/join",
        headers={"Authorization": f"Bearer {j1_tok}"},
        json={"invite_token": invite_token, "mode": "train", "pnr": "4512890341"},
    )
    assert r_join_4.status_code == 200
    assert r_join_4.json()["party"]["member_count"] == 4

    # 5th member hits 402 organiser_pass_required
    j2_tok = await _login_user(client, fake_messaging, "9876543302")
    r_join_5_blocked = await client.post(
        "/v1/party/join",
        headers={"Authorization": f"Bearer {j2_tok}"},
        json={"invite_token": invite_token, "mode": "train", "pnr": "2415678902"},
    )
    assert r_join_5_blocked.status_code == 402
    assert r_join_5_blocked.json()["code"] == "organiser_pass_required"

    # Organiser summary also gated with 402 before pass
    summary_blocked = await client.get(f"/v1/parties/{party_id}/organiser-summary", headers=org_h)
    assert summary_blocked.status_code == 402

    # Checkout enforces server-side price (19900 paise) and rejects free_passenger
    bad_checkout = await client.post(
        "/v1/billing/checkout",
        headers=org_h,
        json={"plan_code": "free_passenger"},
    )
    assert bad_checkout.status_code == 422

    chk = await client.post(
        "/v1/billing/checkout",
        headers=org_h,
        json={
            "plan_code": "group_organiser_pass",
            "journey_instance_id": journey_id,
            "party_id": party_id,
            "idempotency_key": "pass-trip-1",
        },
    )
    assert chk.status_code == 200
    order = chk.json()
    assert order["amount_paise"] == 19900
    assert order["currency"] == "INR"

    # Sandbox completion activates entitlement
    sbx = await client.post(
        "/v1/billing/sandbox/complete",
        headers=org_h,
        json={"order_id": order["order_id"], "outcome": "paid"},
    )
    assert sbx.status_code == 200
    assert sbx.json()["status"] == "paid"
    assert sbx.json()["entitlement"]["plan_code"] == "group_organiser_pass"

    # Now 5th member join + organiser-summary succeed!
    r_join_5_ok = await client.post(
        "/v1/party/join",
        headers={"Authorization": f"Bearer {j2_tok}"},
        json={"invite_token": invite_token, "mode": "train", "pnr": "2415678902"},
    )
    assert r_join_5_ok.status_code == 200
    assert r_join_5_ok.json()["party"]["member_count"] == 5

    summary_ok = await client.get(f"/v1/parties/{party_id}/organiser-summary", headers=org_h)
    assert summary_ok.status_code == 200
    assert summary_ok.json()["member_count"] == 5


async def test_webhook_hmac_verification_idempotency_and_b2b_stats(
    client: AsyncClient,
    fake_messaging: FakeMessagingProvider,
) -> None:
    partner_tok = await _login_user(client, fake_messaging, "9876543310")
    partner_h = {"Authorization": f"Bearer {partner_tok}"}

    chk = (
        await client.post(
            "/v1/billing/checkout",
            headers=partner_h,
            json={"plan_code": "b2b_partner", "idempotency_key": "b2b-1"},
        )
    ).json()

    payload = json.dumps(
        {
            "event_id": "evt_test_001",
            "event": "payment.captured",
            "order_id": chk["order_id"],
            "provider_order_id": chk["provider_order_id"],
            "provider_payment_id": "pay_test_001",
        }
    ).encode("utf-8")

    # Invalid signature rejected with 401
    bad_wh = await client.post(
        "/v1/webhooks/payments",
        content=payload,
        headers={"X-Razorpay-Signature": "deadbeef", "Content-Type": "application/json"},
    )
    assert bad_wh.status_code == 401
    assert bad_wh.json()["code"] == "invalid_webhook_signature"

    app: Any = client.app  # type: ignore[attr-defined]
    provider: SandboxPaymentAdapter = app.state.payment_provider
    valid_sig = provider.sign_webhook_payload(payload)

    ok_wh = await client.post(
        "/v1/webhooks/payments",
        content=payload,
        headers={"X-Razorpay-Signature": valid_sig, "Content-Type": "application/json"},
    )
    assert ok_wh.status_code == 200
    assert ok_wh.json()["duplicate"] is False

    # Replay returns duplicate=True
    dup_wh = await client.post(
        "/v1/webhooks/payments",
        content=payload,
        headers={"X-Razorpay-Signature": valid_sig, "Content-Type": "application/json"},
    )
    assert dup_wh.status_code == 200
    assert dup_wh.json()["duplicate"] is True

    # Issue B2B API key and query /v1/b2b/stats
    key_resp = await client.post(
        "/v1/b2b/keys",
        headers=partner_h,
        json={"partner_name": "RailYatri Partner"},
    )
    assert key_resp.status_code == 200
    api_key = key_resp.json()["api_key"]

    stats_resp = await client.get("/v1/b2b/stats", headers={"X-API-Key": api_key})
    assert stats_resp.status_code == 200
    assert stats_resp.json()["partner_name"] == "RailYatri Partner"
    assert stats_resp.json()["anti_seat_sale_guarantee"] is True

    # Expired B2B entitlement is rejected by create_b2b_api_key and get_b2b_stats (bearer mode)
    async with app.state.session_factory() as db:
        await db.execute(
            update(Entitlement)
            .where(Entitlement.plan_code == "b2b_partner")
            .values(valid_until=datetime.now(UTC) - timedelta(minutes=5))
        )
        await db.commit()

    expired_key_resp = await client.post(
        "/v1/b2b/keys",
        headers=partner_h,
        json={"partner_name": "Expired Partner"},
    )
    assert expired_key_resp.status_code == 403
    assert expired_key_resp.json()["code"] == "b2b_entitlement_required"

    expired_stats_resp = await client.get("/v1/b2b/stats", headers=partner_h)
    assert expired_stats_resp.status_code == 403
    assert expired_stats_resp.json()["code"] == "b2b_entitlement_required"

    expired_key_stats_resp = await client.get("/v1/b2b/stats", headers={"X-API-Key": api_key})
    assert expired_key_stats_resp.status_code == 403
    assert expired_key_stats_resp.json()["code"] == "b2b_entitlement_required"


def test_sandbox_route_omitted_when_razorpay_or_production() -> None:
    rzp_settings = Settings(
        env="test",
        payment_provider="razorpay",
        razorpay_key_id="rzp_test_123",
        razorpay_key_secret="secret",
        razorpay_webhook_secret="whsec",
    )
    app_rzp = create_app(settings=rzp_settings, yaml_configs=load_yaml_configs())
    paths = {getattr(r, "path", "") for r in app_rzp.routes}
    assert "/v1/billing/sandbox/complete" not in paths
