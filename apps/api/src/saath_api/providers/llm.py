from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, Literal, Protocol

import structlog

from saath_api.core.config import Settings
from saath_api.providers.base import CircuitBreaker, ProviderError, call_with_retry_and_timeout

logger = structlog.get_logger(__name__)

ModerationCategory = Literal["ok", "harassment", "sexual", "scam", "contact_sharing"]
ModerationAction = Literal["allow", "blur", "hide"]


@dataclass(frozen=True)
class ModerationVerdict:
    flagged: bool
    category: ModerationCategory
    action: ModerationAction
    reason: str = ""


class LLMProvider(Protocol):
    async def moderate_message(self, *, text: str, locale: str = "en") -> ModerationVerdict: ...

    async def translate_text(self, *, text: str, target_lang: str) -> str: ...


_SCAM_RE = re.compile(
    r"(?i)\b(?:send\s+(?:money|rs|inr|advance|deposit|upi)|pay\s+(?:first|advance|fee)|"
    r"share\s+your\s+otp|bank\s+account|lottery|prize\s+won|crypto\s+transfer|"
    r"पैसे\s+भेजो|एडवांस\s+दो|ओटीपी\s+बताओ)\b"
)
_SEXUAL_RE = re.compile(
    r"(?i)\b(?:nude|naked|sexting|send\s+pics|hookup|hot\s+girl|onlyfans)\b"
)
_HARASSMENT_RE = re.compile(
    r"(?i)\b(?:idiot|stupid|harass|kill\s+you|threat|stalk|abuse|chutiya|mc|bc|gali)\b"
)
_CONTACT_HINT_RE = re.compile(
    r"(?i)\b(?:ping\s+me\s+on\s+whatsapp|call\s+my\s+number|dm\s+on\s+insta|telegram\s+me)\b"
)

_EN_TO_HI: dict[str, str] = {
    "happy to swap!": "अदला-बदली करने में खुशी होगी!",
    "swap at next station?": "अगले स्टेशन पर स्वैप करें?",
    "can we meet at the coach door?": "क्या हम कोच के दरवाज़े पर मिल सकते हैं?",
    "yes, happy to swap": "हाँ, अदला-बदली करने में खुशी होगी",
    "thank you!": "धन्यवाद!",
    "see you on board": "ट्रेन में मिलते हैं",
}
_HI_TO_EN: dict[str, str] = {v: k for k, v in _EN_TO_HI.items()}


class FakeLLMProvider:
    """Deterministic local/test LLM adapter for moderation and translation."""

    def __init__(self) -> None:
        self.moderation_calls: list[str] = []
        self.translation_calls: list[tuple[str, str]] = []

    async def moderate_message(self, *, text: str, locale: str = "en") -> ModerationVerdict:
        _ = locale
        self.moderation_calls.append(text)
        if _SCAM_RE.search(text):
            return ModerationVerdict(
                flagged=True,
                category="scam",
                action="hide",
                reason="Potential advance-payment or OTP scam detected",
            )
        if _SEXUAL_RE.search(text):
            return ModerationVerdict(
                flagged=True,
                category="sexual",
                action="hide",
                reason="Inappropriate sexual content detected",
            )
        if _HARASSMENT_RE.search(text):
            return ModerationVerdict(
                flagged=True,
                category="harassment",
                action="hide",
                reason="Harassment or abusive language detected",
            )
        if _CONTACT_HINT_RE.search(text):
            return ModerationVerdict(
                flagged=True,
                category="contact_sharing",
                action="blur",
                reason="Off-platform contact solicitation before acceptance",
            )
        return ModerationVerdict(flagged=False, category="ok", action="allow", reason="")

    async def translate_text(self, *, text: str, target_lang: str) -> str:
        self.translation_calls.append((text, target_lang))
        cleaned = text.strip()
        lowered = cleaned.lower()
        lang = target_lang.strip().lower()
        if lang == "hi":
            if lowered in _EN_TO_HI:
                return _EN_TO_HI[lowered]
            return f"[HI] {cleaned}"
        if lang == "en":
            if cleaned in _HI_TO_EN:
                return _HI_TO_EN[cleaned].capitalize()
            return f"[EN] {cleaned}"
        return cleaned


