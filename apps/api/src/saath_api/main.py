from __future__ import annotations

from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware

from fastapi.openapi.utils import get_openapi
from saath_api.admin.router import router as admin_router
from saath_api.ai.router import router as ai_router
from saath_api.auth.router import router as auth_router
from saath_api.core.config import Settings, YamlConfigBundle, get_settings, load_yaml_configs
from saath_api.core.db import create_db_engine, create_session_factory
from saath_api.core.errors import ensure_problem_schemas, register_exception_handlers
from saath_api.core.health import router as health_router
from saath_api.core.ids import uuid7
from saath_api.core.logging import configure_logging, request_id_ctx
from saath_api.core.redis import create_redis_client
from saath_api.core.telemetry import configure_telemetry
from saath_api.dpdp.router import router as dpdp_router
from saath_api.journeys.router import router as journeys_router
from saath_api.karma.router import router as karma_router
from saath_api.matching.router import router as matching_router
from saath_api.messaging.router import router as messaging_router
from saath_api.notifications.router import router as notifications_router
from saath_api.parties.router import router as parties_router
from saath_api.pricing.router import build_pricing_router
from saath_api.public.router import router as public_router
from saath_api.realtime.router import router as realtime_router
from saath_api.swaps.router import router as swaps_router
from saath_api.providers.flight.schedule import (
    FlightScheduleProvider,
    build_flight_schedule_provider,
)
from saath_api.providers.llm import LLMProvider, build_llm_provider
from saath_api.providers.messaging import MessagingProvider, build_messaging_provider
from saath_api.providers.payment import PaymentGatewayProvider, build_payment_provider
from saath_api.providers.push import WebPushProvider, build_web_push_provider
from saath_api.providers.rail import ProviderRouter, build_rail_router
from saath_api.providers.turnstile import TurnstileVerifier, build_turnstile_verifier


def create_app(
    *,
    settings: Settings | None = None,
    yaml_configs: YamlConfigBundle | None = None,
    turnstile_verifier: TurnstileVerifier | None = None,
    messaging_provider: MessagingProvider | None = None,
    rail_router: ProviderRouter | None = None,
    flight_schedule_provider: FlightScheduleProvider | None = None,
    payment_provider: PaymentGatewayProvider | None = None,
    llm_provider: LLMProvider | None = None,
    web_push_provider: WebPushProvider | None = None,
) -> FastAPI:
    resolved_settings = settings or get_settings()
    resolved_yaml = yaml_configs or load_yaml_configs(resolved_settings.config_dir)

    configure_logging(resolved_settings.log_level)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        db_engine = create_db_engine(resolved_settings)
        session_factory = create_session_factory(db_engine)
        redis_client = create_redis_client(resolved_settings)

        app.state.db_engine = db_engine
        app.state.session_factory = session_factory
        app.state.redis = redis_client
        app.state.rail_router = rail_router or build_rail_router(
            resolved_settings, redis_client
        )
        arq_pool = None
        if resolved_settings.env != "test":
            try:
                from arq import create_pool
                from arq.connections import RedisSettings

                arq_pool = await create_pool(
                    RedisSettings.from_dsn(resolved_settings.redis_url)
                )
            except Exception:
                arq_pool = None
        app.state.arq_pool = arq_pool

        try:
            yield
        finally:
            if arq_pool is not None:
                await arq_pool.aclose()
            await redis_client.aclose()
            await db_engine.dispose()

    app = FastAPI(
        title="Saath API",
        version="0.1.0",
        description="Verified peer-to-peer seat swap API for Indian trains and flights.",
        lifespan=lifespan,
    )

    app.state.settings = resolved_settings
    app.state.yaml_configs = resolved_yaml
    app.state.turnstile_verifier = turnstile_verifier or build_turnstile_verifier(
        resolved_settings
    )
    app.state.messaging_provider = messaging_provider or build_messaging_provider(
        resolved_settings
    )
    app.state.flight_schedule_provider = (
        flight_schedule_provider or build_flight_schedule_provider(resolved_settings)
    )
    app.state.payment_provider = payment_provider or build_payment_provider(
        resolved_settings
    )
    app.state.llm_provider = llm_provider or build_llm_provider(resolved_settings)
    app.state.web_push_provider = web_push_provider or build_web_push_provider(
        resolved_settings
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=resolved_settings.cors_origin_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.middleware("http")
    async def request_id_middleware(
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        req_id = request.headers.get("x-request-id") or str(uuid7())
        token = request_id_ctx.set(req_id)
        try:
            response = await call_next(request)
            response.headers["x-request-id"] = req_id
            return response
        finally:
            request_id_ctx.reset(token)

    register_exception_handlers(app)
    configure_telemetry(app, resolved_settings)

    app.include_router(health_router)
    app.include_router(auth_router)
    app.include_router(journeys_router)
    app.include_router(parties_router)
    app.include_router(matching_router)
    app.include_router(swaps_router)
    app.include_router(karma_router)
    app.include_router(ai_router)
    app.include_router(realtime_router)
    app.include_router(messaging_router)
    app.include_router(notifications_router)
    app.include_router(build_pricing_router(resolved_settings))
    app.include_router(public_router)
    app.include_router(dpdp_router)
    app.include_router(admin_router)

    def custom_openapi() -> dict[str, object]:
        if app.openapi_schema is not None:
            return app.openapi_schema
        schema = get_openapi(
            title=app.title,
            version=app.version,
            description=app.description,
            routes=app.routes,
        )
        app.openapi_schema = ensure_problem_schemas(schema)
        return app.openapi_schema

    app.openapi = custom_openapi  # type: ignore[method-assign]

    return app


app = create_app()
