from __future__ import annotations

import os
from collections.abc import AsyncIterator

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text

from saath_api.core.config import Settings, load_yaml_configs
from saath_api.main import create_app
from saath_api.providers.messaging import FakeMessagingProvider
from saath_api.providers.turnstile import FakeTurnstileVerifier


@pytest.fixture
def test_settings() -> Settings:
    return Settings(
        env="test",
        database_url=os.getenv(
            "DATABASE_URL",
            "postgresql+asyncpg://saath:saath@127.0.0.1:5432/saath",
        ),
        redis_url=os.getenv("REDIS_URL", "redis://127.0.0.1:6379/0"),
        turnstile_mode="fake",
        whatsapp_mode="fake",
        sms_mode="fake",
        rail_provider_mode="fake",
        flight_provider_mode="fake",
        payment_provider="sandbox",
    )


@pytest.fixture
def fake_turnstile() -> FakeTurnstileVerifier:
    return FakeTurnstileVerifier()


@pytest.fixture
def fake_messaging() -> FakeMessagingProvider:
    return FakeMessagingProvider()


@pytest.fixture
async def client(
    test_settings: Settings,
    fake_turnstile: FakeTurnstileVerifier,
    fake_messaging: FakeMessagingProvider,
) -> AsyncIterator[AsyncClient]:
    yaml_cfg = load_yaml_configs(test_settings.config_dir)
    app = create_app(
        settings=test_settings,
        yaml_configs=yaml_cfg,
        turnstile_verifier=fake_turnstile,
        messaging_provider=fake_messaging,
    )
    async with app.router.lifespan_context(app):
        await app.state.redis.flushdb()
        async with app.state.session_factory() as session:
            await session.execute(
                text(
                    "TRUNCATE TABLE "
                    "reports, messages, conversation_members, conversations, "
                    "blocks, swap_cards, seat_locks, swap_participants, swap_proposals, "
                    "match_candidates, "
                    "b2b_api_keys, entitlements, payment_webhook_events, payment_orders, "
                    "notifications_outbox, goals, party_members, parties, "
                    "seat_holders, bookings, journey_instances, "
                    "audit_log, consents, refresh_tokens, devices, users "
                    "RESTART IDENTITY CASCADE"
                )
            )
            await session.commit()

        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://testserver") as ac:
            ac.app = app  # type: ignore[attr-defined]
            yield ac
