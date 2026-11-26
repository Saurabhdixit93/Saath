from __future__ import annotations

import re
from dataclasses import dataclass

from saath_api.providers.llm import LLMProvider, ModerationCategory

_PREFILTER_HIDE_RE = re.compile(
    r"(?i)(?:"
    r"\b(?:pay|send|transfer)\s+(?:(?:me|us)\s+)?"
    r"(?:"
    r"(?:money|inr|rupees?|advance|deposit|fee|first|upi)\b"
    r"|(?:in|as|for)\s+(?:advance|deposit|fee)\b"
    r"|rs(?:\.?\s*\d+|\b\.?)"
    r"|₹\s*\d*"
    r"|(?:an?|the|some)\s+(?:money|advance|deposit|fee)\b"
    r"|(?:via|on|by|through)\s+(?:upi|gpay|phonepe|paytm)\b"
    r"|\d+(?:[.,]\d+)?\s*(?:rs\b\.?|(?:inr|rupees?)\b|₹|"
    r"(?:(?:in|as|for)\s+)?(?:advance|deposit|fee)\b|"
    r"(?:first|money)\b|(?:(?:via|on|by|through)\s+)?(?:upi|gpay|phonepe|paytm)\b)"
    r")"
    r"|\b(?:gpay|phonepe|paytm|upi)\s+(?:(?:me|us)\s+)?(?:rs\.?\s*|₹\s*)?\d+(?:[.,]\d+)?\b"
    r"(?:\s*(?:rs\b\.?|(?:inr|rupees?)\b|"
    r"(?:(?:in|as|for)\s+)?(?:advance|deposit|fee)\b|first\b))?"
    r"|\b(?:share\s+your\s+otp|bank\s+account|lottery|prize\s+won|crypto\s+transfer|"
    r"kill\s+you|rape|molest|nude|naked|sexting)\b"
    r"|(?:(?:पैसे|रुपये|एडवांस)\s+(?:भेजो|दो)|ओटीपी\s+बताओ)"
    r")"
)


@dataclass(frozen=True)
class ModerationOutcome:
    moderation: str  # "ok" | "redacted" | "hidden"
    reason: str | None
    category: ModerationCategory


async def evaluate_message_moderation(
    *,
    clean_text: str,
    was_redacted: bool,
    locale: str,
    llm_provider: LLMProvider,
) -> ModerationOutcome:
    """Run deterministic prefilter + zero-PII LLM moderation on post-redaction text."""
    if _PREFILTER_HIDE_RE.search(clean_text):
        return ModerationOutcome(
            moderation="hidden",
            reason="safety_prefilter",
            category="scam",
        )

    verdict = await llm_provider.moderate_message(text=clean_text, locale=locale)
    if verdict.action == "hide":
        return ModerationOutcome(
            moderation="hidden",
            reason=verdict.reason or verdict.category,
            category=verdict.category,
        )
    if was_redacted or verdict.action == "blur":
        return ModerationOutcome(
            moderation="redacted",
            reason=verdict.reason or ("contact_redacted" if was_redacted else verdict.category),
            category="contact_sharing" if was_redacted else verdict.category,
        )
    return ModerationOutcome(
        moderation="ok",
        reason=None,
        category="ok",
    )
