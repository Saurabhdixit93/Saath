from __future__ import annotations

from datetime import date
from typing import Literal, cast
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from saath_api.admin.schemas import (
    AdminDisputeListResponse,
    AdminRedemptionDTO,
    AdminRedemptionListResponse,
    AdminSessionRequest,
    AdminSessionResponse,
    AuditLogListResponse,
    DisputeOverrideRequest,
    DisputeOverrideResponse,
    FeatureFlagDTO,
    FeatureFlagListResponse,
    FraudGraphResponse,
    FunnelAnalyticsResponse,
    ModerationActionRequest,
    ModerationActionResponse,
    ModerationQueueResponse,
    ProvidersHealthResponse,
    RedemptionReviewRequest,
    UpdateFeatureFlagRequest,
)
from saath_api.admin.service import (
    OidcVerifierFn,
    act_on_moderation,
    create_admin_session,
    get_fraud_graph,
    get_funnel_analytics,
    get_moderation_queue,
    get_providers_health,
    list_audit_logs,
    list_disputes,
    list_feature_flags,
    list_redemptions,
    override_dispute,
    review_redemption,
    update_feature_flag,
)
from saath_api.auth.dependencies import Actor, get_request_settings, require_admin_actor
from saath_api.core.config import YamlConfigBundle
from saath_api.core.db import get_db
from saath_api.core.errors import openapi_error_responses

router = APIRouter(prefix="/v1/admin", tags=["admin"])