class AnthropicClaudeAdapter:
    """Anthropic Claude Haiku adapter for zero-PII chat moderation & translation."""

    def __init__(
        self,
        *,
        api_key: str,
        fast_model: str = "claude-haiku-5-5",
        timeout_seconds: float = 4.0,
    ) -> None:
        if not api_key:
            raise ValueError("ANTHROPIC_API_KEY is required when AI_MODE=anthropic")
        import anthropic

        self._client = anthropic.AsyncAnthropic(api_key=api_key)
        self._fast_model = fast_model
        self._timeout_seconds = timeout_seconds
        self._breaker = CircuitBreaker(name="anthropic_llm")

    async def moderate_message(self, *, text: str, locale: str = "en") -> ModerationVerdict:
        system = (
            "You are a safety moderator for an anonymous Indian train/flight seat-swap chat. "
            "Do NOT request or infer personal info. Return ONLY a JSON object with keys: "
            '{"flagged": bool, "category": "ok"|"harassment"|"sexual"|"scam"|"contact_sharing", '
            '"action": "allow"|"blur"|"hide", "reason": str}.'
        )
        user_prompt = f"Locale: {locale}\nMessage: {text[:1200]}"

        async def _call() -> ModerationVerdict:
            resp = await self._client.messages.create(
                model=self._fast_model,
                max_tokens=160,
                temperature=0,
                system=system,
                messages=[{"role": "user", "content": user_prompt}],
            )
            raw_text = ""
            for block in resp.content:
                txt = getattr(block, "text", None)
                if isinstance(txt, str):
                    raw_text += txt
            parsed = _extract_json_object(raw_text)
            category = str(parsed.get("category", "ok"))
            if category not in ("ok", "harassment", "sexual", "scam", "contact_sharing"):
                category = "ok"
            action = str(parsed.get("action", "allow"))
            if action not in ("allow", "blur", "hide"):
                action = "allow"
            flagged = bool(parsed.get("flagged", action != "allow"))
            return ModerationVerdict(
                flagged=flagged,
                category=category,  # type: ignore[arg-type]
                action=action,  # type: ignore[arg-type]
                reason=str(parsed.get("reason", ""))[:200],
            )

        try:
            return await call_with_retry_and_timeout(
                _call,
                timeout_seconds=self._timeout_seconds,
                retries=1,
                breaker=self._breaker,
            )
        except ProviderError:
            logger.warning("anthropic_moderation_fallback")
            return ModerationVerdict(flagged=False, category="ok", action="allow", reason="")

    async def translate_text(self, *, text: str, target_lang: str) -> str:
        lang_label = "Hindi (Devanagari script, keep coach/seat codes in Latin digits)" if target_lang == "hi" else "English"
        system = (
            f"Translate the following short seat-swap chat message into {lang_label}. "
            "Preserve seat/coach identifiers (like B5, LB, 12) verbatim. Return only the translated text."
        )

        async def _call() -> str:
            resp = await self._client.messages.create(
                model=self._fast_model,
                max_tokens=300,
                temperature=0,
                system=system,
                messages=[{"role": "user", "content": text[:1200]}],
            )
            parts: list[str] = []
            for block in resp.content:
                txt = getattr(block, "text", None)
                if isinstance(txt, str):
                    parts.append(txt)
            translated = "".join(parts).strip()
            return translated or text

        return await call_with_retry_and_timeout(
            _call,
            timeout_seconds=self._timeout_seconds,
            retries=1,
            breaker=self._breaker,
        )


def _extract_json_object(raw: str) -> dict[str, Any]:
    start = raw.find("{")
    end = raw.rfind("}")
    if start == -1 or end <= start:
        return {}
    try:
        data = json.loads(raw[start : end + 1])
        return data if isinstance(data, dict) else {}
    except json.JSONDecodeError:
        return {}


def build_llm_provider(settings: Settings) -> LLMProvider:
    if settings.ai_mode == "fake":
        if settings.is_production:
            raise RuntimeError("Fake LLM adapter cannot be used when ENV=production")
        return FakeLLMProvider()
    return AnthropicClaudeAdapter(
        api_key=settings.anthropic_api_key,
        fast_model=settings.anthropic_fast_model,
    )
