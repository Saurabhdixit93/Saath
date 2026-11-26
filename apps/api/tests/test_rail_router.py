from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

import fakeredis.aioredis
import pytest

from saath_api.core.config import load_yaml_configs
from saath_api.journeys.chart_rules import compute_chart_due_at
from saath_api.journeys.sms_parser import (
    SmsParseError,
    mask_sms_pii_for_llm,
    parse_irctc_sms_text,
    parse_irctc_sms_with_optional_llm,
)
from saath_api.matching.graph import SeatNode, check_segment_overlap
from saath_api.providers.rail.fake import FakeRailProvider
from saath_api.providers.rail.protocol import (
    BookingDTO,
    CoachDTO,
    LiveStatusDTO,
    PassengerDTO,
    RailPnrFlushedError,
    RailPnrInvalidError,
    RailPnrNotFoundError,
    RailProviderError,
)
from saath_api.providers.rail.router import (
    POST_CHART_CACHE_TTL_SECONDS,
    PRE_CHART_CACHE_TTL_SECONDS,
    ProviderRouter,
    RedisCircuitBreaker,
)

IST = ZoneInfo("Asia/Kolkata")


class _StubProvider:
    def __init__(
        self,
        name: str,
        *,
        fail: bool = False,
        delay_seconds: float = 0.0,
        chart_state: str = "pending",
    ) -> None:
        self.name = name
        self._fail = fail
        self._delay = delay_seconds
        self._chart_state = chart_state
        self.calls = 0

    async def get_pnr(self, pnr: str) -> BookingDTO:
        self.calls += 1
        if self._delay > 0:
            await asyncio.sleep(self._delay)
        if self._fail:
            raise RailProviderError(f"{self.name} failed")
        svc_date = date(2026, 12, 10)
        dep = datetime.combine(svc_date, time(16, 55), tzinfo=IST).astimezone(UTC)
        return BookingDTO(
            provider=self.name,
            train_no="12951",
            train_name="Rajdhani Express",
            service_date=svc_date,
            travel_class="3A",
            from_code="NDLS",
            to_code="MMCT",
            departure_at=dep,
            arrival_at=dep + timedelta(hours=15),
            chart_state=self._chart_state,  # type: ignore[arg-type]
            passengers=[
                PassengerDTO(
                    pax_seq=1,
                    booking_status="CNF",
                    current_status="CNF",
                    coach="B5",
                    seat_no="12",
                    seat_type="LB",
                    bay=2,
                    age_band="adult",
                    gender_band="F",
                )
            ],
        )

    async def get_composition(self, train_no: str, service_date: date) -> list[CoachDTO]:
        _ = (train_no, service_date)
        return []

    async def get_live_status(self, train_no: str, service_date: date) -> LiveStatusDTO:
        return LiveStatusDTO(train_no=train_no, service_date=service_date)


async def test_fake_rail_provider_70_pax_and_error_pnrs() -> None:
    fake = FakeRailProvider()
    fixtures = fake.rajdhani_fixture_pnrs()
    total_pax = sum(len(v) for v in fixtures.values())
    assert total_pax == 70

    senior_b5 = await fake.get_pnr("2415678901")
    assert senior_b5.train_no == "12951"
    assert senior_b5.passengers[0].age_band == "senior"
    assert senior_b5.passengers[0].seat_type == "UB"

    rac = await fake.get_pnr("2415678905")
    assert rac.passengers[0].current_status.startswith("RAC")

    wl = await fake.get_pnr("2415678906")
    assert wl.passengers[0].current_status.startswith("WL")
    assert wl.passengers[0].coach is None

    sl = await fake.get_pnr("2415678971")
    assert sl.travel_class == "SL"

    cc = await fake.get_pnr("2415678981")
    assert cc.travel_class == "CC"

    with pytest.raises(RailPnrFlushedError):
        await fake.get_pnr("0000000000")
    with pytest.raises(RailPnrNotFoundError):
        await fake.get_pnr("1111111111")
    with pytest.raises(RailPnrInvalidError):
        await fake.get_pnr("12345")


