from __future__ import annotations

from fastapi import APIRouter, Depends, Header, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from saath_api.auth.dependencies import (
    Actor,
    get_request_settings,
    optional_actor,
    require_user_actor,
)
from saath_api.core.config import Settings, YamlConfigBundle
from saath_api.core.db import get_db
from saath_api.core.errors import openapi_error_responses
from saath_api.pricing.schemas import (
    B2BKeyCreatedResponse,
    B2BStatsResponse,
    CheckoutRequest,
    CheckoutResponse,
    CreateB2BKeyRequest,
    MyEntitlementsResponse,
    PricingPlansResponse,
    SandboxCompleteRequest,
    SandboxCompleteResponse,
    WebhookAckResponse,
)
from saath_api.pricing.service import (
    complete_sandbox_payment,
    create_b2b_api_key,
    create_checkout_order,
    get_b2b_stats,
    get_my_entitlements,
    get_pricing_plans,
    process_payment_webhook,
)
from saath_api.providers.payment.base import PaymentGatewayProvider


def _get_yaml_configs(request: Request) -> YamlConfigBundle:
    return request.app.state.yaml_configs  # type: ignore[no-any-return]


def _get_payment_provider(request: Request) -> PaymentGatewayProvider:
    return request.app.state.payment_provider  # type: ignore[no-any-return]


def build_pricing_router(settings: Settings) -> APIRouter:
    router = APIRouter(prefix="/v1", tags=["pricing"])

    @router.get(
        "/pricing/plans",
        response_model=PricingPlansResponse,
    )
    async def get_v1_pricing_plans(request: Request) -> PricingPlansResponse:
        return get_pricing_plans(_get_yaml_configs(request))

    @router.get(
        "/me/entitlements",
        response_model=MyEntitlementsResponse,
        responses=openapi_error_responses(
            status.HTTP_401_UNAUTHORIZED,
            status.HTTP_403_FORBIDDEN,
        ),
    )
    async def get_v1_me_entitlements(
        request: Request,
        actor: Actor = Depends(require_user_actor),
        db: AsyncSession = Depends(get_db),
    ) -> MyEntitlementsResponse:
        return await get_my_entitlements(
            yaml_configs=_get_yaml_configs(request),
            db=db,
            actor=actor,
        )

    @router.post(
        "/billing/checkout",
        response_model=CheckoutResponse,
        responses=openapi_error_responses(
            status.HTTP_401_UNAUTHORIZED,
            status.HTTP_403_FORBIDDEN,
            status.HTTP_404_NOT_FOUND,
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        ),
    )
    async def post_v1_billing_checkout(
        body: CheckoutRequest,
        request: Request,
        actor: Actor = Depends(require_user_actor),
        db: AsyncSession = Depends(get_db),
    ) -> CheckoutResponse:
        return await create_checkout_order(
            settings=get_request_settings(request),
            yaml_configs=_get_yaml_configs(request),
            db=db,
            payment_provider=_get_payment_provider(request),
            actor=actor,
            req=body,
        )

    @router.post(
        "/webhooks/payments",
        response_model=WebhookAckResponse,
        responses=openapi_error_responses(
            status.HTTP_400_BAD_REQUEST,
            status.HTTP_401_UNAUTHORIZED,
        ),
    )
    async def post_v1_webhooks_payments(
        request: Request,
        db: AsyncSession = Depends(get_db),
        x_razorpay_signature: str | None = Header(default=None),
        x_saath_signature: str | None = Header(default=None),
        x_razorpay_event_id: str | None = Header(default=None),
    ) -> WebhookAckResponse:
        raw_body = await request.body()
        signature = x_razorpay_signature or x_saath_signature or ""
        return await process_payment_webhook(
            yaml_configs=_get_yaml_configs(request),
            db=db,
            payment_provider=_get_payment_provider(request),
            raw_body=raw_body,
            signature=signature,
            header_event_id=x_razorpay_event_id,
        )

    if not settings.is_production and settings.payment_provider == "sandbox":

        @router.post(
            "/billing/sandbox/complete",
            response_model=SandboxCompleteResponse,
            responses=openapi_error_responses(
                status.HTTP_401_UNAUTHORIZED,
                status.HTTP_403_FORBIDDEN,
                status.HTTP_404_NOT_FOUND,
            ),
        )
        async def post_v1_billing_sandbox_complete(
            body: SandboxCompleteRequest,
            request: Request,
            actor: Actor = Depends(require_user_actor),
            db: AsyncSession = Depends(get_db),
        ) -> SandboxCompleteResponse:
            return await complete_sandbox_payment(
                settings=get_request_settings(request),
                yaml_configs=_get_yaml_configs(request),
                db=db,
                payment_provider=_get_payment_provider(request),
                actor=actor,
                req=body,
            )

    @router.post(
        "/b2b/keys",
        response_model=B2BKeyCreatedResponse,
        responses=openapi_error_responses(
            status.HTTP_401_UNAUTHORIZED,
            status.HTTP_403_FORBIDDEN,
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        ),
    )
    async def post_v1_b2b_keys(
        body: CreateB2BKeyRequest,
        actor: Actor = Depends(require_user_actor),
        db: AsyncSession = Depends(get_db),
    ) -> B2BKeyCreatedResponse:
        return await create_b2b_api_key(db=db, actor=actor, req=body)

    @router.get(
        "/b2b/stats",
        response_model=B2BStatsResponse,
        responses=openapi_error_responses(
            status.HTTP_401_UNAUTHORIZED,
            status.HTTP_403_FORBIDDEN,
        ),
    )
    async def get_v1_b2b_stats(
        db: AsyncSession = Depends(get_db),
        x_api_key: str | None = Header(default=None),
        actor: Actor | None = Depends(optional_actor),
    ) -> B2BStatsResponse:
        return await get_b2b_stats(db=db, raw_api_key=x_api_key, actor=actor)

    return router
