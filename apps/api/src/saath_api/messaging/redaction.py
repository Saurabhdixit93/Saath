from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

REDACTION_TOKEN = "•••"

_HINTS: dict[str, str] = {
    "en": "Contact details unlock after you both agree",
    "hi": "दोनों के सहमत होने पर संपर्क विवरण अनलॉक होंगे",
}

_ZERO_WIDTH_CHARS: frozenset[str] = frozenset(
    {"\u200b", "\u200c", "\u200d", "\ufeff", "\u00ad", "\u034f", "\u180e"}
)
_KEYCAP_VARIATION_CHARS: frozenset[str] = frozenset({"\ufe0e", "\ufe0f", "\u20e3"})
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
    "tin": 1,
    "char": 1,
    "chaar": 1,
    "paanch": 1,
    "panch": 1,
    "chhe": 1,
    "che": 1,
    "chhah": 1,
    "cheh": 1,
    "chheh": 1,
    "saat": 1,
    "sat": 1,
    "aath": 1,
    "ath": 1,
    "nau": 1,
    "sunna": 1,
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
_BENIGN_FUSED_EXCLUSIONS: frozenset[str] = frozenset(
    {"cheek", "dodo", "fourche", "fourteen", "nineteen", "seventeen", "sixteen"}
)

# 1. URLs (http/https, www., known shorteners/messengers, bare domains, spaced URLs)
_URL_TLDS = (
    r"(?:com|in|co\.in|co|ai|org|net|io|me|app|xyz|ly|gg|"
    r"info|biz|site|online|link|dev|tech|cc|tv|to|at)"
)
_BARE_SINGLE_LABEL_TLDS = (
    r"(?:com|co\.in|co|ai|org|net|io|app|xyz|gg|"
    r"info|biz|site|online|link|dev|tech|cc|tv)"
)
_UNAMBIGUOUS_WEB_TLDS = r"(?:com|org|net|io|app|xyz|dev|tech|site|online|link|co\.in)"
_NON_NUMERIC_LABEL = r"(?=[a-z0-9-]*[a-z])[a-z0-9-]"
_URL_PATH_CHARS = r"[^\s<>\"'{}|\\^`\[\]]"
_URL_RE = re.compile(
    r"(?i)(?:"
    rf"https?://{_URL_PATH_CHARS}+"
    rf"|www\.{_URL_PATH_CHARS}+"
    rf"|\b(?:wa\.me|t\.me|t\.co|bit\.ly|ow\.ly|cutt\.ly|adf\.ly|snip\.ly|rb\.gy|is\.gd|shorturl\.at|tinyurl\.com|goo\.gl|youtu\.be|x\.com|wa\.link|instagram\.com|instagr\.am|insta\.gram|fb\.com|facebook\.com|telegram\.me|tele\.gram|snap\.chat)\b(?:/{_URL_PATH_CHARS}*)?"
    rf"|\b{_NON_NUMERIC_LABEL}{{2,}}\.{_BARE_SINGLE_LABEL_TLDS}\b(?:/{_URL_PATH_CHARS}*)?"
    rf"|\b(?=[a-z0-9.-]*[a-z])[a-z0-9-]+(?:\.[a-z0-9-]+)+\.{_URL_TLDS}\b(?:/{_URL_PATH_CHARS}*)?"
    rf"|\b[0-9-]+(?:\.[0-9-]+)*\.{_UNAMBIGUOUS_WEB_TLDS}\b(?:/{_URL_PATH_CHARS}*)?"
    rf"|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.{_URL_TLDS}/{_URL_PATH_CHARS}+"
    r")"
)
_DOT_BRACKET = r"(?:\[dot\]|\(dot\)|\{dot\})"
_DOT_OR_BRACKET = rf"(?:\s*\.\s*|\s*{_DOT_BRACKET}\s*)"
_DOT_OR_WORD = rf"(?:{_DOT_OR_BRACKET}|\s+\bdot\b\s+)"
_SPACED_URL_TLDS = (
    rf"(?:com|in|co{_DOT_OR_BRACKET}in|co|ai|org|net|io|me|app|xyz|ly|gg|"
    r"info|biz|site|online|link|dev|tech|cc|tv|to|at)"
)
_BRACKET_URL_TLDS = (
    rf"(?:com|in|co\s*{_DOT_BRACKET}\s*in|co|ai|org|net|io|me|app|xyz|ly|gg|"
    r"info|biz|site|online|link|dev|tech|cc|tv|to|at)"
)
_URL_SHORTENERS_SPACED = (
    rf"(?:bit{_DOT_OR_WORD}ly|ow{_DOT_OR_WORD}ly|cutt{_DOT_OR_WORD}ly|adf{_DOT_OR_WORD}ly|snip{_DOT_OR_WORD}ly|"
    rf"t{_DOT_OR_WORD}co|tinyurl{_DOT_OR_WORD}com|shorturl{_DOT_OR_WORD}at|"
    rf"goo{_DOT_OR_WORD}gl|youtu{_DOT_OR_WORD}be|x{_DOT_OR_WORD}com|"
    rf"wa{_DOT_OR_WORD}link|rb{_DOT_OR_WORD}gy|is{_DOT_OR_WORD}gd|"
    rf"instagram{_DOT_OR_WORD}com|instagr{_DOT_OR_WORD}am|insta{_DOT_OR_WORD}gram|"
    rf"fb{_DOT_OR_WORD}com|facebook{_DOT_OR_WORD}com|telegram{_DOT_OR_WORD}me|"
    rf"tele{_DOT_OR_WORD}gram|snap{_DOT_OR_WORD}chat)"
)
_SPACED_URL_RE = re.compile(
    r"(?i)(?:"
    rf"\b(?:wa|t){_DOT_OR_WORD}me(?:\s*/\s*{_URL_PATH_CHARS}+|\b)"
    rf"|\b{_URL_SHORTENERS_SPACED}\b(?:\s*/\s*{_URL_PATH_CHARS}*)?"
    rf"|\b[a-z0-9-]\s*(?:\.\s*|{_DOT_BRACKET}\s*){_SPACED_URL_TLDS}/{_URL_PATH_CHARS}+"
    rf"|\b(?:{_NON_NUMERIC_LABEL}{{2,}}(?:\s*\.\s*[a-z0-9-]+)*|(?=[a-z0-9.\s-]*[a-z])[a-z0-9-]+(?:\s*\.\s*[a-z0-9-]+)+){_DOT_OR_BRACKET}"
    rf"{_SPACED_URL_TLDS}\s*/\s*{_URL_PATH_CHARS}+"
    rf"|\bwww{_DOT_OR_WORD}[a-z0-9-]+(?:{_DOT_OR_WORD}[a-z0-9-]+)+"
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
    r"(?i)\b[a-z0-9._%+-]+\s*(?:\[at\]|\(at\)|\{at\}|@)\s*[a-z0-9.-]+\s*(?:\[dot\]|\(dot\)|\{dot\}|\bdot\b|\.)\s*[a-z]{2,}(?:\s*(?:\[dot\]|\(dot\)|\{dot\}|\bdot\b|\.)\s*[a-z]{2,})*(?!/)\b"
)
_EMAIL_WORD_AT_RE = re.compile(
    r"(?i)\b[a-z0-9._%+-]+\s+at\s+(?!\d+\s*\.\s*to\b)(?:(?:[a-z0-9-]+\s*(?:\[dot\]|\(dot\)|\{dot\}|\bdot\b|\.)\s*){1,5}(?:com|in|org|net|co|ai|io|me|app|dev|tech|edu|gov|xyz|info|biz|site|online|link|ly|gg|cc|tv|to|uk|au|ca|sg|ae|de|fr|us|gmail|yahoo|outlook|hotmail|proton|icloud)(?:\s*(?:\[dot\]|\(dot\)|\{dot\}|\bdot\b|\.)\s*[a-z]{2,})?|(?:gmail|yahoo|outlook|hotmail|proton|icloud)\s+(?:dot\s+)?(?:com|in|co\.in))(?!/)\b"
)

