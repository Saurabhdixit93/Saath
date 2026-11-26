from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

REDACTION_TOKEN = "•••"

_HINTS: dict[str, str] = {
    "en": "Contact details unlock after you both agree",
    "hi": "दोनों के सहमत होने पर संपर्क विवरण अनलॉक होंगे",
}

_ZERO_WIDTH_CHARS: frozenset[str] = frozenset({"\u200b", "\u200c", "\u200d", "\ufeff", "\u00ad"})
_DEVANAGARI_DIGITS = str.maketrans("०१२३४५६७८९", "0123456789")

_DIGIT_WORDS: dict[str, int] = {
    # English
    "zero": 1,
    "oh": 1,
    "one": 1,
    "two": 1,
    "three": 1,
    "four": 1,
    "five": 1,
    "six": 1,
    "seven": 1,
    "eight": 1,
    "nine": 1,
    # Hinglish / transliterated Hindi
    "shunya": 1,
    "shoonya": 1,
    "sifar": 1,
    "ek": 1,
    "do": 1,
    "teen": 1,
    "char": 1,
    "chaar": 1,
    "paanch": 1,
    "panch": 1,
    "chhe": 1,
    "che": 1,
    "chhah": 1,
    "saat": 1,
    "sat": 1,
    "aath": 1,
    "ath": 1,
    "nau": 1,
    # Devanagari Hindi digit words
    "शून्य": 1,
    "सुन्ना": 1,
    "एक": 1,
    "दो": 1,
    "तीन": 1,
    "चार": 1,
    "पांच": 1,
    "पाँच": 1,
    "छह": 1,
    "छः": 1,
    "छे": 1,
    "सात": 1,
    "आठ": 1,
    "नौ": 1,
}

_MULTIPLIER_WORDS: dict[str, int] = {
    "double": 2,
    "triple": 3,
    "डबल": 2,
    "ट्रिपल": 3,
}

_CONNECTOR_WORDS: frozenset[str] = frozenset({"and", "aur", "और"})
_SEGMENTABLE_WORDS: frozenset[str] = (
    frozenset(_DIGIT_WORDS) | frozenset(_MULTIPLIER_WORDS) | _CONNECTOR_WORDS
)
_MAX_SEGMENTABLE_WORD_LEN: int = max(len(w) for w in _SEGMENTABLE_WORDS)