async def test_fake_rail_provider_synthetic_12951_overlaps_brc_mmct_sms() -> None:
    fake = FakeRailProvider()
    synth = await fake.get_pnr("5555555555")
    assert synth.train_no == "12951"
    assert synth.from_code == "NDLS"
    assert synth.to_code == "MMCT"
    assert synth.from_seq == 1
    assert synth.to_seq == 9

    sms = parse_irctc_sms_text(
        "PNR 9123456789 TRN 12951 DOJ 2026-12-01 BRC-MMCT 3A CNF/B3/45/LB"
    )
    assert sms.from_code == "BRC"
    assert sms.to_code == "MMCT"
    assert sms.from_seq == 6
    assert sms.to_seq == 9

    n_synth = SeatNode(
        seat_holder_id=uuid.uuid4(),
        party_id=uuid.uuid4(),
        booking_id=uuid.uuid4(),
        owner_user_id=uuid.uuid4(),
        owner_anon_id=None,
        coach="B3",
        seat_no="12",
        seat_type="UB",
        bay=2,
        age_band="adult",
        gender_band="F",
        user_gender_self="female",
        trust_tier="verified_provider",
        from_seq=synth.from_seq,
        to_seq=synth.to_seq,
        goal_type="lower",
    )
    n_sms = SeatNode(
        seat_holder_id=uuid.uuid4(),
        party_id=uuid.uuid4(),
        booking_id=uuid.uuid4(),
        owner_user_id=uuid.uuid4(),
        owner_anon_id=None,
        coach="B3",
        seat_no="45",
        seat_type="LB",
        bay=6,
        age_band="adult",
        gender_band="F",
        user_gender_self="female",
        trust_tier="verified_doc",
        from_seq=sms.from_seq,
        to_seq=sms.to_seq,
        goal_type="open_to_help",
    )
    assert check_segment_overlap(n_synth, n_sms) == "partial"
    assert check_segment_overlap(n_sms, n_synth) == "full"


async def test_provider_router_fallback_timeout_circuit_breaker_and_cache() -> None:
    redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    p_slow = _StubProvider("prov_a", delay_seconds=0.3)
    p_b = _StubProvider("prov_b", chart_state="pending")
    cb = RedisCircuitBreaker(redis, failure_threshold=2, open_seconds=30)

    router = ProviderRouter(
        providers=[p_slow, p_b],
        redis=redis,
        pnr_pepper="test-pepper",
        timeout_seconds=0.05,
        retries=0,
        circuit_breaker=cb,
    )

    dto = await router.get_pnr("2415678901")
    assert dto.provider == "prov_b"

    # Cache hit does not re-call providers and uses 10m TTL for pre-chart
    cached_keys = await redis.keys("cache:rail:pnr:*")
    assert len(cached_keys) == 1
    assert "2415678901" not in cached_keys[0]
    ttl = await redis.ttl(cached_keys[0])
    assert 0 < ttl <= PRE_CHART_CACHE_TTL_SECONDS

    dto_cached = await router.get_pnr("2415678901")
    assert dto_cached.provider == "prov_b"
    assert p_b.calls == 1

    # Second call on a different PNR trips prov_a circuit breaker (threshold=2)
    await router.get_pnr("2415678902")
    assert await cb.is_open("prov_a") is True

    # Post-chart uses 60m TTL
    p_final = _StubProvider("prov_final", chart_state="final")
    router_final = ProviderRouter(
        providers=[p_final],
        redis=redis,
        pnr_pepper="test-pepper",
    )
    await router_final.get_pnr("2415678999")
    keys_after = [k for k in await redis.keys("cache:rail:pnr:*") if k not in cached_keys]
    assert len(keys_after) == 1
    assert await redis.ttl(keys_after[0]) > PRE_CHART_CACHE_TTL_SECONDS
    assert await redis.ttl(keys_after[0]) <= POST_CHART_CACHE_TTL_SECONDS
    await redis.aclose()


async def test_provider_router_single_flight_coalescing() -> None:
    redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    p_ok = _StubProvider("prov_sf", delay_seconds=0.05)
    router = ProviderRouter(
        providers=[p_ok],
        redis=redis,
        pnr_pepper="test-pepper",
        timeout_seconds=1.0,
    )
    results = await asyncio.gather(
        router.get_pnr("4512890341"),
        router.get_pnr("4512890341"),
        router.get_pnr("4512890341"),
    )
    assert all(r.train_no == "12951" for r in results)
    assert p_ok.calls == 1
    await redis.aclose()


def test_dec_2025_chart_rules_calculation() -> None:
    yaml_cfg = load_yaml_configs()
    # Morning train 06:00 IST on 2026-12-10 -> 20:00 IST on 2026-12-09
    morning_dep = datetime(2026, 12, 10, 6, 0, tzinfo=IST)
    morning_due = compute_chart_due_at(morning_dep, rules=yaml_cfg.chart_rules).astimezone(IST)
    assert morning_due == datetime(2026, 12, 9, 20, 0, tzinfo=IST)

    # Boundary 14:00 IST -> previous day 20:00 IST
    edge_dep = datetime(2026, 12, 10, 14, 0, tzinfo=IST)
    edge_due = compute_chart_due_at(edge_dep, rules=yaml_cfg.chart_rules).astimezone(IST)
    assert edge_due == datetime(2026, 12, 9, 20, 0, tzinfo=IST)

    # Evening train 16:55 IST -> 10h before (06:55 IST same day)
    evening_dep = datetime(2026, 12, 10, 16, 55, tzinfo=IST)
    evening_due = compute_chart_due_at(evening_dep, rules=yaml_cfg.chart_rules).astimezone(IST)
    assert evening_due == datetime(2026, 12, 10, 6, 55, tzinfo=IST)


