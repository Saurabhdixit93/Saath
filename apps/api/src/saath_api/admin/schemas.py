from __future__ import annotations

from datetime import date, datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class AdminSessionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    email: str | None = Field(default=None, max_length=320)
    id_token: str | None = Field(default=None, max_length=8192)
    code: str | None = Field(default=None, max_length=2048)
    redirect_uri: str | None = Field(default=None, max_length=1024)


class AdminSessionResponse(BaseModel):
    access: str
    token: str
    token_type: Literal["bearer"] = "bearer"
    expires_in: int
    email: str
    scopes: list[str]


class NotificationDeliveryStats(BaseModel):
    total: int
    queued: int
    sent: int
    dead_letter: int
    delivery_rate: float


class RouteFunnelItem(BaseModel):
    route: str
    mode: str
    carrier_code: str
    service_no: str
    journeys: int
    verified: int
    goal_set: int
    matched: int
    swap_created: int
    swap_confirmed: int
    swap_completed: int
    match_rate: float


class FunnelAnalyticsResponse(BaseModel):
    from_date: date | None = None
    to_date: date | None = None
    route: str | None = None
    verified: int
    goal_set: int
    matched: int
    swap_created: int
    swap_confirmed: int
    swap_completed: int
    match_rate: float
    notification_delivery: NotificationDeliveryStats
    routes: list[RouteFunnelItem]


class ProviderHealthItem(BaseModel):
    name: str
    category: str
    mode: str
    circuit_state: Literal["closed", "open"]
    failures: int
    open_ttl_seconds: int


class OutboxHealthStats(BaseModel):
    queued: int
    sent: int
    dead_letter: int
    lag_seconds: float


class ProvidersHealthResponse(BaseModel):
    providers: list[ProviderHealthItem]
    outbox: OutboxHealthStats


class ModerationQueueItem(BaseModel):
    report_id: UUID
    status: str
    reason: str
    created_at: datetime
    reporter_id: UUID
    target_user_id: UUID
    target_user_status: str
    target_display_alias: str | None = None
    conversation_id: UUID | None = None
    journey_instance_id: UUID | None = None
    message_id: UUID | None = None
    message_body: str | None = None
    message_moderation: str | None = None
    message_moderation_reason: str | None = None


class ModerationQueueResponse(BaseModel):
    items: list[ModerationQueueItem]
    total: int


class ModerationActionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    action: Literal["dismiss", "hide", "restrict", "ban"]
    note: str | None = Field(default=None, max_length=500)


class ModerationActionResponse(BaseModel):
    report_id: UUID
    report_status: str
    target_user_id: UUID
    target_user_status: str
    message_moderation: str | None = None
    revoked_tokens: int
    invalidated_swaps: int


class FraudNodeDTO(BaseModel):
    user_id: UUID
    display_alias: str | None = None
    status: str
    karma_credited: int
    karma_reversed: int


class FraudEdgeDTO(BaseModel):
    user_a: UUID
    user_b: UUID
    swap_count: int
    completed_count: int
    credited_count: int
    reversed_count: int
    flagged: bool
    reasons: list[str]


class SharedDeviceClusterDTO(BaseModel):
    fingerprint_hash: str
    signal: Literal["push_endpoint", "push_p256dh"]
    user_ids: list[UUID]


class FraudAnomalyDTO(BaseModel):
    id: int
    action: str
    resource: str
    meta: dict[str, Any] | None = None
    at: datetime


class FraudGraphResponse(BaseModel):
    nodes: list[FraudNodeDTO]
    edges: list[FraudEdgeDTO]
    flagged_pairs: list[FraudEdgeDTO]
    shared_devices: list[SharedDeviceClusterDTO]
    anomalies: list[FraudAnomalyDTO]


class FeatureFlagDTO(BaseModel):
    key: str
    value: Any
    description: str | None = None
    updated_by: str | None = None
    updated_at: datetime


class FeatureFlagListResponse(BaseModel):
    items: list[FeatureFlagDTO]


class UpdateFeatureFlagRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    value: Any
    description: str | None = Field(default=None, max_length=500)


class DisputeParticipantDTO(BaseModel):
    user_id: UUID | None = None
    alias: str
    gives_seat: str
    gets_seat: str
    decision: str
    post_confirm: str | None = None


class AdminDisputeItemDTO(BaseModel):
    dispute_id: UUID
    dispute_type: Literal["swap_dispute", "claim_conflict"]
    status: str
    journey_instance_id: UUID
    service: str
    service_date: date
    participants: list[DisputeParticipantDTO]
    claim_conflict_flagged: bool
    created_at: datetime


class AdminDisputeListResponse(BaseModel):
    items: list[AdminDisputeItemDTO]
    total: int


class DisputeOverrideRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    action: Literal["complete", "not_completed", "reverse_karma", "clear_conflict", "dismiss"]
    note: str | None = Field(default=None, max_length=500)


class DisputeOverrideResponse(BaseModel):
    dispute_id: UUID
    dispute_type: Literal["swap_dispute", "claim_conflict"]
    status: str
    karma_reversed_users: list[UUID]
    karma_credited_users: list[UUID]


class AdminRedemptionDTO(BaseModel):
    id: UUID
    user_id: UUID | None = None
    user_display_alias: str | None = None
    reward_code: str
    title_en: str
    points_spent: int
    status: str
    reviewed_by: str | None = None
    created_at: datetime
    updated_at: datetime


class AdminRedemptionListResponse(BaseModel):
    items: list[AdminRedemptionDTO]
    total: int


class RedemptionReviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    action: Literal["approve", "fulfill", "reject", "cancel"]
    note: str | None = Field(default=None, max_length=500)


class AuditLogItemDTO(BaseModel):
    id: int
    actor: str
    action: str
    resource: str
    meta: dict[str, Any] | None = None
    at: datetime


class AuditLogListResponse(BaseModel):
    items: list[AuditLogItemDTO]
    total: int
    limit: int
    offset: int