# 1. URLs (http/https, www., known shorteners/messengers, bare domains, spaced URLs)
_URL_TLDS = (
    r"(?:com|in|co\.in|co|ai|org|net|io|me|app|xyz|ly|gg|"
    r"info|biz|site|online|link|dev|tech|cc|tv|to)"
)
_URL_PATH_CHARS = r"[^\s<>\"'{}|\\^`\[\]]"
_URL_RE = re.compile(
    r"(?i)(?:"
    rf"https?://{_URL_PATH_CHARS}+"
    rf"|www\.{_URL_PATH_CHARS}+"
    rf"|(?:wa\.me|t\.me|t\.co|bit\.ly|tinyurl\.com|goo\.gl|youtu\.be|x\.com|wa\.link|rb\.gy|is\.gd|cutt\.ly|instagram\.com|instagr\.am|fb\.com|facebook\.com|telegram\.me)/{_URL_PATH_CHARS}*"
    rf"|\b(?:[a-z0-9-]{{2,}}(?:\.[a-z0-9-]+)*|[a-z0-9-]+(?:\.[a-z0-9-]+)+)\.{_URL_TLDS}\b(?:/{_URL_PATH_CHARS}*)?"
    rf"|\b[a-z0-9-]\.{_URL_TLDS}/{_URL_PATH_CHARS}+"
    r")"
)
_DOT_BRACKET = r"(?:\[dot\]|\(dot\)|\{dot\})"
_DOT_OR_BRACKET = rf"(?:\s*\.\s*|\s*{_DOT_BRACKET}\s*)"
_SPACED_URL_TLDS = (
    rf"(?:com|in|co{_DOT_OR_BRACKET}in|co|ai|org|net|io|me|app|xyz|ly|gg|"
    r"info|biz|site|online|link|dev|tech|cc|tv|to)"
)
_BRACKET_URL_TLDS = (
    rf"(?:com|in|co\s*{_DOT_BRACKET}\s*in|co|ai|org|net|io|me|app|xyz|ly|gg|"
    r"info|biz|site|online|link|dev|tech|cc|tv|to)"
)
_URL_SHORTENERS_SPACED = (
    rf"(?:bit{_DOT_OR_BRACKET}ly|t{_DOT_OR_BRACKET}co|tinyurl{_DOT_OR_BRACKET}com|"
    rf"goo{_DOT_OR_BRACKET}gl|youtu{_DOT_OR_BRACKET}be|x{_DOT_OR_BRACKET}com|"
    rf"wa{_DOT_OR_BRACKET}link|rb{_DOT_OR_BRACKET}gy|is{_DOT_OR_BRACKET}gd|"
    rf"cutt{_DOT_OR_BRACKET}ly|instagram{_DOT_OR_BRACKET}com|instagr{_DOT_OR_BRACKET}am|"
    rf"fb{_DOT_OR_BRACKET}com|facebook{_DOT_OR_BRACKET}com|telegram{_DOT_OR_BRACKET}me)"
)
_SPACED_URL_RE = re.compile(
    r"(?i)(?:"
    rf"\b(?:wa|t){_DOT_OR_BRACKET}me\s*/\s*{_URL_PATH_CHARS}+"
    rf"|\b{_URL_SHORTENERS_SPACED}\s*/\s*{_URL_PATH_CHARS}*"
    rf"|\b[a-z0-9-]+(?:\s*\.\s*[a-z0-9-]+)*{_DOT_OR_BRACKET}"
    rf"{_SPACED_URL_TLDS}\s*/\s*{_URL_PATH_CHARS}+"
    rf"|\bwww{_DOT_OR_BRACKET}[a-z0-9-]+(?:{_DOT_OR_BRACKET}[a-z0-9-]+)+"
    rf"(?:\s*/\s*{_URL_PATH_CHARS}*)?"
    rf"|\b[a-z0-9-]+(?:\s*{_DOT_BRACKET}\s*[a-z0-9-]+)*\s*{_DOT_BRACKET}\s*"
    rf"{_BRACKET_URL_TLDS}\b(?:\s*/\s*{_URL_PATH_CHARS}*)?"
    r")"
)

# 2. Standard & obfuscated emails
_EMAIL_STD_RE = re.compile(
    r"(?i)\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b"
)
_EMAIL_OBFUSCATED_RE = re.compile(
    r"(?i)\b[a-z0-9._%+-]+\s*(?:\[at\]|\(at\)|\{at\}|@)\s*[a-z0-9.-]+\s*(?:\[dot\]|\(dot\)|\{dot\}|\bdot\b|\.)\s*[a-z]{2,}(?:\s*(?:\[dot\]|\(dot\)|\{dot\}|\bdot\b|\.)\s*[a-z]{2,})?(?!/)\b"
)
_EMAIL_WORD_AT_RE = re.compile(
    r"(?i)\b[a-z0-9._%+-]+\s+at\s+(?:[a-z0-9-]+\s*(?:\[dot\]|\(dot\)|\{dot\}|\bdot\b|\.)\s*(?:com|in|org|net|co|io|me|edu|gov|gmail|yahoo|outlook|hotmail|proton|icloud)(?:\s*(?:\[dot\]|\(dot\)|\{dot\}|\bdot\b|\.)\s*[a-z]{2,})?|(?:gmail|yahoo|outlook|hotmail|proton|icloud)\s+(?:dot\s+)?(?:com|in|co\.in))(?!/)\b"
)