@router.post(
    "/auth/session",
    response_model=AdminSessionResponse,
    responses=openapi_error_responses(
        status.HTTP_401_UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN,
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        status.HTTP_503_SERVICE_UNAVAILABLE,
    ),
)
async def post_v1_admin_auth_session(
    body: AdminSessionRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> AdminSessionResponse:
    settings = get_request_settings(request)
    verifier = cast(
        OidcVerifierFn | None,
        getattr(request.app.state, "admin_oidc_verifier", None),
    )
    return await create_admin_session(
        db=db,
        settings=settings,
        req=body,
        oidc_verifier=verifier,
    )


@router.get(
    "/analytics/funnel",
    response_model=FunnelAnalyticsResponse,
    responses=openapi_error_responses(
        status.HTTP_401_UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN,
        status.HTTP_422_UNPROCESSABLE_ENTITY,
    ),
)
async def get_v1_admin_analytics_funnel(
    route: str | None = Query(default=None, max_length=64),
    from_date: date | None = Query(default=None),
    to_date: date | None = Query(default=None),
    _actor: Actor = Depends(require_admin_actor),
    db: AsyncSession = Depends(get_db),
) -> FunnelAnalyticsResponse:
    return await get_funnel_analytics(
        db=db,
        route=route,
        from_date=from_date,
        to_date=to_date,
    )


@router.get(
    "/providers/health",
    response_model=ProvidersHealthResponse,
    responses=openapi_error_responses(
        status.HTTP_401_UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN,
    ),
)
async def get_v1_admin_providers_health(
    request: Request,
    _actor: Actor = Depends(require_admin_actor),
    db: AsyncSession = Depends(get_db),
) -> ProvidersHealthResponse:
    return await get_providers_health(request=request, db=db)


@router.get(
    "/moderation/queue",
    response_model=ModerationQueueResponse,
    responses=openapi_error_responses(
        status.HTTP_401_UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN,
        status.HTTP_422_UNPROCESSABLE_ENTITY,
    ),
)
async def get_v1_admin_moderation_queue(
    status_filter: Literal["open", "reviewed", "dismissed", "actioned", "all"] = Query(
        default="open",
        alias="status",
    ),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    actor: Actor = Depends(require_admin_actor),
    db: AsyncSession = Depends(get_db),
) -> ModerationQueueResponse:
    return await get_moderation_queue(
        db=db,
        actor=actor,
        status_filter=status_filter,
        limit=limit,
        offset=offset,
    )


@router.post(
    "/moderation/{report_id}/action",
    response_model=ModerationActionResponse,
    responses=openapi_error_responses(
        status.HTTP_401_UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN,
        status.HTTP_404_NOT_FOUND,
        status.HTTP_422_UNPROCESSABLE_ENTITY,
    ),
)
async def post_v1_admin_moderation_action(
    report_id: UUID,
    body: ModerationActionRequest,
    actor: Actor = Depends(require_admin_actor),
    db: AsyncSession = Depends(get_db),
) -> ModerationActionResponse:
    return await act_on_moderation(
        db=db,
        actor=actor,
        report_id=report_id,
        req=body,
    )


@router.get(
    "/fraud/graph",
    response_model=FraudGraphResponse,
    responses=openapi_error_responses(
        status.HTTP_401_UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN,
    ),
)
async def get_v1_admin_fraud_graph(
    actor: Actor = Depends(require_admin_actor),
    db: AsyncSession = Depends(get_db),
) -> FraudGraphResponse:
    return await get_fraud_graph(db=db, actor=actor)


@router.get(
    "/flags",
    response_model=FeatureFlagListResponse,
    responses=openapi_error_responses(
        status.HTTP_401_UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN,
    ),
)
async def get_v1_admin_flags(
    _actor: Actor = Depends(require_admin_actor),
    db: AsyncSession = Depends(get_db),
) -> FeatureFlagListResponse:
    return await list_feature_flags(db=db)


@router.patch(
    "/flags/{key}",
    response_model=FeatureFlagDTO,
    responses=openapi_error_responses(
        status.HTTP_401_UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN,
        status.HTTP_404_NOT_FOUND,
        status.HTTP_422_UNPROCESSABLE_ENTITY,
    ),
)
async def patch_v1_admin_flag(
    key: str,
    body: UpdateFeatureFlagRequest,
    actor: Actor = Depends(require_admin_actor),
    db: AsyncSession = Depends(get_db),
) -> FeatureFlagDTO:
    return await update_feature_flag(
        db=db,
        actor=actor,
        key=key,
        req=body,
    )


@router.get(
    "/disputes",
    response_model=AdminDisputeListResponse,
    responses=openapi_error_responses(
        status.HTTP_401_UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN,
        status.HTTP_422_UNPROCESSABLE_ENTITY,
    ),
)
async def get_v1_admin_disputes(
    status_filter: Literal["open", "resolved", "all"] = Query(
        default="open",
        alias="status",
    ),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    actor: Actor = Depends(require_admin_actor),
    db: AsyncSession = Depends(get_db),
) -> AdminDisputeListResponse:
    return await list_disputes(
        db=db,
        actor=actor,
        status_filter=status_filter,
        limit=limit,
        offset=offset,
    )


@router.post(
    "/disputes/{dispute_id}/override",
    response_model=DisputeOverrideResponse,
    responses=openapi_error_responses(
        status.HTTP_401_UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN,
        status.HTTP_404_NOT_FOUND,
        status.HTTP_409_CONFLICT,
        status.HTTP_422_UNPROCESSABLE_ENTITY,
    ),
)
async def post_v1_admin_dispute_override(
    dispute_id: UUID,
    body: DisputeOverrideRequest,
    request: Request,
    actor: Actor = Depends(require_admin_actor),
    db: AsyncSession = Depends(get_db),
) -> DisputeOverrideResponse:
    yaml_configs = cast(
        YamlConfigBundle | None,
        getattr(request.app.state, "yaml_configs", None),
    )
    return await override_dispute(
        db=db,
        actor=actor,
        dispute_id=dispute_id,
        req=body,
        yaml_configs=yaml_configs,
    )


@router.get(
    "/redemptions",
    response_model=AdminRedemptionListResponse,
    responses=openapi_error_responses(
        status.HTTP_401_UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN,
        status.HTTP_422_UNPROCESSABLE_ENTITY,
    ),
)
async def get_v1_admin_redemptions(
    status_filter: Literal[
        "pending", "approved", "fulfilled", "rejected", "cancelled", "all"
    ] = Query(
        default="all",
        alias="status",
    ),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    _actor: Actor = Depends(require_admin_actor),
    db: AsyncSession = Depends(get_db),
) -> AdminRedemptionListResponse:
    return await list_redemptions(
        db=db,
        status_filter=status_filter,
        limit=limit,
        offset=offset,
    )


@router.post(
    "/redemptions/{redemption_id}/review",
    response_model=AdminRedemptionDTO,
    responses=openapi_error_responses(
        status.HTTP_401_UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN,
        status.HTTP_404_NOT_FOUND,
        status.HTTP_409_CONFLICT,
        status.HTTP_422_UNPROCESSABLE_ENTITY,
    ),
)
async def post_v1_admin_redemption_review(
    redemption_id: UUID,
    body: RedemptionReviewRequest,
    actor: Actor = Depends(require_admin_actor),
    db: AsyncSession = Depends(get_db),
) -> AdminRedemptionDTO:
    return await review_redemption(
        db=db,
        actor=actor,
        redemption_id=redemption_id,
        req=body,
    )


@router.get(
    "/audit-log",
    response_model=AuditLogListResponse,
    responses=openapi_error_responses(
        status.HTTP_401_UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN,
        status.HTTP_422_UNPROCESSABLE_ENTITY,
    ),
)
async def get_v1_admin_audit_log(
    action: str | None = Query(default=None, max_length=128),
    actor_filter: str | None = Query(default=None, alias="actor", max_length=256),
    resource: str | None = Query(default=None, max_length=256),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    _actor: Actor = Depends(require_admin_actor),
    db: AsyncSession = Depends(get_db),
) -> AuditLogListResponse:
    return await list_audit_logs(
        db=db,
        action=action,
        actor_filter=actor_filter,
        resource=resource,
        limit=limit,
        offset=offset,
    )
