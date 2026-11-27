from __future__ import annotations

import base64
from typing import cast

import pytest
from pydantic import ValidationError
from redis.asyncio import Redis

from saath_api.core.config import Settings, load_yaml_configs
from saath_api.main import create_app
from saath_api.providers.flight.schedule import (
    FakeFlightScheduleProvider,
    LiveFlightScheduleProvider,
    build_flight_schedule_provider,
)
from saath_api.providers.llm import AnthropicClaudeAdapter, build_llm_provider
from saath_api.providers.messaging import (
    ChannelRoutingMessagingProvider,
    MSG91SMSAdapter,
    WhatsAppCloudAdapter,
    build_messaging_provider,
)
from saath_api.providers.payment import RazorpayPaymentAdapter, build_payment_provider
from saath_api.providers.push import VAPIDPushAdapter, build_web_push_provider
from saath_api.providers.rail import (
    FakeRailProvider,
    RailProviderA,
    RailProviderB,
    build_rail_router,
)
from saath_api.providers.turnstile import (
    CloudflareTurnstileVerifier,
    build_turnstile_verifier,
)


def _prod_base_kwargs() -> dict[str, str]:
    return {
        "env": "production",
        "jwt_private_key": "priv-key",
        "jwt_public_key": "pub-key",
        "swap_card_signing_private_key": "swap-priv-key",
        "swap_card_signing_public_key": "swap-pub-key",
        "phone_aes_key": base64.b64encode(b"a" * 32).decode("ascii"),
        "phone_blind_index_key": base64.b64encode(b"b" * 32).decode("ascii"),
        "pnr_pepper": "prod-pnr-pepper-secret-32-bytes-long",
        "invite_token_secret": "prod-invite-secret-32-bytes-long",
        "turnstile_mode": "cloudflare",
        "turnstile_secret_key": "ts-prod-secret",
        "whatsapp_mode": "live",
        "whatsapp_access_token": "wa-prod-token",
        "whatsapp_phone_number_id": "wa-phone-id",
        "whatsapp_app_secret": "wa-app-secret",
        "sms_mode": "msg91",
        "msg91_auth_key": "msg91-prod-key",
        "msg91_dlt_te_id_otp": "dlt-otp-tpl",
        "push_mode": "vapid",
        "vapid_public_key": "vapid-pub-key",
        "vapid_private_key": "vapid-priv-key",
        "rail_provider_mode": "live",
        "provider_rail_a_base_url": "https://rail-a.example",
        "flight_provider_mode": "live",
        "provider_flight_base_url": "https://flight.api.example",
        "ai_mode": "anthropic",
        "anthropic_api_key": "sk-ant-prod-test",
        "payment_provider": "razorpay",
        "razorpay_key_id": "rzp_live_123",
        "razorpay_key_secret": "rzp_secret_123",
        "razorpay_webhook_secret": "rzp_whsec_123",
    }


def test_yaml_configs_load_cleanly() -> None:
    bundle = load_yaml_configs()
    assert bundle.rate_limits.auth.otp_ttl_seconds == 60
    assert bundle.rate_limits.auth.otp_max_attempts == 5
    assert bundle.rate_limits.auth.otp_resend_cooldown_seconds == 30
    assert bundle.chart_rules.default.standard_hours_before_departure == 10
    assert bundle.karma.train["LB"] == 100
    assert bundle.karma.caps.per_user_per_day == 300
    assert bundle.plans.plans["free_passenger"].price_inr_paise == 0
    assert bundle.plans.plans["group_organiser_pass"].price_inr_paise == 19900
    assert bundle.plans.plans["group_organiser_pass"].priority_seat_bump is False