# 3. UPI IDs (handle@psp, alphanumeric PSP handles, and obfuscated [at]/at PSP handles)
# Plain-word "at" is restricted to unambiguous UPI-exclusive PSP handles so meetup phrases
# like "Meet at SBI counter" or "Wait at Airtel kiosk" are never redacted.
_STRICT_UPI_PSPS = (
    r"ok(?:axis|icici|sbi|hdfcbank|hdfc|bizaxis)|ybl|ibl|axl|axb|kmbl|yespay|"
    r"paytm|ptyes|ptaxis|pthdfc|ptsbi|upi|apl|yapl|rapl|barodampay|jiopay|fampay|"
    r"waicici|wahdfcbank|wasbi|waaxis|pingpay|naviaxis|abfspay|ikwik|timecosmos|"
    r"tapicici|payzapp|superyes|freecharge|mobikwik|sib|jupiteraxis|yescred|yescurie|"
    r"yestpz|yesfam|postbank|idbi|mahb"
)
_MEETUP_GUARDED_APP_UPI_PSPS = r"kotak811|phonepe|gpay"
_UNAMBIGUOUS_UPI_PSPS = rf"{_STRICT_UPI_PSPS}|{_MEETUP_GUARDED_APP_UPI_PSPS}"
_GENERIC_BANK_UPI_PSPS = (
    r"icici|hdfcbank|sbi|axisbank|kotak|indus|fbl|airtel|jio|"
    r"slice|jupiter|cred|fam|idfcbank|yesbank|hsbc|citi|scb|unionbank|pnb|bob|boi|canara|"
    r"centralbank|aubank|federal|kvb|rbl|dbs|bandhan"
)
_KNOWN_UPI_PSPS = rf"{_UNAMBIGUOUS_UPI_PSPS}|{_GENERIC_BANK_UPI_PSPS}"
_MEETUP_PRE_AT_WORDS: frozenset[str] = frozenset(
    {
        "am",
        "are",
        "arrive",
        "arrived",
        "available",
        "back",
        "be",
        "check",
        "down",
        "everyone",
        "her",
        "here",
        "him",
        "is",
        "look",
        "me",
        "meet",
        "meeting",
        "reach",
        "reached",
        "sit",
        "sitting",
        "someone",
        "stand",
        "standing",
        "stay",
        "stop",
        "them",
        "there",
        "up",
        "us",
        "wait",
        "waiting",
        "was",
        "were",
        "you",
    }
)
_UPI_PSP_RE = re.compile(
    rf"(?i)\b[a-z0-9._-]{{2,}}@(?:{_KNOWN_UPI_PSPS})\b"
)
_UPI_GENERIC_RE = re.compile(r"(?i)\b[a-z0-9._-]{2,}@[a-z][a-z0-9]{2,19}\b")
_UPI_OBFUSCATED_BRACKET_KNOWN_RE = re.compile(
    rf"(?i)\b[a-z0-9._-]{{2,}}\s*(?:\[at\]|\(at\)|\{{at\}})\s*(?:{_UNAMBIGUOUS_UPI_PSPS})\b"
)
_UPI_OBFUSCATED_WORD_AT_STRICT_RE = re.compile(
    rf"(?i)\b([a-z0-9._-]{{2,}})\s+at\s+(?:{_STRICT_UPI_PSPS})\b"
    r"(?!\s+(?:desk|counter|kiosk|branch|atm|booth|office|gate|window|stall|shop|store)\b)"
)
_UPI_OBFUSCATED_WORD_AT_KNOWN_RE = re.compile(
    rf"(?i)\b([a-z0-9._-]{{2,}})\s+at\s+(?:{_MEETUP_GUARDED_APP_UPI_PSPS})\b"
    r"(?!\s+(?:desk|counter|kiosk|branch|atm|booth|office|gate|window|stall|shop|store)\b)"
)
_UPI_SPACED_AT_STRICT_RE = re.compile(
    rf"(?i)\b([a-z0-9._-]{{2,}})(?:\s+@\s*|\s*@\s+)(?:{_STRICT_UPI_PSPS})\b"
    r"(?!\s+(?:desk|counter|kiosk|branch|atm|booth|office|gate|window|stall|shop|store)\b)"
    r"(?!\s*(?:\[dot\]|\(dot\)|\{dot\}|\bdot\b|\.)\s*[a-z])"
)
_UPI_SPACED_AT_KNOWN_RE = re.compile(
    rf"(?i)\b([a-z0-9._-]{{2,}})(?:\s+@\s*|\s*@\s+)(?:{_MEETUP_GUARDED_APP_UPI_PSPS}|{_GENERIC_BANK_UPI_PSPS})\b"
    r"(?!\s+(?:desk|counter|kiosk|branch|atm|booth|office|gate|window|stall|shop|store)\b)"
    r"(?!\s*(?:\[dot\]|\(dot\)|\{dot\}|\bdot\b|\.)\s*[a-z])"
)
_UPI_OBFUSCATED_BRACKET_RE = re.compile(
    r"(?i)\b[a-z0-9._-]{2,}\s*(?:\[at\]|\(at\)|\{at\})\s*[a-z][a-z0-9]{2,19}\b(?!/)(?!\s*(?:\[dot\]|\(dot\)|\{dot\}|\bdot\b|\.))",
)

