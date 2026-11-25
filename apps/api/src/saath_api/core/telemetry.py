from __future__ import annotations

from fastapi import FastAPI
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.instrumentation.redis import RedisInstrumentor
from opentelemetry.instrumentation.sqlalchemy import SQLAlchemyInstrumentor
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from sqlalchemy.ext.asyncio import AsyncEngine

from saath_api.core.config import Settings

_OTEL_CONFIGURED = False


def configure_telemetry(app: FastAPI, settings: Settings) -> None:
    global _OTEL_CONFIGURED

    if not _OTEL_CONFIGURED:
        resource = Resource.create({"service.name": settings.otel_service_name})
        provider = TracerProvider(resource=resource)
        if settings.otel_exporter_otlp_endpoint:
            exporter = OTLPSpanExporter(endpoint=settings.otel_exporter_otlp_endpoint)
            provider.add_span_processor(BatchSpanProcessor(exporter))
        trace.set_tracer_provider(provider)
        RedisInstrumentor().instrument()
        _OTEL_CONFIGURED = True

    if not getattr(app.state, "otel_instrumented", False):
        FastAPIInstrumentor.instrument_app(app)
        app.state.otel_instrumented = True


def instrument_sqlalchemy_engine(engine: AsyncEngine) -> None:
    if not getattr(engine.sync_engine, "_saath_otel_instrumented", False):
        SQLAlchemyInstrumentor().instrument(engine=engine.sync_engine)
        setattr(engine.sync_engine, "_saath_otel_instrumented", True)