# 3. UPI IDs (handle@psp, alphanumeric PSP handles, and obfuscated [at]/at PSP handles)
# Plain-word "at" is restricted to unambiguous UPI-exclusive PSP handles so meetup phrases
# like "Meet at SBI counter" or "Wait at Airtel kiosk" are never redacted.
_UNAMBIGUOUS_UPI_PSPS = (
    r"ok(?:axis|icici|sbi|hdfcbank|bizaxis)|ybl|ibl|axl|paytm|ptyes|ptaxis|pthdfc|ptsbi|"
    r"upi|apl|yapl|rapl|barodampay|jiopay|fampay|waicici|wahdfcbank|wasbi|waaxis|pingpay|"
    r"naviaxis|abfspay|ikwik|timecosmos|tapicici|payzapp|superyes"
)
_GENERIC_BANK_UPI_PSPS = (
    r"icici|hdfcbank|sbi|axisbank|kotak811|kotak|indus|fbl|airtel|jio|"
    r"slice|jupiter|cred|fam|idfcbank|yesbank|hsbc|citi|scb|unionbank|pnb|bob|boi|canara|"
    r"centralbank|freecharge|aubank|federal|kvb|rbl|dbs|bandhan"
)
_KNOWN_UPI_PSPS = rf"{_UNAMBIGUOUS_UPI_PSPS}|{_GENERIC_BANK_UPI_PSPS}"
_UPI_PSP_RE = re.compile(
    rf"(?i)\b[a-z0-9._-]{{2,}}@(?:{_KNOWN_UPI_PSPS})\b"
)
_UPI_GENERIC_RE = re.compile(r"(?i)\b[a-z0-9._-]{2,}@[a-z][a-z0-9]{2,19}\b")
_UPI_OBFUSCATED_KNOWN_RE = re.compile(
    rf"(?i)\b[a-z0-9._-]{{2,}}\s*(?:\[at\]|\(at\)|\{{at\}}|\bat\b)\s*(?:{_UNAMBIGUOUS_UPI_PSPS})\b"
)
_UPI_OBFUSCATED_BRACKET_RE = re.compile(
    r"(?i)\b[a-z0-9._-]{2,}\s*(?:\[at\]|\(at\)|\{at\})\s*[a-z][a-z0-9]{2,19}\b(?!/)(?!\s*(?:\[dot\]|\(dot\)|\{dot\}|\bdot\b|\.))",
)

# 4. Numeric phone patterns (standard, +91, 0-prefixed, spaced/hyphenated/typographic dashes/:/ */dotted/parens)
_PHONE_SEP = r"[\s.\-_()*:\u2010-\u2014\u2212]"
_PHONE_EXPLICIT_RE = re.compile(
    rf"(?<!\d)(?:\(\s*\+?91\s*\)|(?:\+?91|0)){_PHONE_SEP}*[6-9](?:{_PHONE_SEP}*\d){{9}}(?!\d)"
)
_PHONE_10_SEPARATED_RE = re.compile(
    rf"(?<!\d)[6-9](?:{_PHONE_SEP}*\d){{9}}(?!\d)"
)
_PHONE_INTL_RE = re.compile(
    rf"(?<!\w)\+\d{{1,3}}{_PHONE_SEP}*\d(?:{_PHONE_SEP}*\d){{7,13}}(?!\d)"
)
_DATE_LIKE_RE = re.compile(
    r"^(?:\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{2,4})$"
)
_DATE_EMBEDDED_RE = re.compile(
    r"(?:\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b|\b\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\b)"
)
_SEAT_CONTEXT_RE = re.compile(
    r"(?i)(?:\b(?:seats?|berths?|coaches?|coach|bays?|bunks?)\b|सीटें?|बर्थ|कोच)"
)
_TRAIN_CONTEXT_RE = re.compile(
    r"(?i)(?:\btrains?\b|गाड़ी|ट्रेन)"
)

