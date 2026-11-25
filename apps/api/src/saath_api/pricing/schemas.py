from __future__ import annotations

from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class PricingPlanDTO(BaseModel):
    code: str
    name: str
    price_inr_paise: int
    currency: str
    billing_type: Literal["free", "per_trip", "subscription"]
    scope: str | None = None
    max_party_members: int
    organiser_dashboard: bool
    summary_export: bool
    b2b_api: bool
    widget_access: bool
    priority_seat_bump: bool


class PricingPlansResponse(BaseModel):
    plans: list[PricingPlanDTO]
    anti_seat_sale_guarantee: bool = True


class EntitlementDTO(BaseModel):
    id: UUID
    plan_code: str
    order_id: UUID | None = None
    scope_journey_instance_id: UUID | None = None
    scope_party_id: UUID | None = None
    features: dict[str, Any]
    status: Literal["active", "expired", "revoked"]
    valid_from: datetime
    valid_until: datetime | None = None
    created_at: datetime


class B2BApiKeyMetaDTO(BaseModel):
    id: UUID
    partner_name: str
    key_prefix: str
    scopes: list[str]
    rate_limit_rpm: int
    status: Literal["active", "revoked"]
    created_at: datetime


class MyEntitlementsResponse(BaseModel):
    entitlements: list[EntitlementDTO]
    b2b_api_keys: list[B2BApiKeyMetaDTO]
    free_party_limit: int


class CheckoutRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    plan_code: str = Field(min_length=2, max_length=64)
    journey_instance_id: UUID | None = None
    party_id: UUID | None = None
    idempotency_key: str | None = Field(default=None, min_length=4, max_length=128)


class CheckoutResponse(BaseModel):
    order_id: UUID
    plan_code: str
    provider: Literal["sandbox", "razorpay"]
    provider_order_id: str
    amount_paise: int
    currency: str
    checkout_mode: str
    key_id: str | None = None
    status: Literal["created", "pending", "paid", "failed", "refunded"]


class SandboxCompleteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    order_id: UUID
    outcome: Literal["paid", "failed"] = "paid"


class SandboxCompleteResponse(BaseModel):
    ok: bool
    order_id: UUID
    status: Literal["paid", "failed"]
    entitlement: EntitlementDTO | None = None
    b2b_api_key: str | None = None


class WebhookAckResponse(BaseModel):
    ok: bool = True
    duplicate: bool = False


class CreateB2BKeyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    partner_name: str = Field(min_length=2, max_length=80)
    scopes: list[str] = Field(default_factory=lambda: ["stats:read", "widget:embed"])


class B2BKeyCreatedResponse(BaseModel):
    id: UUID
    partner_name: str
    key_prefix: str
    api_key: str
    scopes: list[str]
    rate_limit_rpm: int
    created_at: datetime


class B2BStatsResponse(BaseModel):
    partner_name: str
    total_journeys: int
    verified_bookings: int
    active_parties: int
    supported_modes: list[str]
    anti_seat_sale_guarantee: bool = True