# 4. Numeric phone patterns (standard, +91, 0-prefixed, symbol/emoji/whitespace-separated)
_PHONE_SEP = r"(?:[^\w,/]|_)"
_PHONE_INTL_SEP = r"(?:[^\w]|_)"
_PHONE_EXPLICIT_RE = re.compile(
    rf"(?<!\d)(?:\(\s*\+?91\s*\)|(?:\+?91|0)){_PHONE_SEP}*[6-9](?:{_PHONE_SEP}*\d){{9}}(?!\d)"
)
_PHONE_10_SEPARATED_RE = re.compile(
    rf"(?<!\d)[6-9](?:{_PHONE_SEP}*\d){{9}}(?!\d)"
)
_PHONE_DECOY_10_RE = re.compile(
    r"(?<!\d)(?=\d{11,22}(?!\d))\d*[6-9]\d{9}\d*(?!\d)"
)
_PHONE_INTL_RE = re.compile(
    rf"(?<!\w)(?:\(\s*\+\d{{1,3}}\s*\)|\+\d{{1,3}}){_PHONE_INTL_SEP}*\d(?:{_PHONE_INTL_SEP}*\d){{7,13}}(?!\d)"
)
_LEADING_PLUS_RE = re.compile(r"(?<!\w)\+\s*$")
_DATE_SLASH = (
    r"(?:(?:19|20)\d{2}/(?:0?[1-9]|1[0-2])/(?:0?[1-9]|[12]\d|3[01])"
    r"|(?:(?:0?[1-9]|[12]\d|3[01])/(?:0?[1-9]|1[0-2])"
    r"|(?:0?[1-9]|1[0-2])/(?:0?[1-9]|[12]\d|3[01]))/(?:19|20)?\d{2})"
)
_DATE_HYPHEN = (
    r"(?:(?:19|20)\d{2}-(?:0?[1-9]|1[0-2])-(?:0?[1-9]|[12]\d|3[01])"
    r"|(?:(?:0?[1-9]|[12]\d|3[01])-(?:0?[1-9]|1[0-2])"
    r"|(?:0?[1-9]|1[0-2])-(?:0?[1-9]|[12]\d|3[01]))-(?:19|20)?\d{2})"
)
_DATE_BODY = rf"(?:{_DATE_SLASH}|{_DATE_HYPHEN})"
_DATE_LIKE_RE = re.compile(rf"^{_DATE_BODY}$")
_DATE_EMBEDDED_RE = re.compile(rf"(?<![/\-\d]){_DATE_BODY}(?![/\-\d])")
_SEAT_CONTEXT_RE = re.compile(
    r"(?i)(?:\b(?:seats?|berths?|coaches?|coach|bays?|bunks?)\b|सीटें?|बर्थ|कोच)"
)
_COACH_CODE_RE = re.compile(r"(?i)\b(?:[BSHAGMCEDF]|SL|CC|EC|AC|[BSA]E)\d{1,2}\b")
_PHONE_CONTEXT_RE = re.compile(
    r"(?i)\b(?:call|phone|mobile|mob|whatsapp|wa|contact|reach|ping|text|dial|ring|number|no\.?)\b"
)
_TRAIN_CONTEXT_RE = re.compile(
    r"(?i)(?:\btrains?\b|गाड़ी|ट्रेन)"
)