def test_production_forbids_missing_keys_and_fake_modes() -> None:
    # Valid production config succeeds
    prod = Settings(**_prod_base_kwargs())  # type: ignore[arg-type]
    assert prod.is_production is True

    with pytest.raises(ValidationError):
        Settings(env="production", jwt_private_key="", jwt_public_key="")

    for field, bad_val in (
        ("jwt_private_key", "   "),
        ("jwt_public_key", "   "),
        ("swap_card_signing_private_key", ""),
        ("swap_card_signing_private_key", "   "),
        ("swap_card_signing_public_key", ""),
        ("swap_card_signing_public_key", "   "),
        ("turnstile_mode", "fake"),
        ("turnstile_secret_key", ""),
        ("turnstile_secret_key", "   "),
        ("whatsapp_mode", "fake"),
        ("whatsapp_access_token", ""),
        ("whatsapp_access_token", "   "),
        ("whatsapp_phone_number_id", ""),
        ("whatsapp_phone_number_id", "   "),
        ("whatsapp_app_secret", ""),
        ("whatsapp_app_secret", "   "),
        ("whatsapp_app_secret", "dev-whatsapp-secret"),
        ("sms_mode", "fake"),
        ("msg91_auth_key", ""),
        ("msg91_auth_key", "   "),
        ("msg91_sender_id", ""),
        ("msg91_sender_id", "   "),
        ("msg91_dlt_te_id_otp", ""),
        ("msg91_dlt_te_id_otp", "   "),
        ("push_mode", "fake"),
        ("vapid_private_key", ""),
        ("vapid_private_key", "   "),
        ("vapid_public_key", ""),
        ("vapid_public_key", "   "),
        ("rail_provider_mode", "fake"),
        ("provider_rail_a_base_url", ""),
        ("provider_rail_a_base_url", "   "),
        ("flight_provider_mode", "fake"),
        ("provider_flight_base_url", ""),
        ("provider_flight_base_url", "   "),
        ("ai_mode", "fake"),
        ("anthropic_api_key", ""),
        ("anthropic_api_key", "   "),
        ("payment_provider", "sandbox"),
        ("razorpay_key_id", ""),
        ("razorpay_key_id", "   "),
        ("razorpay_key_secret", ""),
        ("razorpay_key_secret", "   "),
        ("razorpay_webhook_secret", ""),
        ("razorpay_webhook_secret", "   "),
        ("phone_aes_key", "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="),
        ("phone_blind_index_key", "YWJjZGVmMDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODk="),
        ("pnr_pepper", "   "),
        ("pnr_pepper", "dev-pnr-pepper-change-in-production-32b"),
        ("invite_token_secret", "   "),
        ("invite_token_secret", "dev-invite-token-secret-change-in-production"),
    ):
        kwargs = _prod_base_kwargs()
        kwargs[field] = bad_val
        with pytest.raises(ValidationError):
            Settings(**kwargs)  # type: ignore[arg-type]


def test_provider_factories_never_return_fake_or_sandbox_in_production() -> None:
    dummy_redis = cast(Redis, object())

    # 1. Flight schedule provider factory (even when bypassing Settings validation)
    for bad_flight_settings in (
        Settings.model_construct(
            env="production",
            flight_provider_mode="live",
            provider_flight_base_url="",
            provider_flight_api_key="",
        ),
        Settings.model_construct(
            env="production",
            flight_provider_mode="live",
            provider_flight_base_url="   ",
            provider_flight_api_key="",
        ),
        Settings.model_construct(
            env="production",
            flight_provider_mode="fake",
            provider_flight_base_url="https://flight.api.example",
            provider_flight_api_key="",
        ),
    ):
        with pytest.raises(RuntimeError):
            build_flight_schedule_provider(bad_flight_settings)

    live_flight = build_flight_schedule_provider(
        Settings.model_construct(
            env="production",
            flight_provider_mode="live",
            provider_flight_base_url="https://flight.api.example",
            provider_flight_api_key="flt-key",
        )
    )
    assert isinstance(live_flight, LiveFlightScheduleProvider)

    # Non-production preserves FakeFlightScheduleProvider fallback
    dev_flight = build_flight_schedule_provider(
        Settings(env="test", flight_provider_mode="live", provider_flight_base_url="")
    )
    assert isinstance(dev_flight, FakeFlightScheduleProvider)

    # 2. Payment provider factory
    with pytest.raises(RuntimeError):
        build_payment_provider(
            Settings.model_construct(
                env="production",
                payment_provider="sandbox",
                razorpay_key_id="",
                razorpay_key_secret="",
                razorpay_webhook_secret="",
            )
        )

    # 3. Rail router factory
    for bad_rail_settings in (
        Settings.model_construct(
            env="production",
            rail_provider_mode="fake",
            provider_rail_a_base_url="https://rail-a.example",
            provider_rail_a_api_key="",
            provider_rail_b_base_url="",
            provider_rail_b_api_key="",
            provider_rail_timeout_ms=3000,
            pnr_pepper="prod-pnr-pepper-secret-32-bytes-long",
        ),
        Settings.model_construct(
            env="production",
            rail_provider_mode="live",
            provider_rail_a_base_url="",
            provider_rail_a_api_key="",
            provider_rail_b_base_url="   ",
            provider_rail_b_api_key="",
            provider_rail_timeout_ms=3000,
            pnr_pepper="prod-pnr-pepper-secret-32-bytes-long",
        ),
    ):
        with pytest.raises(RuntimeError):
            build_rail_router(bad_rail_settings, dummy_redis)

    live_rail_router = build_rail_router(
        Settings.model_construct(
            env="production",
            rail_provider_mode="live",
            provider_rail_a_base_url="https://rail-a.example",
            provider_rail_a_api_key="rail-a-key",
            provider_rail_b_base_url="",
            provider_rail_b_api_key="",
            provider_rail_timeout_ms=3000,
            pnr_pepper="prod-pnr-pepper-secret-32-bytes-long",
        ),
        dummy_redis,
    )
    assert len(live_rail_router._providers) == 1
    assert isinstance(live_rail_router._providers[0], RailProviderA)
    assert not any(isinstance(p, FakeRailProvider) for p in live_rail_router._providers)

    # 4. Messaging, WebPush, LLM, Turnstile factories
    with pytest.raises(RuntimeError):
        build_messaging_provider(
            Settings.model_construct(
                env="production",
                whatsapp_mode="fake",
                sms_mode="msg91",
                msg91_auth_key="k",
                msg91_sender_id="SAATHI",
                msg91_dlt_te_id_otp="tpl",
                msg91_dlt_te_id_notify="tpl2",
            )
        )
    with pytest.raises(RuntimeError):
        build_messaging_provider(
            Settings.model_construct(
                env="production",
                whatsapp_mode="live",
                whatsapp_access_token="tok",
                whatsapp_phone_number_id="pnid",
                sms_mode="fake",
            )
        )
    with pytest.raises(RuntimeError):
        build_web_push_provider(
            Settings.model_construct(
                env="production",
                push_mode="fake",
                vapid_private_key="",
                vapid_subject="mailto:privacy@saath.example",
            )
        )
    with pytest.raises(RuntimeError):
        build_llm_provider(
            Settings.model_construct(
                env="production",
                ai_mode="fake",
                anthropic_api_key="",
                anthropic_fast_model="claude-haiku-5-5",
            )
        )
    with pytest.raises(RuntimeError):
        build_turnstile_verifier(
            Settings.model_construct(
                env="production",
                turnstile_mode="fake",
                turnstile_secret_key="",
            )
        )

    # 5. Full production create_app() wires live adapters only and omits sandbox route
    full_prod_kwargs = {
        **_prod_base_kwargs(),
        "turnstile_secret_key": "ts-prod-secret",
        "whatsapp_access_token": "wa-prod-token",
        "whatsapp_phone_number_id": "wa-phone-id",
        "msg91_auth_key": "msg91-prod-key",
        "msg91_dlt_te_id_otp": "dlt-otp-tpl",
        "anthropic_api_key": "sk-ant-prod-test",
        "provider_rail_a_base_url": "https://rail-a.example",
    }
    full_prod_settings = Settings(**full_prod_kwargs)  # type: ignore[arg-type]
    app = create_app(settings=full_prod_settings, yaml_configs=load_yaml_configs())
    assert isinstance(app.state.turnstile_verifier, CloudflareTurnstileVerifier)
    assert isinstance(app.state.messaging_provider, ChannelRoutingMessagingProvider)
    assert isinstance(app.state.flight_schedule_provider, LiveFlightScheduleProvider)
    assert isinstance(app.state.payment_provider, RazorpayPaymentAdapter)
    assert isinstance(app.state.llm_provider, AnthropicClaudeAdapter)
    assert isinstance(app.state.web_push_provider, VAPIDPushAdapter)
    route_paths = {getattr(r, "path", "") for r in app.routes}
    assert "/v1/billing/sandbox/complete" not in route_paths