async def test_irctc_sms_parser_and_pii_masked_llm_fallback() -> None:
    sms = (
        "IRCTC: PNR:4512890341, Train 12951 NDLS-MMCT DOJ 25-11-26 3A "
        "P1-CNF/B3/42/UB, P2-CNF/B3/44/LB"
    )
    parsed = parse_irctc_sms_text(sms)
    assert parsed.pnr == "4512890341"
    assert parsed.train_no == "12951"
    assert parsed.travel_class == "3A"
    assert parsed.from_code == "NDLS"
    assert parsed.to_code == "MMCT"
    assert len(parsed.passengers) == 2
    assert parsed.passengers[0].coach == "B3"
    assert parsed.passengers[0].seat_no == "42"
    assert parsed.passengers[0].seat_type == "UB"

    # PII masking strips PNR, phones, salutations, tabular rows & inline/indexed names
    raw_with_name = (
        "Dear Asha Sharma,\n"
        "PNR: 451 289 0341, Name: Asha Sharma, Train 12951\n"
        "Passenger 1: Rahul Verma\n"
        "Pax 2: Priya Nair\n"
        "1. ASHA SHARMA / 32 / F / CNF/B3/42/MB\n"
        "Call +919876543210 for PNR 451-2890341"
    )
    masked = mask_sms_pii_for_llm(raw_with_name)
    for sensitive in ("4512890341", "451 289 0341", "451-2890341", "Asha", "Sharma", "Rahul", "Verma", "Priya", "Nair", "9876543210"):
        assert sensitive not in masked
    assert "Train 12951" in masked
    assert "CNF/B3/42/MB" in masked

    seen_prompts: list[str] = []

    async def fake_llm(prompt_text: str) -> str:
        seen_prompts.append(prompt_text)
        return "Train 12951 DOJ 25-11-26 3A CNF/B5/12/LB"

    fallback_parsed = await parse_irctc_sms_with_optional_llm(
        "Name: Asha Sharma\nPNR 4512890341 garbled text", llm_extractor=fake_llm
    )
    assert fallback_parsed.used_llm_fallback is True
    assert fallback_parsed.pnr == "4512890341"
    assert fallback_parsed.passengers[0].seat_no == "12"
    assert len(seen_prompts) == 1
    assert "4512890341" not in seen_prompts[0]
    assert "Asha Sharma" not in seen_prompts[0]

    with pytest.raises(SmsParseError):
        parse_irctc_sms_text("not an irctc message at all")
    with pytest.raises(SmsParseError, match="out of range"):
        parse_irctc_sms_text("PNR 4512890341 Train 12951 DOJ 25-11-26 3A B3-999")
    with pytest.raises(SmsParseError, match="positive"):
        parse_irctc_sms_text("PNR 4512890341 Train 12951 DOJ 25-11-26 3A B3-0")


def test_mask_sms_pii_for_llm_adversarial_unicode_and_spacing() -> None:
    # 1. Hindi/Devanagari salutation
    m1 = mask_sms_pii_for_llm("Dear आशा शर्मा, PNR 4512890341 Train 12951")
    assert "आशा" not in m1
    assert "शर्मा" not in m1
    assert "4512890341" not in m1
    assert "Train 12951" in m1

    # 2. Hindi/Devanagari tabular passenger row
    m2 = mask_sms_pii_for_llm("1. आशा शर्मा / 32 / F / CNF/B3/42/MB")
    assert "आशा" not in m2
    assert "शर्मा" not in m2
    assert "CNF/B3/42/MB" in m2

    # 3. Hindi/Devanagari parenthesized passenger
    m3 = mask_sms_pii_for_llm("आशा शर्मा (32/F) Train 12951")
    assert "आशा" not in m3
    assert "शर्मा" not in m3
    assert "Train 12951" in m3

    # 4. Long unpunctuated salutation line (English & Hindi)
    m4 = mask_sms_pii_for_llm(
        "Dear Asha Sharma your ticket for Train 12951 from NDLS to MMCT on 25-11-26 is confirmed"
    )
    assert "Asha" not in m4
    assert "Sharma" not in m4
    assert "your ticket for Train 12951 from NDLS to MMCT on 25-11-26 is confirmed" in m4

    m4_hi = mask_sms_pii_for_llm("नमस्ते प्रिया नायर आपकी ट्रेन 12951 पीएनआर 4512890341")
    assert "प्रिया" not in m4_hi
    assert "नायर" not in m4_hi
    assert "4512890341" not in m4_hi
    assert "आपकी ट्रेन 12951" in m4_hi

    # 5. Bare 5+5 space-separated mobile & unlabeled 5+5 PNR
    m5 = mask_sms_pii_for_llm("Call 98765 43210 for Ticket 45128 90341 Train 12951")
    for leaked in ("98765", "43210", "45128", "90341"):
        assert leaked not in m5
    assert "Train 12951" in m5

    # 6. 91-prefixed 12-digit mobile without '+' & Hindi name label
    m6 = mask_sms_pii_for_llm("नाम: रोहित कुमार, Call 919876543210 for Train 12951")
    for leaked in ("रोहित", "कुमार", "919876543210"):
        assert leaked not in m6
    assert "Train 12951" in m6