# Token pattern for mixed/word-digit sequences (Latin letters, Devanagari letters+matras, or digits)
_WORD_OR_NUM_TOKEN_RE = re.compile(r"[0-9]+|(?:[^\W\d_]|[\u0900-\u097F])+", re.UNICODE)
_SEPARATORS_ONLY_RE = re.compile(r"^(?:[^\w]|_)+$")


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


def _normalize_unicode_digits(text: str) -> str:
    return "".join(
        str(unicodedata.digit(ch))
        if ord(ch) > 127 and unicodedata.category(ch) == "Nd"
        else ch
        for ch in text
    )


def _prepare_scan_views(raw: str) -> tuple[str, str, str, list[int]]:
    nfkc = _normalize_unicode_digits(unicodedata.normalize("NFKC", raw)).translate(
        _DEVANAGARI_DIGITS
    )
    stripped_chars: list[str] = []
    spaced_chars: list[str] = []
    stripped_to_nfkc: list[int] = []
    for idx, ch in enumerate(nfkc):
        if _is_invisible_format_char(ch) or ch in _KEYCAP_VARIATION_CHARS:
            spaced_chars.append(" ")
        else:
            stripped_chars.append(ch)
            stripped_to_nfkc.append(idx)
            spaced_chars.append(ch)
    return nfkc, "".join(stripped_chars), "".join(spaced_chars), stripped_to_nfkc