def test_startup_validates_base64_32byte_keys() -> None:
    with pytest.raises(ValidationError):
        Settings(env="test", phone_aes_key="not-valid-base64!")

    with pytest.raises(ValidationError):
        Settings(
            env="test",
            phone_blind_index_key=base64.b64encode(b"short-key").decode("ascii"),
        )


def test_live_adapters_reject_whitespace_credentials() -> None:
    with pytest.raises(ValueError):
        RazorpayPaymentAdapter(key_id="   ", key_secret="sec", webhook_secret="wh")
    with pytest.raises(ValueError):
        RazorpayPaymentAdapter(key_id="id", key_secret="   ", webhook_secret="wh")
    with pytest.raises(ValueError):
        RazorpayPaymentAdapter(key_id="id", key_secret="sec", webhook_secret="   ")
    with pytest.raises(ValueError):
        RazorpayPaymentAdapter(key_id="id", key_secret="sec", webhook_secret="wh", base_url="   ")
    with pytest.raises(ValueError):
        WhatsAppCloudAdapter(access_token="   ", phone_number_id="123")
    with pytest.raises(ValueError):
        WhatsAppCloudAdapter(access_token="tok", phone_number_id="   ")
    with pytest.raises(ValueError):
        MSG91SMSAdapter(auth_key="   ", sender_id="SAATHI", template_id="tpl")
    with pytest.raises(ValueError):
        MSG91SMSAdapter(auth_key="key", sender_id="   ", template_id="tpl")
    with pytest.raises(ValueError):
        MSG91SMSAdapter(auth_key="key", sender_id="SAATHI", template_id="   ")
    with pytest.raises(ValueError):
        VAPIDPushAdapter(vapid_private_key="   ", vapid_subject="mailto:a@b.com")
    with pytest.raises(ValueError):
        VAPIDPushAdapter(vapid_private_key="priv", vapid_subject="   ")
    with pytest.raises(ValueError):
        AnthropicClaudeAdapter(api_key="   ")
    with pytest.raises(ValueError):
        CloudflareTurnstileVerifier(secret_key="   ")
    with pytest.raises(ValueError):
        RailProviderA(base_url="   ", api_key="k")
    with pytest.raises(ValueError):
        RailProviderB(base_url="   ", api_key="k")
    with pytest.raises(ValueError):
        LiveFlightScheduleProvider(base_url="   ", api_key="k")
