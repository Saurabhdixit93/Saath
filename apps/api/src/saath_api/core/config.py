from __future__ import annotations

import base64
import binascii
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal

import yaml
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ed25519
from pydantic import BaseModel, Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


def _generate_dev_ed25519_pair() -> tuple[str, str]:
    private_key = ed25519.Ed25519PrivateKey.generate()
    private_pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("utf-8")
    public_pem = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode("utf-8")
    return private_pem, public_pem


_DEV_ED25519_PAIR: tuple[str, str] | None = None


def _get_dev_ed25519_pair() -> tuple[str, str]:
    global _DEV_ED25519_PAIR
    if _DEV_ED25519_PAIR is None:
        _DEV_ED25519_PAIR = _generate_dev_ed25519_pair()
    return _DEV_ED25519_PAIR


def _default_config_dir() -> Path:
    return Path(__file__).resolve().parents[3] / "config"


class AuthRateLimitConfig(BaseModel):
    anonymous_per_ip_per_minute: int = 20
    otp_start_per_ip_per_minute: int = 5
    otp_start_per_phone_per_hour: int = 5
    otp_resend_cooldown_seconds: int = 30
    otp_ttl_seconds: int = 60
    otp_max_attempts: int = 5


class VerifyRateLimitConfig(BaseModel):
    per_ip_per_minute: int = 10
    per_user_per_day: int = 30


class MessagesRateLimitConfig(BaseModel):
    new_account_age_days: int = 7
    per_day: int = 5


class SimpleDailyLimitConfig(BaseModel):
    per_user_per_day: int


class RateLimitsConfig(BaseModel):
    auth: AuthRateLimitConfig
    verify: VerifyRateLimitConfig
    messages_new_partner: MessagesRateLimitConfig
    swaps_created: SimpleDailyLimitConfig
    ai: SimpleDailyLimitConfig


class ChartRulesDefault(BaseModel):
    morning_window_start_ist: str
    morning_window_end_ist: str
    morning_chart_previous_day_ist: str
    standard_hours_before_departure: int
    poll_interval_minutes: int
    final_reverify_minutes_before_departure: int


class ChartRulesConfig(BaseModel):
    default: ChartRulesDefault
    overrides: dict[str, Any] = Field(default_factory=dict)


class KarmaCapsConfig(BaseModel):
    per_user_per_day: int
    same_pair_per_90d: int


class KarmaConfig(BaseModel):
    train: dict[str, int]
    flight: dict[str, int]
    bonus: dict[str, int]
    caps: KarmaCapsConfig
    credit_rule: str


class PlanDefinition(BaseModel):
    code: str
    name: str
    price_inr_paise: int
    currency: str = "INR"
    billing_type: Literal["free", "per_trip", "subscription"]
    scope: str | None = None
    max_party_members: int
    organiser_dashboard: bool = False
    summary_export: bool = False
    b2b_api: bool = False
    widget_access: bool = False
    priority_seat_bump: bool = False


class PlansConfig(BaseModel):
    plans: dict[str, PlanDefinition]


class YamlConfigBundle(BaseModel):
    rate_limits: RateLimitsConfig
    chart_rules: ChartRulesConfig
    karma: KarmaConfig
    plans: PlansConfig


def load_yaml_configs(config_dir: Path | None = None) -> YamlConfigBundle:
    base_dir = config_dir or _default_config_dir()

    def _read_yaml(name: str) -> dict[str, Any]:
        path = base_dir / name
        if not path.exists():
            raise FileNotFoundError(f"Missing required config file: {path}")
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            raise ValueError(f"Config file {path} must parse to a YAML mapping")
        return raw

    plans_bundle = PlansConfig.model_validate(_read_yaml("plans.yaml"))
    for plan_code, plan in plans_bundle.plans.items():
        if plan.priority_seat_bump:
            raise ValueError(
                f"Plan {plan_code!r} violates anti-seat-sale invariant: priority_seat_bump must be false"
            )

    return YamlConfigBundle(
        rate_limits=RateLimitsConfig.model_validate(_read_yaml("rate_limits.yaml")),
        chart_rules=ChartRulesConfig.model_validate(_read_yaml("chart_rules.yaml")),
        karma=KarmaConfig.model_validate(_read_yaml("karma.yaml")),
        plans=plans_bundle,
    )


_DEV_PNR_PEPPER = "dev-pnr-pepper-change-in-production-32b"
_DEV_PHONE_AES_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="
_DEV_PHONE_BLIND_INDEX_KEY = "YWJjZGVmMDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODk="
_DEV_INVITE_TOKEN_SECRET = "dev-invite-token-secret-change-in-production"