def _extend_trailing_keycap_marks(nfkc: str, end: int) -> int:
    n = len(nfkc)
    while end < n and (
        nfkc[end] in _KEYCAP_VARIATION_CHARS
        or (
            _is_invisible_format_char(nfkc[end])
            and end + 1 < n
            and nfkc[end + 1] in _KEYCAP_VARIATION_CHARS
        )
    ):
        end += 1
    return end


def _is_benign_seat_list(
    sub: str,
    numeric_tokens: list[str],
    prefix: str,
    suffix: str = "",
) -> bool:
    if ("," not in sub and "-" not in sub) or len(numeric_tokens) < 3:
        return False
    if not all(t.isdigit() and t == str(int(t)) for t in numeric_tokens):
        return False
    if _PHONE_CONTEXT_RE.search(prefix):
        return False
    vals = [int(t) for t in numeric_tokens]
    if not (all(1 <= v <= 120 for v in vals) and all(vals[i] > vals[i - 1] for i in range(1, len(vals)))):
        return False
    has_seat_or_coach = bool(
        _SEAT_CONTEXT_RE.search(prefix)
        or _SEAT_CONTEXT_RE.search(suffix)
        or _COACH_CODE_RE.search(prefix)
        or _COACH_CODE_RE.search(suffix)
    )
    if "," in sub:
        # Exempt strictly consecutive ascending 1-2 digit seat lists like "61, 62, 63, 64, 65"
        if all(1 <= v <= 99 for v in vals) and all(
            vals[i] == vals[i - 1] + 1 for i in range(1, len(vals))
        ):
            return True
        if has_seat_or_coach:
            return True
        # Exempt 4+ ascending 1-2 digit berth/seat numbers with small gaps (e.g. 61, 63, 65, 67)
        if (
            len(vals) >= 4
            and all(1 <= v <= 99 for v in vals)
            and all(1 <= vals[i] - vals[i - 1] <= 4 for i in range(1, len(vals)))
        ):
            return True
        return False
    # Hyphenated ascending seat/berth range/list when seat/coach context is nearby
    return has_seat_or_coach


def _is_benign_train_pair(
    sub: str,
    numeric_tokens: list[str],
    prefix: str,
) -> bool:
    if (
        len(numeric_tokens) != 2
        or not all(len(t) == 5 for t in numeric_tokens)
        or "/" not in sub
        or _PHONE_CONTEXT_RE.search(prefix)
    ):
        return False
    if _TRAIN_CONTEXT_RE.search(prefix):
        return True
    t0, t1 = int(numeric_tokens[0]), int(numeric_tokens[1])
    return 1 <= abs(t1 - t0) <= 2


def _has_plus91_prefix(sub: str, prefix: str) -> bool:
    if re.search(r"\+\s*91(?!\d)", sub):
        return True
    return bool(prefix.rstrip().endswith("+") and re.match(r"^\s*91(?!\d)", sub))


def _is_benign_date_span(
    sub: str,
    *,
    prefix: str = "",
    word_digit_count: int = 0,
    used_multiplier: bool = False,
) -> bool:
    if word_digit_count > 0 or used_multiplier:
        return False
    if _has_plus91_prefix(sub, prefix):
        return False
    if not _DATE_EMBEDDED_RE.search(sub):
        return False
    remainder = _DATE_EMBEDDED_RE.sub(" ", sub)
    remaining_digits = sum(1 for ch in remainder if ch.isdigit())
    return remaining_digits < 4