# Token pattern for mixed/word-digit sequences (Latin letters, Devanagari letters+matras, or digits)
_WORD_OR_NUM_TOKEN_RE = re.compile(r"[0-9]+|(?:[^\W\d_]|[\u0900-\u097F])+", re.UNICODE)
_SEPARATORS_ONLY_RE = re.compile(r"^[\s\-_.,/|()\[\]+*:\u2010-\u2014\u2212]+$")


@dataclass(frozen=True)
class RedactionResult:
    text: str
    redacted: bool
    categories: tuple[str, ...]
    hint: str | None


def _is_invisible_format_char(ch: str) -> bool:
    return unicodedata.category(ch) == "Cf" or ch in _ZERO_WIDTH_CHARS


def _strip_invisible(text: str) -> str:
    return "".join(ch for ch in text if not _is_invisible_format_char(ch))


def _prepare_scan_views(raw: str) -> tuple[str, str, str, list[int]]:
    nfkc = unicodedata.normalize("NFKC", raw).translate(_DEVANAGARI_DIGITS)
    stripped_chars: list[str] = []
    spaced_chars: list[str] = []
    stripped_to_nfkc: list[int] = []
    for idx, ch in enumerate(nfkc):
        if _is_invisible_format_char(ch):
            spaced_chars.append(" ")
        else:
            stripped_chars.append(ch)
            stripped_to_nfkc.append(idx)
            spaced_chars.append(ch)
    return nfkc, "".join(stripped_chars), "".join(spaced_chars), stripped_to_nfkc


def _is_benign_comma_seat_list(
    sub: str,
    numeric_tokens: list[str],
    prefix: str,
) -> bool:
    if "," not in sub or len(numeric_tokens) < 3:
        return False
    if not all(t.isdigit() and t == str(int(t)) for t in numeric_tokens):
        return False
    vals = [int(t) for t in numeric_tokens]
    # Exempt strictly consecutive ascending 1-2 digit seat lists like "61, 62, 63, 64, 65"
    if all(1 <= v <= 99 for v in vals) and all(
        vals[i] == vals[i - 1] + 1 for i in range(1, len(vals))
    ):
        return True
    # Exempt strictly ascending seat/berth/coach lists <= 120 preceded by seat context
    return bool(
        _SEAT_CONTEXT_RE.search(prefix)
        and all(1 <= v <= 120 for v in vals)
        and all(vals[i] > vals[i - 1] for i in range(1, len(vals)))
    )


def _looks_like_pure_numeric_phone(
    sub: str,
    numeric_tokens: list[str],
    prefix: str = "",
) -> bool:
    if _DATE_EMBEDDED_RE.search(sub):
        return False
    # Exempt explicit "train"/"trains" 5-digit pairs like "Checking trains 62001 / 62002"
    if (
        len(numeric_tokens) == 2
        and all(len(t) == 5 for t in numeric_tokens)
        and "/" in sub
        and _TRAIN_CONTEXT_RE.search(prefix)
    ):
        return False
    if _is_benign_comma_seat_list(sub, numeric_tokens, prefix):
        return False
    digits_only = "".join(numeric_tokens)
    if len(digits_only) < 10:
        return False
    if sub.lstrip().startswith("+"):
        return True
    if digits_only[0] in "6789" and len(digits_only) == 10:
        return True
    if digits_only.startswith("0") and len(digits_only) == 11 and digits_only[1] in "6789":
        return True
    if digits_only.startswith("91") and len(digits_only) == 12 and digits_only[2] in "6789":
        return True
    return False


@dataclass(frozen=True)
class _ExpandedWordToken:
    text: str
    start: int
    end: int
    check_prev_gap: bool


def _segment_fused_word_tokens(tok: str) -> list[str] | None:
    n = len(tok)
    if n == 0:
        return None
    dp: list[list[str] | None] = [None] * (n + 1)
    dp[0] = []
    for i in range(n):
        prefix_parts = dp[i]
        if prefix_parts is None:
            continue
        limit = min(n, i + _MAX_SEGMENTABLE_WORD_LEN)
        for j in range(i + 1, limit + 1):
            piece = tok[i:j]
            if piece in _SEGMENTABLE_WORDS:
                candidate = [*prefix_parts, piece]
                existing = dp[j]
                if existing is None or len(candidate) < len(existing):
                    dp[j] = candidate
    return dp[n]


