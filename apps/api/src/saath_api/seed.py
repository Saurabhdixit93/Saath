from __future__ import annotations

import asyncio

from sqlalchemy import select

from saath_api.auth.models import User
from saath_api.core.config import get_settings
from saath_api.core.crypto import blind_index_phone, encrypt_phone, normalize_indian_phone
from saath_api.core.db import create_db_engine, create_session_factory
from saath_api.core.ids import uuid7


async def seed_dev_data() -> None:
    settings = get_settings()
    if settings.is_production:
        raise RuntimeError("Seeding dev fixtures is forbidden when ENV=production")

    engine = create_db_engine(settings)
    session_factory = create_session_factory(engine)
    try:
        async with session_factory() as db:
            phone = normalize_indian_phone("9876543210")
            bidx = blind_index_phone(phone, settings.phone_blind_index_key)
            existing = await db.execute(select(User).where(User.phone_bidx == bidx))
            if existing.scalar_one_or_none() is None:
                db.add(
                    User(
                        id=uuid7(),
                        phone_enc=encrypt_phone(phone, settings.phone_aes_key),
                        phone_bidx=bidx,
                        display_alias="Demo Traveller",
                        gender_self="undisclosed",
                        locale="en",
                        women_only_default=False,
                        status="active",
                    )
                )
                await db.commit()
    finally:
        await engine.dispose()


if __name__ == "__main__":
    asyncio.run(seed_dev_data())
    print("Seeded development user idempotently.")
