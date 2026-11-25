from __future__ import annotations

import base64

import pytest
from pydantic import ValidationError

from saath_api.core.config import Settings, load_yaml_configs


def _prod_base_kwargs() -> dict[str, str]:
    return {
        "env": "production",
        "jwt_private_key": "priv-key",
        "jwt_public_key": "pub-key",
        "phone_aes_key": base64.b64encode(b"a" * 32).decode("ascii"),
        "phone_blind_index_key": base64.b64encode(b"b" * 32).decode("ascii"),
        "pnr_pepper": "prod-pnr-pepper-secret-32-bytes-long",
        "invite_token_secret": "prod-invite-secret-32-bytes-long",
        "turnstile_mode": "cloudflare",
        "whatsapp_mode": "live",
        "sms_mode": "msg91",
        "rail_provider_mode": "live",
        "flight_provider_mode": "live",
        "ai_mode": "anthropic",
        "payment_provider": "razorpay",
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
        ("turnstile_mode", "fake"),
        ("whatsapp_mode", "fake"),
        ("sms_mode", "fake"),
        ("rail_provider_mode", "fake"),
        ("flight_provider_mode", "fake"),
        ("ai_mode", "fake"),
        ("payment_provider", "sandbox"),
        ("phone_aes_key", "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="),
        ("phone_blind_index_key", "YWJjZGVmMDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODk="),
        ("pnr_pepper", "dev-pnr-pepper-change-in-production-32b"),
        ("invite_token_secret", "dev-invite-token-secret-change-in-production"),
    ):
        kwargs = _prod_base_kwargs()
        kwargs[field] = bad_val
        with pytest.raises(ValidationError):
            Settings(**kwargs)  # type: ignore[arg-type]


def test_startup_validates_base64_32byte_keys() -> None:
    with pytest.raises(ValidationError):
        Settings(env="test", phone_aes_key="not-valid-base64!")

    with pytest.raises(ValidationError):
        Settings(
            env="test",
            phone_blind_index_key=base64.b64encode(b"short-key").decode("ascii"),
        )
