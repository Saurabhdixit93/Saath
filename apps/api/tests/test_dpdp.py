from __future__ import annotations

import io
import json
import zipfile
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from sqlalchemy import select

from saath_api.auth.models import AuditLog, RefreshToken, User
from saath_api.core.ids import uuid7
from saath_api.dpdp.schemas import (
    DPDP_NOTICE_VERSION,
    ConsentItemInput,
)
from saath_api.dpdp.service import (
    delete_user_account,
    export_user_data_zip,
    get_user_consents,
    save_user_consents,
)
from saath_api.journeys.models import Booking, JourneyInstance, SeatHolder
from saath_api.karma.models import Badge, KarmaLedger
from saath_api.public.models import SeatInvite
from saath_api.swaps.models import SeatLock, SwapParticipant, SwapProposal
from saath_api.worker import _run_retention_purge


def _forbidden_key_scan(node: Any, forbidden: set[str]) -> str | None:
    if isinstance(node, dict):
        for k, v in node.items():
            if k.lower() in forbidden:
                return k
            found = _forbidden_key_scan(v, forbidden)
            if found:
                return found
    elif isinstance(node, list):
        for item in node:
            found = _forbidden_key_scan(item, forbidden)
            if found:
                return found
    return None


@pytest.mark.anyio
async def test_get_and_save_consents_flow(db_session):
    user_id = uuid7()
    user = User(
        id=user_id,
        phone_enc=b"enc-sample",
        phone_bidx=b"bidx-sample-1",
        locale="en",
        gender_self="undisclosed",
        status="active",
    )
    db_session.add(user)
    await db_session.commit()

    # 1. Fetch initial consents -> returns all 5 default purposes
    initial = await get_user_consents(db=db_session, user_id=user_id)
    assert initial.notice_version == DPDP_NOTICE_VERSION
    assert len(initial.purposes) == 5
    assert len(initial.consents) == 5
    purp_map = {c.purpose: c.granted for c in initial.consents}
    assert purp_map["verification"] is True
    assert purp_map["matching"] is True
    assert purp_map["notifications"] is True
    assert purp_map["whatsapp"] is True
    assert purp_map["analytics"] is False

    # 2. Save consents update
    items = [
        ConsentItemInput(purpose="analytics", notice_version=DPDP_NOTICE_VERSION, granted=True),
        ConsentItemInput(purpose="whatsapp", notice_version=DPDP_NOTICE_VERSION, granted=False),
    ]
    saved = await save_user_consents(db=db_session, user_id=user_id, items=items)
    saved_map = {c.purpose: c.granted for c in saved.consents}
    assert saved_map["analytics"] is True
    assert saved_map["whatsapp"] is False
    assert saved_map["verification"] is True

    # 3. Verify audit log was recorded
    audit_stmt = select(AuditLog).where(
        AuditLog.actor == f"user:{user_id}",
        AuditLog.action == "dpdp.consents_updated",
    )
    audit = (await db_session.execute(audit_stmt)).scalar_one_or_none()
    assert audit is not None


@pytest.mark.anyio
async def test_export_user_data_zip_no_pii_leak(db_session):
    user_id = uuid7()
    user = User(
        id=user_id,
        phone_enc=b"super_secret_enc_phone",
        phone_bidx=b"super_secret_bidx",
        display_alias="Traveler42",
        locale="hi",
        gender_self="female",
        status="active",
    )
    db_session.add(user)

    # Add journey & booking
    journey_inst = JourneyInstance(
        id=uuid7(),
        mode="train",
        carrier_code="IR",
        service_no="12951",
        service_date=datetime.now(UTC).date(),
    )
    db_session.add(journey_inst)

    booking = Booking(
        id=uuid7(),
        journey_instance_id=journey_inst.id,
        owner_user_id=user_id,
        pnr_hash=b"raw_pnr_hashed_secret",
        travel_class="3A",
        trust_tier="verified_provider",
        purge_after=datetime.now(UTC) + timedelta(days=7),
    )
    db_session.add(booking)

    holder = SeatHolder(
        id=uuid7(),
        booking_id=booking.id,
        pax_seq=1,
        coach="B3",
        seat_no="42",
        age_band="adult",
        gender_band="F",
        linked_user_id=user_id,
    )
    db_session.add(holder)

    # Add karma entry
    karma = KarmaLedger(
        user_id=user_id,
        delta=50,
        state="credited",
        reason="first_swap",
    )
    db_session.add(karma)

    # Add badge
    badge = Badge(
        user_id=user_id,
        badge_key="first_swap",
        tier=1,
        unlocked_at=datetime.now(UTC),
    )
    db_session.add(badge)

    await db_session.commit()

    # Export ZIP
    zip_bytes = await export_user_data_zip(db=db_session, user_id=user_id)
    assert zip_bytes.startswith(b"PK\x03\x04")

    # Read zip
    zip_buf = io.BytesIO(zip_bytes)
    with zipfile.ZipFile(zip_buf, "r") as zf:
        file_names = zf.namelist()
        expected_files = [
            "profile.json",
            "consents.json",
            "journeys.json",
            "parties.json",
            "swaps.json",
            "messages.json",
            "karma.json",
            "badges.json",
        ]
        for ef in expected_files:
            assert ef in file_names

        # Check content and ensure NO forbidden keys
        forbidden_keys = {"phone_enc", "phone_bidx", "raw_pnr", "pnr_hash", "pnr"}
        for fn in file_names:
            content = json.loads(zf.read(fn).decode("utf-8"))
            leak = _forbidden_key_scan(content, forbidden_keys)
            assert leak is None, f"Found forbidden key '{leak}' in {fn}"

        journeys_json = json.loads(zf.read("journeys.json").decode("utf-8"))
        assert len(journeys_json) == 1
        assert journeys_json[0]["service_no"] == "12951"
        assert journeys_json[0]["seats"][0]["seat_no"] == "42"