def _validate_b64_32bytes(value: str, field_name: str) -> None:
    try:
        raw = base64.b64decode(value.encode("ascii"), validate=True)
    except (UnicodeEncodeError, binascii.Error, ValueError) as exc:
        raise ValueError(f"{field_name} must be valid base64 encoding 32 bytes") from exc
    if len(raw) != 32:
        raise ValueError(f"{field_name} must decode to exactly 32 bytes (got {len(raw)})")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(".env", "../../.env"),
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    env: Literal["development", "staging", "production", "test"] = "development"
    app_url: str = "http://localhost:3000"
    api_base_url: str = "http://localhost:8000"
    admin_url: str = "http://localhost:3001"
    cors_origins: str = "http://localhost:3000,http://localhost:3001"
    trusted_proxies: str = "127.0.0.1,::1"
    log_level: str = "INFO"
    otel_exporter_otlp_endpoint: str = ""
    otel_service_name: str = "saath-api"

    database_url: str = "postgresql+asyncpg://saath:saath@127.0.0.1:5432/saath"
    database_read_url: str = ""
    redis_url: str = "redis://127.0.0.1:6379/0"

    jwt_private_key: str = ""
    jwt_public_key: str = ""
    jwt_access_ttl_seconds: int = 900
    jwt_anon_ttl_seconds: int = 7200
    refresh_token_ttl_days: int = 30

    pnr_pepper: str = _DEV_PNR_PEPPER
    phone_aes_key: str = _DEV_PHONE_AES_KEY
    phone_blind_index_key: str = _DEV_PHONE_BLIND_INDEX_KEY
    invite_token_secret: str = _DEV_INVITE_TOKEN_SECRET

    turnstile_mode: Literal["fake", "cloudflare"] = "fake"
    turnstile_site_key: str = ""
    turnstile_secret_key: str = ""

    rail_provider_mode: Literal["fake", "live"] = "fake"
    provider_rail_a_base_url: str = ""
    provider_rail_a_api_key: str = ""
    provider_rail_b_base_url: str = ""
    provider_rail_b_api_key: str = ""
    provider_rail_timeout_ms: int = 3000

    flight_provider_mode: Literal["fake", "live"] = "fake"
    provider_flight_base_url: str = ""
    provider_flight_api_key: str = ""

    whatsapp_mode: Literal["fake", "live"] = "fake"
    whatsapp_access_token: str = ""
    whatsapp_phone_number_id: str = ""
    whatsapp_app_secret: str = ""
    whatsapp_verify_token: str = ""

    sms_mode: Literal["fake", "msg91"] = "fake"
    msg91_auth_key: str = ""
    msg91_sender_id: str = "SAATHI"
    msg91_dlt_te_id_otp: str = ""

    ai_mode: Literal["fake", "anthropic"] = "fake"
    anthropic_api_key: str = ""
    anthropic_fast_model: str = "claude-haiku-5-5"

    payment_provider: Literal["sandbox", "razorpay"] = "sandbox"
    razorpay_key_id: str = ""
    razorpay_key_secret: str = ""
    razorpay_webhook_secret: str = ""

    config_dir: Path = Field(default_factory=_default_config_dir)

    @model_validator(mode="after")
    def _validate_and_fill_keys(self) -> Settings:
        if self.jwt_private_key:
            self.jwt_private_key = self.jwt_private_key.replace("\\n", "\n")
        if self.jwt_public_key:
            self.jwt_public_key = self.jwt_public_key.replace("\\n", "\n")

        _validate_b64_32bytes(self.phone_aes_key, "PHONE_AES_KEY")
        _validate_b64_32bytes(self.phone_blind_index_key, "PHONE_BLIND_INDEX_KEY")

        if self.env == "production":
            if not self.jwt_private_key or not self.jwt_public_key:
                raise ValueError(
                    "JWT_PRIVATE_KEY and JWT_PUBLIC_KEY are mandatory when ENV=production"
                )
            if self.phone_aes_key == _DEV_PHONE_AES_KEY:
                raise ValueError("PHONE_AES_KEY dev default is forbidden when ENV=production")
            if self.phone_blind_index_key == _DEV_PHONE_BLIND_INDEX_KEY:
                raise ValueError(
                    "PHONE_BLIND_INDEX_KEY dev default is forbidden when ENV=production"
                )
            if not self.pnr_pepper or self.pnr_pepper == _DEV_PNR_PEPPER:
                raise ValueError("PNR_PEPPER dev default is forbidden when ENV=production")
            if not self.invite_token_secret or self.invite_token_secret == _DEV_INVITE_TOKEN_SECRET:
                raise ValueError("INVITE_TOKEN_SECRET dev default is forbidden when ENV=production")
            if self.turnstile_mode == "fake":
                raise ValueError("TURNSTILE_MODE=fake is forbidden when ENV=production")
            if self.whatsapp_mode == "fake":
                raise ValueError("WHATSAPP_MODE=fake is forbidden when ENV=production")
            if self.sms_mode == "fake":
                raise ValueError("SMS_MODE=fake is forbidden when ENV=production")
            if self.rail_provider_mode == "fake":
                raise ValueError("RAIL_PROVIDER_MODE=fake is forbidden when ENV=production")
            if self.flight_provider_mode == "fake":
                raise ValueError("FLIGHT_PROVIDER_MODE=fake is forbidden when ENV=production")
            if self.ai_mode == "fake":
                raise ValueError("AI_MODE=fake is forbidden when ENV=production")
            if self.payment_provider == "sandbox":
                raise ValueError("PAYMENT_PROVIDER=sandbox is forbidden when ENV=production")
            if self.payment_provider == "razorpay" and (
                not self.razorpay_key_id
                or not self.razorpay_key_secret
                or not self.razorpay_webhook_secret
            ):
                raise ValueError(
                    "RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, and RAZORPAY_WEBHOOK_SECRET "
                    "are mandatory when ENV=production and PAYMENT_PROVIDER=razorpay"
                )
        else:
            if not self.jwt_private_key or not self.jwt_public_key:
                priv, pub = _get_dev_ed25519_pair()
                self.jwt_private_key = priv
                self.jwt_public_key = pub

        return self

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def trusted_proxy_list(self) -> list[str]:
        return [p.strip() for p in self.trusted_proxies.split(",") if p.strip()]

    @property
    def is_production(self) -> bool:
        return self.env == "production"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


@lru_cache(maxsize=1)
def get_yaml_configs() -> YamlConfigBundle:
    return load_yaml_configs(get_settings().config_dir)
