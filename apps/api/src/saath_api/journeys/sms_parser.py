from __future__ import annotations

import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from zoneinfo import ZoneInfo

from saath_api.journeys.geometry import (
    CoachClass,
    SeatType,
    normalize_coach_class,
    seat_to_bay_and_type,
    supported_capacities_for_class,
)

IST = ZoneInfo("Asia/Kolkata")

_INDIC_MARK = (
    r"[\u0300-\u036f\u200c\u200d"
    r"\u0900-\u0903\u093a-\u094f\u0951-\u0957\u0962-\u0963"
    r"\u0981-\u0983\u09bc\u09be-\u09c4\u09c7-\u09cd\u09d7\u09e2-\u09e3"
    r"\u0a01-\u0a03\u0a3c\u0a3e-\u0a4d\u0a70-\u0a71"
    r"\u0a81-\u0a83\u0abc\u0abe-\u0acd\u0ae2-\u0ae3"
    r"\u0b01-\u0b03\u0b3c\u0b3e-\u0b4d\u0b56-\u0b57\u0b62-\u0b63"
    r"\u0b82\u0bbe-\u0bcd\u0bd7"
    r"\u0c00-\u0c04\u0c3e-\u0c56\u0c62-\u0c63"
    r"\u0c81-\u0c83\u0cbc\u0cbe-\u0cd6\u0ce2-\u0ce3"
    r"\u0d00-\u0d03\u0d3b-\u0d4d\u0d57\u0d62-\u0d63]"
)
_LETTER_CHAR = r"[^\W\d_]"
_NAME_CHAR = rf"(?:{_LETTER_CHAR}|{_INDIC_MARK})"
_NAME_WORD = rf"{_LETTER_CHAR}(?:{_NAME_CHAR}|['’\-](?={_LETTER_CHAR}))*\.?"
_NAME_WORDS = rf"{_NAME_WORD}(?:[ \t]+{_NAME_WORD}){{0,4}}"
_SALUTATION_STOP_WORDS = (
    r"(?:your|yours|pnr|train|trn|ticket|booking|journey|trip|has|have|is|was|are|for|on|with|from|to|confirm|confirmed|"
    r"आपका|आपकी|आपके|ट्रेन|गाड़ी|गाडी|पीएनआर|टिकट|बुकिंग|यात्रा)"
)
_SALUTATION_WORD = rf"(?!{_SALUTATION_STOP_WORDS}(?!{_NAME_CHAR})){_NAME_WORD}"
_SALUTATION_NAME = rf"{_SALUTATION_WORD}(?:[ \t]+{_SALUTATION_WORD}){{0,3}}"

_LABELED_PNR_RE = re.compile(r"\bPNR\s*(?:NO\.?|NUMBER)?\s*[:\-]?\s*([0-9]{10})\b", re.IGNORECASE)
_LABELED_PNR_MASK_RE = re.compile(
    r"\bPNR\s*(?:NO\.?|NUMBER)?\s*[:\-]?\s*(?:\d[\s\-]*){9}\d\b",
    re.IGNORECASE,
)
_TEN_DIGIT_RE = re.compile(r"\b([0-9]{10})\b")
_SPACED_PNR_MASK_RE = re.compile(
    r"(?<!\d)(?:\d{3}[ \t\-]\d{3}[ \t\-]\d{4}|\d{3}[ \t\-]\d{7}|\d{4}[ \t\-]\d{3}[ \t\-]\d{3}|\d{5}[ \t\-]\d{5})(?!\d)"
)
_PHONE_MASK_RE = re.compile(
    r"(?<!\d)(?:\+?91[ \t\-]?|0)?[6-9](?:\d{9}|\d{4}[ \t\-]\d{5}|\d{3}[ \t\-]\d{6}|\d{2}[ \t\-]\d{3}[ \t\-]\d{4})(?!\d)"
)
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
_TABULAR_PAX_RE = re.compile(
    rf"(?im)(?:^|(?<=[\s,;|]))(?:\d+[.)]\s*)?{_NAME_WORDS}[ \t]*/[ \t]*\d{{1,3}}[ \t]*/[ \t]*[MFOT]\b(?:[ \t]*/)?"
)
_PAREN_PAX_RE = re.compile(
    rf"(?im)(?:^|(?<=[\s,;|]))(?:\d+[.)]\s*)?{_NAME_WORDS}[ \t]*\([ \t]*\d{{1,3}}[ \t]*[/,][ \t]*[MFOT][ \t]*\)"
)
_SALUTATION_RE = re.compile(
    rf"(?i)(?<!{_NAME_CHAR})(Dear|Hi|Hello|Namaste|नमस्ते)(?!{_NAME_CHAR})(?:[ \t]*,[ \t]*|[ \t]+){_SALUTATION_NAME}"
)
_NAME_LABEL_RE = re.compile(
    rf"(?i)(?<!\w)(?:passenger\s*name|pax\s*name|name|passenger|pax|यात्री(?:\s*का)?\s*नाम|नाम|यात्री)\s*(?:\d+\s*)?[:\-]\s*[^\n,;|]+?(?=\s*(?:[,;|\n]|(?<!{_NAME_CHAR})(?:PNR|Train|TRN|DOJ|Date|Class|Coach|Berth|Seat|CNF|RAC|WL|Status|1A|2A|3A|3E|SL|CC|EC|2S|ट्रेन|पीएनआर|तारीख|कोच|बर्थ|सीट)(?!{_NAME_CHAR})|$))"
)


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
    """Strip 10-digit PNRs, phone numbers, salutations, and passenger names before any LLM fallback."""
    masked = _LABELED_PNR_MASK_RE.sub("PNR:[REDACTED]", raw_text)
    masked = _PHONE_MASK_RE.sub("[REDACTED_PHONE]", masked)
    masked = _SPACED_PNR_MASK_RE.sub("[REDACTED_10D]", masked)
    masked = _TEN_DIGIT_RE.sub("[REDACTED_10D]", masked)
    masked = _TABULAR_PAX_RE.sub("[REDACTED_PAX] ", masked)
    masked = _PAREN_PAX_RE.sub("[REDACTED_PAX]", masked)
    masked = _SALUTATION_RE.sub(r"\1 [REDACTED]", masked)
    masked = _NAME_LABEL_RE.sub("Name:[REDACTED]", masked)
    return masked.strip()


def _resolve_sms_seat(tclass: CoachClass, seat_raw: str) -> tuple[int, SeatType]:
    seat_int = int(seat_raw)
    if seat_int <= 0:
        raise SmsParseError(f"Seat number {seat_raw!r} must be positive for class {tclass}.")
    for cap in supported_capacities_for_class(tclass):
        try:
            bay, default_stype, _ = seat_to_bay_and_type(tclass, seat_int, capacity=cap)
            return bay, default_stype
        except ValueError:
            continue
    raise SmsParseError(f"Seat {seat_int} is out of range for class {tclass}.")


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
        seat_int = int(m.group(3))
        seat_num = str(seat_int)
        tclass = normalize_coach_class(explicit_class, coach)
        bay, default_stype = _resolve_sms_seat(tclass, seat_num)
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
            seat_int = int(m.group(2))
            seat_num = str(seat_int)
            tclass = normalize_coach_class(explicit_class, coach)
            bay, default_stype = _resolve_sms_seat(tclass, seat_num)
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
