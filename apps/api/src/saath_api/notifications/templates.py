from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

IST = ZoneInfo("Asia/Kolkata")

EXTERNAL_NOTIFICATION_EVENTS: frozenset[str] = frozenset(
    {
        "MatchFound",
        "SwapProposed",
        "SwapConfirmed",
        "BerthChanged",
        "ChartChanged",
        "SwapInvalidated",
        "PostJourneyConfirmPrompt",
        "MessageNew",
    }
)

URGENT_CHART_EVENTS: frozenset[str] = frozenset({"BerthChanged", "ChartChanged", "SwapInvalidated"})

INTERNAL_ONLY_EVENTS: frozenset[str] = frozenset(
    {
        "JourneyVerified",
        "GoalChanged",
        "PartyJoined",
        "EntitlementGranted",
        "EntitlementActivated",
        "ProposalDeclined",
        "SwapCancelled",
        "SwapNotCompleted",
        "SwapCompleted",
        "SwapExpired",
        "KarmaCredited",
        "KarmaReversed",
        "BadgeUnlocked",
        "RewardRedemptionRequested",
    }
)


@dataclass(frozen=True)
class RenderedNotification:
    template_name: str
    title: str
    body: str
    url: str
    params: dict[str, str]


def is_quiet_hours_ist(now_utc: datetime) -> bool:
    ist_time = now_utc.astimezone(IST).time()
    return ist_time >= time(23, 0) or ist_time < time(6, 0)


def next_quiet_hours_end_utc(now_utc: datetime) -> datetime:
    ist_dt = now_utc.astimezone(IST)
    if ist_dt.time() >= time(23, 0):
        target_date = ist_dt.date() + timedelta(days=1)
    else:
        target_date = ist_dt.date()
    wake_ist = datetime.combine(target_date, time(6, 0), tzinfo=IST)
    return wake_ist.astimezone(now_utc.tzinfo or IST)


def is_urgent_chart_bypass(
    event: str,
    departure_at: datetime | None,
    now_utc: datetime,
) -> bool:
    if event not in URGENT_CHART_EVENTS or departure_at is None:
        return False
    delta = departure_at - now_utc
    return timedelta(minutes=-15) <= delta < timedelta(hours=2)