def _find_word_digit_spans(
    scan_text: str,
    stripped_to_nfkc: list[int] | None = None,
) -> list[tuple[int, int]]:
    raw_tokens = list(_WORD_OR_NUM_TOKEN_RE.finditer(scan_text))
    if not raw_tokens:
        return []

    tokens: list[_ExpandedWordToken] = []
    for tok_match in raw_tokens:
        tok_lower = tok_match.group(0).lower()
        tok_start = tok_match.start()
        tok_end = tok_match.end()
        if (
            stripped_to_nfkc is not None
            and tok_end > tok_start
            and not tok_lower.isdigit()
            and tok_lower not in _SEGMENTABLE_WORDS
            and (stripped_to_nfkc[tok_end - 1] - stripped_to_nfkc[tok_start] + 1)
            > (tok_end - tok_start)
        ):
            parts = _segment_fused_word_tokens(tok_lower)
            if parts:
                offset = tok_start
                for part_idx, part in enumerate(parts):
                    part_end = offset + len(part)
                    tokens.append(
                        _ExpandedWordToken(
                            text=part,
                            start=offset,
                            end=part_end,
                            check_prev_gap=(part_idx == 0),
                        )
                    )
                    offset = part_end
                continue
        tokens.append(
            _ExpandedWordToken(
                text=tok_lower,
                start=tok_start,
                end=tok_end,
                check_prev_gap=True,
            )
        )

    spans: list[tuple[int, int]] = []
    idx = 0
    while idx < len(tokens):
        # Try growing a digit-word / digit run starting at idx
        j = idx
        digit_count = 0
        word_digit_count = 0
        non_ambiguous_word_count = 0
        used_multiplier = False
        numeric_tokens: list[str] = []
        pending_mult = 1
        last_valid_j = -1

        while j < len(tokens):
            tok_entry = tokens[j]
            tok = tok_entry.text

            if j > idx and tok_entry.check_prev_gap:
                gap = scan_text[tokens[j - 1].end : tok_entry.start]
                if not _SEPARATORS_ONLY_RE.fullmatch(gap):
                    # Allow single connector word ("and"/"aur") only if preceded by valid gap
                    break

            if tok in _CONNECTOR_WORDS and j > idx:
                j += 1
                continue

            if tok in _MULTIPLIER_WORDS:
                pending_mult = _MULTIPLIER_WORDS[tok]
                used_multiplier = True
                j += 1
                continue

            if tok.isdigit():
                digit_count += len(tok) * pending_mult
                numeric_tokens.append(tok)
                pending_mult = 1
                last_valid_j = j
                j += 1
                continue

            if tok in _DIGIT_WORDS:
                digit_count += pending_mult
                word_digit_count += 1
                if tok not in ("do", "no", "oh"):
                    non_ambiguous_word_count += 1
                pending_mult = 1
                last_valid_j = j
                j += 1
                continue

            break

        if last_valid_j >= idx:
            span_start = tokens[idx].start
            span_end = tokens[last_valid_j].end
            sub = scan_text[span_start:span_end].strip()
            prefix = scan_text[max(0, span_start - 32) : span_start]
            # Match if:
            # - >= 7 digits with >= 3 digit words (at least 2 non-ambiguous)
            # - OR >= 10 total digits across mixed numeric/word tokens (excluding dates, seat lists, train pairs)
            is_word_phone = word_digit_count >= 3 and non_ambiguous_word_count >= 2 and digit_count >= 7
            if word_digit_count > 0 or used_multiplier:
                is_numeric_phone = digit_count >= 10 and not _DATE_EMBEDDED_RE.search(sub)
            else:
                is_numeric_phone = _looks_like_pure_numeric_phone(sub, numeric_tokens, prefix)
            if is_word_phone or is_numeric_phone:
                spans.append((span_start, span_end))
                idx = last_valid_j + 1
                continue

        idx += 1

    return spans


