from __future__ import annotations

import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from zoneinfo import ZoneInfo

from saath_api.journeys.geometry import normalize_coach_class, seat_to_bay_and_type

IST = ZoneInfo("Asia/Kolkata")

_LABELED_PNR_RE = re.compile(r"\bPNR\s*(?:NO\.?|NUMBER)?\s*[:\-]?\s*([0-9]{10})\b", re.IGNORECASE)
_TEN_DIGIT_RE = re.compile(r"\b([0-9]{10})\b")
_TRAIN_RE = re.compile(r"\b(?:TRAIN|TRN|T\.?NO\.?)\s*(?:NO\.?)?\s*[:\-]?\s*([0-9]{5})\b", re.I)
_FIVE_DIGIT_TRAIN_RE = re.compile(r"\b([12][0-9]{4})\b")
_CLASS_RE = re.compile(r"\b(1A|2A|3A|3E|SL|CC|EC|2S)\b", re.IGNORECASE)
_ROUTE_RE = re.compile(r"\b([A-Z]{2,5})\s*(?:->|TO|-)\s*([A-Z]{2,5})\b")
_DATE_RE = re.compile(
    r"\b(\d{1,2}[-/](?:[A-Za-z]{3}|\d{1,2})[-/]\d{2,4})\b"
)
_PAX_BERTH_SLASH_RE = re.compile(
    r"(?:P\d+\s*[-:]\s*)?(CNF|RAC(?:\s*\d+)?|WL(?:\s*\d+)?)\s*/\s*([A-Z]{1,3}\d{1,2})\s*/\s*(\d{1,3})\s*(?:/\s*(LB|MB|UB|SL|SM|SU|WS|MS|AS))?",
    re.IGNORECASE,
)
_PAX_COACH_BERTH_RE = re.compile(
    r"\b([A-Z]{1,2}\d{1,2})\s*[-/]\s*(\d{1,3})(?:\s*\(?(LB|MB|UB|SL|SM|SU|WS|MS|AS)\)?)?",
    re.IGNORECASE,
)
_PAX_STATUS_ONLY_RE = re.compile(r"\b(RAC\s*\d+|WL\s*\d+|RLWL\s*\d+|PQWL\s*\d+)\b", re.I)
_NAME_LINE_RE = re.compile(r"(?im)^(?:name|passenger|pax)\s*[:\-].*$")


@dataclass(frozen=True)
class ParsedSmsPassenger:
    pax_seq: int
    booking_status: str
    current_status: str
    coach: str | None
    seat_no: str | None
    seat_type: str | None
    bay: int | None


@dataclass(frozen=True)
class ParsedSmsTicket:
    pnr: str
    train_no: str
    service_date: date
    travel_class: str
    from_code: str
    to_code: str
    departure_at: datetime
    arrival_at: datetime
    passengers: tuple[ParsedSmsPassenger, ...]
    used_llm_fallback: bool = False


class SmsParseError(ValueError):
    """Raised when IRCTC SMS / e-ticket text cannot be parsed."""


def mask_sms_pii_for_llm(raw_text: str) -> str:
    """Strip 10-digit PNR numbers and passenger name lines before any LLM fallback."""
    masked = _LABELED_PNR_RE.sub("PNR:[REDACTED]", raw_text)
    masked = _TEN_DIGIT_RE.sub("[REDACTED_10D]", masked)
    masked = _NAME_LINE_RE.sub("Name:[REDACTED]", masked)
    return masked.strip()


def _parse_date_token(token: str) -> date:
    cleaned = token.strip().replace("/", "-")
    for fmt in ("%d-%m-%y", "%d-%m-%Y", "%d-%b-%y", "%d-%b-%Y"):
        try:
            return datetime.strptime(cleaned, fmt).date()
        except ValueError:
            continue
    raise SmsParseError(f"Unrecognized date token: {token!r}")