@pytest.mark.anyio
async def test_delete_account_and_retention_purge(db_session):
    user_id = uuid7()
    user = User(
        id=user_id,
        phone_enc=b"enc",
        phone_bidx=b"bidx-to-delete",
        display_alias="AnonDel",
        status="active",
    )
    db_session.add(user)

    # Active token
    token = RefreshToken(
        id=uuid7(),
        user_id=user_id,
        device_id=uuid7(),
        family_id=uuid7(),
        token_hash=b"hash",
        expires_at=datetime.now(UTC) + timedelta(days=1),
    )
    db_session.add(token)

    # Pending swap
    journey_inst = JourneyInstance(
        id=uuid7(),
        mode="train",
        carrier_code="IR",
        service_no="12952",
        service_date=datetime.now(UTC).date(),
    )
    db_session.add(journey_inst)

    swap = SwapProposal(
        id=uuid7(),
        journey_instance_id=journey_inst.id,
        initiator_user_id=user_id,
        kind="pair",
        status="pending",
        expires_at=datetime.now(UTC) + timedelta(hours=2),
    )
    db_session.add(swap)

    booking = Booking(
        id=uuid7(),
        journey_instance_id=journey_inst.id,
        owner_user_id=user_id,
        pnr_hash=b"pnr_hash_2",
        trust_tier="declared",
        purge_after=datetime.now(UTC) - timedelta(hours=1),  # already expired
    )
    db_session.add(booking)

    holder = SeatHolder(
        id=uuid7(),
        booking_id=booking.id,
        pax_seq=1,
        coach="B1",
        seat_no="10",
        linked_user_id=user_id,
    )
    db_session.add(holder)

    part = SwapParticipant(
        proposal_id=swap.id,
        seat_holder_id=holder.id,
        user_id=user_id,
        alias="AnonDel",
        gives_seat="10",
        gets_seat="12",
        decision="pending",
    )
    db_session.add(part)

    lock = SeatLock(
        journey_instance_id=journey_inst.id,
        coach="B1",
        seat_no="10",
        proposal_id=swap.id,
        expires_at=datetime.now(UTC) + timedelta(minutes=15),
    )
    db_session.add(lock)

    # Expired seat invite
    invite = SeatInvite(
        id=uuid7(),
        journey_instance_id=journey_inst.id,
        created_by_user_id=user_id,
        seat_holder_id=holder.id,
        invite_token="expired_tok",
        expires_at=datetime.now(UTC) - timedelta(hours=2),
    )
    db_session.add(invite)

    await db_session.commit()

    # Execute deletion
    del_res = await delete_user_account(db=db_session, user_id=user_id)
    assert del_res.status == "erasure_scheduled"
    assert del_res.scheduled_within_hours == 24

    # Verify user marked deleted
    await db_session.refresh(user)
    assert user.status == "deleted"
    assert user.deleted_at is not None
    assert user.display_alias is None

    # Verify token revoked
    await db_session.refresh(token)
    assert token.revoked_at is not None

    # Verify pending swap cancelled
    await db_session.refresh(swap)
    assert swap.status == "cancelled"

    # Verify seat lock removed
    locks_res = await db_session.execute(select(SeatLock).where(SeatLock.proposal_id == swap.id))
    assert len(locks_res.scalars().all()) == 0

    # Simulate 24 hours passing to test retention purge worker sweep
    user.erasure_requested_at = datetime.now(UTC) - timedelta(hours=25)
    await db_session.commit()

    purge_stats = await _run_retention_purge(db_session)
    assert purge_stats["purged_invites"] >= 1
    assert purge_stats["purged_bookings"] >= 1
    assert purge_stats["swept_erasures"] >= 1

    await db_session.refresh(user)
    assert user.erased_at is not None