def _looks_like_pure_numeric_phone(
    sub: str,
    numeric_tokens: list[str],
    prefix: str = "",
    suffix: str = "",
) -> bool:
    if _is_benign_date_span(sub, prefix=prefix):
        return False
    if _is_benign_train_pair(sub, numeric_tokens, prefix):
        return False
    if _is_benign_seat_list(sub, numeric_tokens, prefix, suffix):
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
    if (
        not _DATE_EMBEDDED_RE.search(sub)
        and 11 <= len(digits_only) <= 22
        and re.search(r"[6-9]\d{9}", digits_only)
    ):
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
        has_internal_cf = (
            stripped_to_nfkc is not None
            and tok_end > tok_start
            and (stripped_to_nfkc[tok_end - 1] - stripped_to_nfkc[tok_start] + 1)
            > (tok_end - tok_start)
        )
        if (
            tok_end > tok_start
            and not tok_lower.isdigit()
            and tok_lower not in _SEGMENTABLE_WORDS
            and (has_internal_cf or tok_lower not in _BENIGN_FUSED_EXCLUSIONS)
        ):
            parts = _segment_fused_word_tokens(tok_lower)
            if parts and (has_internal_cf or len(parts) >= 2):
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
                if gap and not _SEPARATORS_ONLY_RE.fullmatch(gap):
                    # Allow adjacent letter/digit boundaries (gap == "") and valid separator gaps
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
            if (
                word_digit_count == 0
                and len(numeric_tokens) >= 2
                and tokens[idx].text.isdigit()
                and len(tokens[idx].text) <= 2
                and tokens[idx].start > 0
                and scan_text[tokens[idx].start - 1].isalpha()
                and len("".join(numeric_tokens[1:])) >= 10
            ):
                k = tokens[idx].start
                while k > 0 and scan_text[k - 1].isalpha():
                    k -= 1
                if (k == 0 or not scan_text[k - 1].isalnum()) and _COACH_CODE_RE.fullmatch(
                    scan_text[k : tokens[idx].end]
                ):
                    idx += 1
                    continue

            span_start = tokens[idx].start
            span_end = tokens[last_valid_j].end
            plus_match = _LEADING_PLUS_RE.search(scan_text[:span_start])
            if plus_match is not None:
                span_start = plus_match.start()
            sub = scan_text[span_start:span_end].strip()
            prefix = scan_text[max(0, span_start - 32) : span_start]
            suffix = scan_text[span_end : min(len(scan_text), span_end + 32)]
            # Match if:
            # - >= 7 digits with >= 3 digit words (at least 2 non-ambiguous)
            # - OR >= 10 total digits across mixed numeric/word tokens (excluding dates, seat lists, train pairs)
            is_word_phone = word_digit_count >= 3 and non_ambiguous_word_count >= 2 and digit_count >= 7
            if word_digit_count > 0 or used_multiplier:
                is_numeric_phone = digit_count >= 10 and not _is_benign_date_span(
                    sub,
                    prefix=prefix,
                    word_digit_count=word_digit_count,
                    used_multiplier=used_multiplier,
                )
            else:
                is_numeric_phone = _looks_like_pure_numeric_phone(
                    sub, numeric_tokens, prefix, suffix
                )
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
        _UPI_OBFUSCATED_BRACKET_KNOWN_RE,
        _UPI_OBFUSCATED_BRACKET_RE,
        _UPI_OBFUSCATED_WORD_AT_STRICT_RE,
        _UPI_SPACED_AT_STRICT_RE,
    ):
        for m in regex.finditer(scan):
            tagged.append((m.start(), m.end(), "upi"))

    for regex in (_UPI_OBFUSCATED_WORD_AT_KNOWN_RE, _UPI_SPACED_AT_KNOWN_RE):
        for m in regex.finditer(scan):
            if m.group(1).lower() not in _MEETUP_PRE_AT_WORDS:
                tagged.append((m.start(), m.end(), "upi"))

    for regex in (_PHONE_EXPLICIT_RE, _PHONE_10_SEPARATED_RE, _PHONE_DECOY_10_RE, _PHONE_INTL_RE):
        for m in regex.finditer(scan):
            sub = scan[m.start() : m.end()].strip()
            if _DATE_LIKE_RE.fullmatch(sub):
                continue
            if regex in (_PHONE_EXPLICIT_RE, _PHONE_10_SEPARATED_RE):
                prefix = scan[max(0, m.start() - 32) : m.start()]
                suffix = scan[m.end() : min(len(scan), m.end() + 32)]
                num_tokens = re.findall(r"\d+", sub)
                if (
                    _is_benign_date_span(sub, prefix=prefix)
                    or _is_benign_seat_list(sub, num_tokens, prefix, suffix)
                    or _is_benign_train_pair(sub, num_tokens, prefix)
                ):
                    continue
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
            nfkc_start = stripped_to_nfkc[start]
            nfkc_end = _extend_trailing_keycap_marks(nfkc, stripped_to_nfkc[end - 1] + 1)
            tagged_nfkc.append((nfkc_start, nfkc_end, cat))

    if scan_spaced != scan_stripped:
        for start, end, cat in _collect_tagged_spans(scan_spaced):
            if start < end:
                tagged_nfkc.append((start, _extend_trailing_keycap_marks(nfkc, end), cat))

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