def _collect_tagged_spans(
    scan: str,
    stripped_to_nfkc: list[int] | None = None,
) -> list[tuple[int, int, str]]:
    tagged: list[tuple[int, int, str]] = []

    for regex in (_URL_RE, _SPACED_URL_RE):
        for m in regex.finditer(scan):
            tagged.append((m.start(), m.end(), "url"))

    for regex in (_EMAIL_STD_RE, _EMAIL_OBFUSCATED_RE, _EMAIL_WORD_AT_RE):
        for m in regex.finditer(scan):
            tagged.append((m.start(), m.end(), "email"))

    for regex in (
        _UPI_PSP_RE,
        _UPI_GENERIC_RE,
        _UPI_OBFUSCATED_KNOWN_RE,
        _UPI_OBFUSCATED_BRACKET_RE,
    ):
        for m in regex.finditer(scan):
            tagged.append((m.start(), m.end(), "upi"))

    for regex in (_PHONE_EXPLICIT_RE, _PHONE_10_SEPARATED_RE, _PHONE_INTL_RE):
        for m in regex.finditer(scan):
            sub = scan[m.start() : m.end()].strip()
            if not _DATE_LIKE_RE.fullmatch(sub):
                tagged.append((m.start(), m.end(), "phone"))

    for start, end in _find_word_digit_spans(scan, stripped_to_nfkc=stripped_to_nfkc):
        tagged.append((start, end, "phone"))

    return tagged


def _merge_spans(tagged_spans: list[tuple[int, int, str]]) -> list[tuple[int, int, str]]:
    if not tagged_spans:
        return []
    ordered = sorted(tagged_spans, key=lambda item: (item[0], -(item[1] - item[0])))
    merged: list[tuple[int, int, str]] = [ordered[0]]
    for start, end, cat in ordered[1:]:
        prev_start, prev_end, prev_cat = merged[-1]
        if start < prev_end:
            merged[-1] = (prev_start, max(prev_end, end), prev_cat)
        else:
            merged.append((start, end, cat))
    return merged


def redact_contact_details(text: str, *, locale: str = "en") -> RedactionResult:
    """Redact phones (numeric/Devanagari/word-based), emails, URLs, and UPI IDs pre-accept."""
    if not text:
        return RedactionResult(text=text, redacted=False, categories=(), hint=None)

    nfkc, scan_stripped, scan_spaced, stripped_to_nfkc = _prepare_scan_views(text)
    tagged_nfkc: list[tuple[int, int, str]] = []

    for start, end, cat in _collect_tagged_spans(scan_stripped, stripped_to_nfkc=stripped_to_nfkc):
        if start < end:
            tagged_nfkc.append((stripped_to_nfkc[start], stripped_to_nfkc[end - 1] + 1, cat))

    if scan_spaced != scan_stripped:
        tagged_nfkc.extend(_collect_tagged_spans(scan_spaced))

    if not tagged_nfkc:
        return RedactionResult(text=text, redacted=False, categories=(), hint=None)

    merged = _merge_spans(tagged_nfkc)
    out_parts: list[str] = []
    cursor = 0
    categories_seen: list[str] = []
    for start, end, cat in merged:
        out_parts.append(_strip_invisible(nfkc[cursor:start]))
        out_parts.append(REDACTION_TOKEN)
        cursor = end
        if cat not in categories_seen:
            categories_seen.append(cat)
    out_parts.append(_strip_invisible(nfkc[cursor:]))

    hint = _HINTS["hi"] if locale == "hi" else _HINTS["en"]
    return RedactionResult(
        text="".join(out_parts),
        redacted=True,
        categories=tuple(categories_seen),
        hint=hint,
    )