def render_notification(
    *,
    event: str,
    payload: dict[str, Any],
    locale: str = "en",
) -> RenderedNotification:
    is_hi = locale == "hi"
    journey_id = str(payload.get("journey_instance_id") or payload.get("journey_id") or "")
    swap_id = str(payload.get("swap_id") or "")
    convo_id = str(payload.get("conversation_id") or "")

    if event == "MatchFound":
        url = f"/journeys/{journey_id}/matches" if journey_id else "/journeys"
        service = str(payload.get("service_no") or "")
        return RenderedNotification(
            template_name="saath_match_found",
            title="नया सीट मिलान उपलब्ध" if is_hi else "New seat match found",
            body=(
                f"{service} पर आपकी सीट के लिए नया मिलान मिला है।"
                if is_hi
                else (
                    "A new verified seat swap match is ready"
                    f"{' on ' + service if service else ''}."
                )
            ),
            url=url,
            params={"service": service or "Saath"},
        )

    if event == "SwapProposed":
        url = f"/swaps/{swap_id}" if swap_id else "/inbox"
        return RenderedNotification(
            template_name="saath_swap_request",
            title="नया स्वैप अनुरोध" if is_hi else "New swap request",
            body=(
                "एक सह-यात्री ने सीट स्वैप का अनुरोध भेजा है। विवरण देखने के लिए खोलें।"
                if is_hi
                else "A co-traveller wants to swap seats with you. Tap to review."
            ),
            url=url,
            params={"swap_id": swap_id},
        )

    if event == "SwapConfirmed":
        code = str(payload.get("public_code") or "")
        url = f"/swaps/{swap_id}/card" if swap_id else "/inbox"
        return RenderedNotification(
            template_name="saath_swap_confirmed",
            title="स्वैप पुष्ट हो गया!" if is_hi else "Swap confirmed!",
            body=(
                f"आपका स्वैप कार्ड {code} तैयार है और ऑफ़लाइन भी चलता है।"
                if is_hi
                else f"Your Swap Card {code} is ready and works offline."
            ),
            url=url,
            params={"code": code},
        )

    if event in ("BerthChanged", "ChartChanged", "SwapInvalidated"):
        url = f"/journeys/{journey_id}" if journey_id else "/journeys"
        if event == "SwapInvalidated" and swap_id:
            url = f"/swaps/{swap_id}"
        if event == "SwapInvalidated" and payload.get("reason") == "user_blocked":
            return RenderedNotification(
                template_name="saath_swap_invalidated",
                title="स्वैप प्रस्ताव बंद" if is_hi else "Swap proposal closed",
                body=(
                    "यह स्वैप प्रस्ताव अब उपलब्ध नहीं है। कृपया अपने अपडेटेड मिलान देखें।"
                    if is_hi
                    else "This swap proposal is no longer available. Check your updated matches."
                ),
                url=url,
                params={"reason": "unavailable"},
            )
        new_coach = str(payload.get("new_coach") or "")
        new_seat = str(payload.get("new_seat") or "")
        berth_info = f"{new_coach}-{new_seat}".strip("-")
        return RenderedNotification(
            template_name="saath_chart_changed",
            title="चार्ट / बर्थ अपडेट" if is_hi else "Chart / berth updated",
            body=(
                (
                    f"आपकी ट्रेन का चार्ट अपडेट हुआ है{f' ({berth_info})' if berth_info else ''}। "
                    "कृपया नए मिलान देखें।"
                )
                if is_hi
                else (
                    f"Train chart updated{f' ({berth_info})' if berth_info else ''}. "
                    "Check your updated matches."
                )
            ),
            url=url,
            params={"berth": berth_info or "chart"},
        )

    if event == "PostJourneyConfirmPrompt":
        url = f"/swaps/{swap_id}" if swap_id else "/inbox"
        return RenderedNotification(
            template_name="saath_confirm_swap",
            title="क्या आपका स्वैप पूरा हुआ?" if is_hi else "Did your swap happen?",
            body=(
                "कृपया यात्रा के बाद पुष्टि करें ताकि विश्वसनीयता और कर्म जुड़ सकें।"
                if is_hi
                else "Tap to confirm your completed seat swap and earn Karma."
            ),
            url=url,
            params={"swap_id": swap_id},
        )

    if event == "MessageNew":
        sender_alias = str(payload.get("sender_alias") or "Co-traveller")
        preview = str(payload.get("preview") or "")[:60]
        url = f"/inbox/{convo_id}" if convo_id else "/inbox"
        return RenderedNotification(
            template_name="saath_message_new",
            title=(f"{sender_alias} का संदेश" if is_hi else f"Message from {sender_alias}"),
            body=preview or ("नया चैट संदेश" if is_hi else "New chat message"),
            url=url,
            params={"sender": sender_alias},
        )

    if event == "KarmaCredited":
        pts = str(payload.get("points") or 0)
        return RenderedNotification(
            template_name="saath_karma_credited",
            title="कर्म अंक जुड़े!" if is_hi else "Karma points credited!",
            body=(
                f"आपके खाते में +{pts} कर्म अंक जुड़ गए हैं।"
                if is_hi
                else f"+{pts} Karma points have been added to your wallet."
            ),
            url="/karma",
            params={"points": pts},
        )

    if event == "KarmaReversed":
        pts = str(payload.get("points") or 0)
        return RenderedNotification(
            template_name="saath_karma_reversed",
            title="कर्म अंक वापस लिए गए" if is_hi else "Karma points reversed",
            body=(
                f"विवाद के कारण {pts} कर्म अंक वापस लिए गए हैं।"
                if is_hi
                else f"{pts} Karma points were reversed following a swap dispute."
            ),
            url="/karma",
            params={"points": pts},
        )

    if event == "BadgeUnlocked":
        badge_code = str(payload.get("badge_code") or "")
        return RenderedNotification(
            template_name="saath_badge_unlocked",
            title="नया बैज अनलॉक हुआ!" if is_hi else "New badge unlocked!",
            body=(
                f"बधाई हो! आपने {badge_code} बैज अर्जित किया है।"
                if is_hi
                else f"Nice work! You unlocked the {badge_code} badge."
            ),
            url="/karma",
            params={"badge_code": badge_code},
        )

    if event == "RewardRedemptionRequested":
        reward_code = str(payload.get("reward_code") or "")
        return RenderedNotification(
            template_name="saath_reward_redemption",
            title="इनाम अनुरोध प्राप्त हुआ" if is_hi else "Reward redemption requested",
            body=(
                f"{reward_code} के लिए आपका कर्म रिडेम्पशन अनुरोध दर्ज हो गया है।"
                if is_hi
                else f"Your Karma redemption request for {reward_code} is pending review."
            ),
            url="/karma",
            params={"reward_code": reward_code},
        )

    return RenderedNotification(
        template_name="saath_update",
        title="साथ अपडेट" if is_hi else "Saath update",
        body="अपना साथ इनबॉक्स देखें।" if is_hi else "Check your Saath inbox.",
        url="/inbox",
        params={"event": event},
    )