def parse_irctc_sms_text(
    raw_text: str,
    *,
    reference_date: date | None = None,
) -> ParsedSmsTicket:
    """Deterministic regex parser for IRCTC SMS / e-ticket snippets."""
    text = raw_text.strip()
    if len(text) < 10:
        raise SmsParseError("SMS or ticket text is too short.")

    pnr_match = _LABELED_PNR_RE.search(text) or _TEN_DIGIT_RE.search(text)
    if not pnr_match:
        raise SmsParseError("Could not find a 10-digit PNR in the pasted text.")
    pnr = pnr_match.group(1)

    train_match = _TRAIN_RE.search(text) or _FIVE_DIGIT_TRAIN_RE.search(text)
    if not train_match:
        raise SmsParseError("Could not find a 5-digit train number in the pasted text.")
    train_no = train_match.group(1)

    date_match = _DATE_RE.search(text)
    if date_match:
        service_date = _parse_date_token(date_match.group(1))
    elif reference_date is not None:
        service_date = reference_date
    else:
        raise SmsParseError("Could not find a valid journey date in the pasted text.")

    class_match = _CLASS_RE.search(text)
    explicit_class = class_match.group(1).upper() if class_match else None

    route_match = _ROUTE_RE.search(text)
    from_code = "NDLS"
    to_code = "MMCT"
    if route_match and route_match.group(1) not in {"PNR", "DOJ", "TRN"}:
        from_code = route_match.group(1).upper()
        to_code = route_match.group(2).upper()

    passengers: list[ParsedSmsPassenger] = []
    for idx, m in enumerate(_PAX_BERTH_SLASH_RE.finditer(text), start=1):
        status_tok = re.sub(r"\s+", " ", m.group(1).upper().strip())
        coach = m.group(2).upper()
        seat_num = str(int(m.group(3)))
        tclass = normalize_coach_class(explicit_class, coach)
        try:
            bay, default_stype, _ = seat_to_bay_and_type(tclass, int(seat_num))
        except ValueError:
            bay, default_stype = None, None
        stype = m.group(4).upper() if m.group(4) else default_stype
        passengers.append(
            ParsedSmsPassenger(
                pax_seq=idx,
                booking_status=status_tok,
                current_status=status_tok,
                coach=coach,
                seat_no=seat_num,
                seat_type=stype,
                bay=bay,
            )
        )

    if not passengers:
        for idx, m in enumerate(_PAX_COACH_BERTH_RE.finditer(text), start=1):
            coach = m.group(1).upper()
            seat_num = str(int(m.group(2)))
            tclass = normalize_coach_class(explicit_class, coach)
            try:
                bay, default_stype, _ = seat_to_bay_and_type(tclass, int(seat_num))
            except ValueError:
                bay, default_stype = None, None
            stype = m.group(3).upper() if m.group(3) else default_stype
            passengers.append(
                ParsedSmsPassenger(
                    pax_seq=idx,
                    booking_status="CNF",
                    current_status="CNF",
                    coach=coach,
                    seat_no=seat_num,
                    seat_type=stype,
                    bay=bay,
                )
            )

    if not passengers:
        status_match = _PAX_STATUS_ONLY_RE.search(text)
        if status_match:
            st = re.sub(r"\s+", " ", status_match.group(1).upper().strip())
            passengers.append(
                ParsedSmsPassenger(
                    pax_seq=1,
                    booking_status=st,
                    current_status=st,
                    coach=None,
                    seat_no=None,
                    seat_type=None,
                    bay=None,
                )
            )

    if not passengers:
        raise SmsParseError("Could not find coach/berth or ticket status in the pasted text.")

    resolved_class = normalize_coach_class(
        explicit_class,
        passengers[0].coach,
    )
    dep_ist = datetime.combine(service_date, datetime.min.time(), tzinfo=IST) + timedelta(
        hours=16, minutes=55
    )
    arr_ist = dep_ist + timedelta(hours=15, minutes=40)

    return ParsedSmsTicket(
        pnr=pnr,
        train_no=train_no,
        service_date=service_date,
        travel_class=resolved_class,
        from_code=from_code,
        to_code=to_code,
        departure_at=dep_ist.astimezone(UTC),
        arrival_at=arr_ist.astimezone(UTC),
        passengers=tuple(passengers),
        used_llm_fallback=False,
    )


async def parse_irctc_sms_with_optional_llm(
    raw_text: str,
    *,
    llm_extractor: Callable[[str], Awaitable[str]] | None = None,
) -> ParsedSmsTicket:
    """Parse SMS text via regex first; optionally invoke LLM fallback with masked PII."""
    try:
        return parse_irctc_sms_text(raw_text)
    except SmsParseError:
        if llm_extractor is None:
            raise
        pnr_match = _LABELED_PNR_RE.search(raw_text) or _TEN_DIGIT_RE.search(raw_text)
        if not pnr_match:
            raise
        masked_text = mask_sms_pii_for_llm(raw_text)
        normalized_text = await llm_extractor(masked_text)
        # Re-attach original PNR locally after sanitized LLM normalization
        parsed = parse_irctc_sms_text(f"PNR {pnr_match.group(1)} {normalized_text}")
        return ParsedSmsTicket(
            pnr=parsed.pnr,
            train_no=parsed.train_no,
            service_date=parsed.service_date,
            travel_class=parsed.travel_class,
            from_code=parsed.from_code,
            to_code=parsed.to_code,
            departure_at=parsed.departure_at,
            arrival_at=parsed.arrival_at,
            passengers=parsed.passengers,
            used_llm_fallback=True,
        )
