from __future__ import annotations

import pytest

from saath_api.messaging.redaction import REDACTION_TOKEN, redact_contact_details

ADVERSARIAL_SHOULD_REDACT: list[tuple[str, str]] = [
    # 1. Plain Indian mobile numbers
    ("Call me on 9876543210", "phone"),
    ("My number is 8765432109", "phone"),
    ("Reach me at 7654321098 please", "phone"),
    ("6543210987 is my mobile", "phone"),
    # 2. +91 / 91 / 0 prefixes & separators
    ("+919876543210", "phone"),
    ("+91 9876543210", "phone"),
    ("+91-98765-43210", "phone"),
    ("(+91) 98765 43210", "phone"),
    ("91 98765 43210", "phone"),
    ("09876543210", "phone"),
    ("0-98765-43210", "phone"),
    ("98765 43210", "phone"),
    ("9876-543-210", "phone"),
    ("987.654.3210", "phone"),
    ("98-76-54-32-10", "phone"),
    ("9 8 7 6 5 4 3 2 1 0", "phone"),
    ("98 76 54 32 10", "phone"),
    ("+91 98 76 54 32 10", "phone"),
    ("987_654_3210", "phone"),
    ("+1 415 555 0199", "phone"),
    # 3. Zero-width / Cf invisible character evasion, typographic dashes, :/* separators & Devanagari digits
    ("9\u200b8\u200b7\u200b6\u200b5\u200b4\u200b3\u200b2\u200b1\u200b0", "phone"),
    ("98765\u206043210", "phone"),
    ("98765\u200e43210", "phone"),
    ("98765—43210", "phone"),
    ("98765–43210", "phone"),
    ("98:76:54:32:10", "phone"),
    ("98*76*54*32*10", "phone"),
    ("98, 76, 54, 32, 10", "phone"),
    ("98,76,54,32,10", "phone"),
    ("987, 654, 32, 10", "phone"),
    ("९८७६५४३२१०", "phone"),
    ("+९१ ९८७६५ ४३२१०", "phone"),
    ("9876५४3210", "phone"),
    ("9️⃣8️⃣7️⃣6️⃣5️⃣4️⃣3️⃣2️⃣1️⃣0️⃣", "phone"),
    ("9\u20e38\u20e37\u20e36\u20e35\u20e34\u20e33\u20e32\u20e31\u20e30\u20e3", "phone"),
    ("9\ufe0f8\ufe0f7\ufe0f6\ufe0f5\ufe0f4\ufe0f3\ufe0f2\ufe0f1\ufe0f0", "phone"),
    ("9\ufe0e8\ufe0e7\ufe0e6\ufe0e5\ufe0e4\ufe0e3\ufe0e2\ufe0e1\ufe0e0", "phone"),
    ("Call 9️⃣8️⃣7️⃣6️⃣5️⃣ 4️⃣3️⃣2️⃣1️⃣0️⃣", "phone"),
    ("Coach B5 ❤️ 9876543210", "phone"),
    ("9876 12/05/26", "phone"),
    ("9876 01/02/23", "phone"),
    ("+91 9876 01/02/23", "phone"),
    ("12/05/2026-9876543210", "phone"),
    ("12/05/2026 9876543210", "phone"),
    ("+1/415/555/0199", "phone"),
    ("+1,415,555,0199", "phone"),
    ("+44/7911/123456", "phone"),
    ("+91/98765/43210", "phone"),
    ("98765•43210", "phone"),
    ("98765·43210", "phone"),
    ("9•8•7•6•5•4•3•2•1•0", "phone"),
    ("9·8·7·6·5·4·3·2·1·0", "phone"),
    # 4. English digit words + double/triple multipliers
    ("nine eight seven six five four three two one zero", "phone"),
    ("nine eight seven six five four three two one oh", "phone"),
    ("double nine eight seven six five four three two", "phone"),
    ("triple nine eight seven six five four three", "phone"),
    ("call me nine eight 7 6 5 4 3 2 1 0", "phone"),
    ("nine 8 7 6 01/02/23", "phone"),
    # 5. Hindi Devanagari & Hinglish digit words
    ("नौ आठ सात छह पांच चार तीन दो एक शून्य", "phone"),
    ("नौ आठ सात छह पाँच चार तीन दो एक", "phone"),
    ("नौ\u200fआठ\u2060सात 6\u200e5 4\u200b3 2 1 0", "phone"),
    ("न\u200bौ\u200fआठ\u2060सात 6\u200e5 4\u200b3 2 1 0", "phone"),
    ("नौआठसात\u200b6543210", "phone"),
    ("nineeightseven\u200b6543210", "phone"),
    ("9\u200bनौआठसात654321", "phone"),
    ("नौआठसात 6543210", "phone"),
    ("nineeightseven 6543210", "phone"),
    ("9\u034f8\u034f7\u034f6\u034f5\u034f4\u034f3\u034f2\u034f1\u034f0", "phone"),
    ("9\u180e8\u180e7\u180e6\u180e5\u180e4\u180e3\u180e2\u180e1\u180e0", "phone"),
    ("98/76/5432/10", "phone"),
    ("call ८/२ \u200b ६ \u200b १~नौ \u200b ३/७-७७*८", "phone"),
    ("9~8~7~6~5~4~3~2~1~0", "phone"),
    ("9;8;7;6;5;4;3;2;1;0", "phone"),
    ("98765~43210", "phone"),
    ("nau aath saat chhe paanch char teen do ek shunya", "phone"),
    ("ek do teen char paanch chhe saat aath nau shunya", "phone"),
    ("double nau aath saat chhe paanch char teen do", "phone"),
    # 6. Standard & obfuscated emails
    ("asha.sharma@gmail.com", "email"),
    ("passenger_99@yahoo.co.in", "email"),
    ("asha [at] gmail [dot] com", "email"),
    ("asha(at)outlook(dot)com", "email"),
    ("asha {at} proton {dot} me", "email"),
    ("asha at gmail dot com", "email"),
    ("asha at yahoo dot co dot in", "email"),
    ("asha at mydomain dot xyz", "email"),
    ("asha.sharma @ gmail.com", "email"),
    ("contact rahul[at]saath[dot]in", "email"),
    # 7. URLs & bare domains (including .co / .ai / t.co / spaced / [dot] URLs)
    ("https://wa.me/919876543210", "url"),
    ("http://t.me/saath_user", "url"),
    ("www.example.com/chat", "url"),
    ("wa.me/919876543210", "url"),
    ("t.me/traveler_b5", "url"),
    ("bit.ly/3xYzAbc", "url"),
    ("See t.co/xyz123", "url"),
    ("Check profile.ai/me", "url"),
    ("wa . me / my_telegram_handle", "url"),
    ("wa[dot]me/myhandle", "url"),
    ("example(dot)com/chat", "url"),
    ("mysite . dev / asha", "url"),
    ("check my profile at mysite.in/me", "url"),
    ("reach me on chatbox.app/asha", "url"),
    ("b.tech/asha", "url"),
    ("find me on x.com", "url"),
    ("link on t.co", "url"),
    # 8. UPI IDs (standard, alphanumeric PSP, and obfuscated)
    ("asha@okicici", "upi"),
    ("rahul.k@ybl", "upi"),
    ("traveler99@paytm", "upi"),
    ("9876543210@upi", "upi"),
    ("meera@oksbi", "upi"),
    ("kiran_1@okhdfcbank", "upi"),
    ("amit@ibl", "upi"),
    ("raj.99 [at] okicici", "upi"),
    ("user at ybl", "upi"),
    ("user [at] sbi", "upi"),
    ("user(at)kotak811", "upi"),
    ("user@kotak811", "upi"),
    ("user at kotak811", "upi"),
    ("user @ okaxis", "upi"),
    ("user @ kotak811", "upi"),
    ("raj.99 @ okicici", "upi"),
    ("user @ ybl", "upi"),
    ("user @ paytm", "upi"),
    ("pay me at user @ okaxis", "upi"),
]

BENIGN_MESSAGES: list[str] = [
    "Hi! I am in Coach B5 seat 42, happy to swap for a lower berth.",
    "We are 2 seats together in B3, seats 11 and 14.",
    "Train 12951 on 2026-11-28, let us meet near the coach door.",
    "Train 12951, 2026-11-26",
    "Train 12951 on 12/05/2026",
    "Date 12/05/2026 98",
    "2026-11-28",
    "12/05/2026",
    "👍 coach B5",
    "सीट बदलें",
    "We have seats 12, 13, 14, 15, 16 in B3",
    "Seats 61, 62, 63, 64, 65 in B3",
    "Seats 12, 14, 16, 18, 20 in B3",
    "Checking 12951 / 12952",
    "Checking trains 62001 / 62002",
    "31/12/2026",
    "12-05-2026",
    "My PNR 1234567890",
    "Do you want to swap at the next station?",
    "I have seat 12 LB and am travelling with a senior citizen.",
    "Flight 6E215 seat 14A window, happy to exchange for aisle 14C.",
    "हाँ, कोच B5 में सीट 12 बदलने के लिए तैयार हूँ।",
    "अगले स्टेशन पर स्वैप करें? मेरे पास 2 सीटें हैं।",
    "Meet at bay 3 around 7 pm.",
    "Meet at SBI counter",
    "Meet @ SBI counter",
    "Wait @ SBI ATM",
    "Wait at Airtel kiosk",
    "Meet at bob window",
    "Meet at kotak811 desk",
    "Meet @ kotak811 desk",
    "Option 1️⃣ or 2️⃣",
    "Look at slice 2 of pizza",
    "I completed B.Tech last year",
    "I completed B.Com last year",
    "I did B.Tech / M.Tech",
    "I studied B.Com / Economics",
    "Train from 12.to 14 hours",
]


@pytest.mark.parametrize(("text", "expected_cat"), ADVERSARIAL_SHOULD_REDACT)
def test_adversarial_contact_details_are_redacted(text: str, expected_cat: str) -> None:
    result = redact_contact_details(text, locale="en")
    assert result.redacted is True, f"Failed to redact: {text!r}"
    assert REDACTION_TOKEN in result.text
    assert expected_cat in result.categories
    assert result.hint == "Contact details unlock after you both agree"


def test_redaction_hindi_hint() -> None:
    res = redact_contact_details("मेरा नंबर 9876543210 है", locale="hi")
    assert res.redacted is True
    assert REDACTION_TOKEN in res.text
    assert "9876543210" not in res.text
    assert res.hint == "दोनों के सहमत होने पर संपर्क विवरण अनलॉक होंगे"


@pytest.mark.parametrize("text", BENIGN_MESSAGES)
def test_benign_seat_and_coach_messages_not_redacted(text: str) -> None:
    result = redact_contact_details(text, locale="en")
    assert result.redacted is False, f"False positive redaction on: {text!r}"
    assert result.text == text
    assert result.hint is None


@pytest.mark.parametrize(
    ("text", "expected_text", "expected_cat"),
    [
        ("pay me at user @ okaxis", f"pay me at {REDACTION_TOKEN}", "upi"),
        ("9️⃣8️⃣7️⃣6️⃣5️⃣4️⃣3️⃣2️⃣1️⃣0️⃣", REDACTION_TOKEN, "phone"),
        (
            "9\u20e38\u20e37\u20e36\u20e35\u20e34\u20e33\u20e32\u20e31\u20e30\u20e3",
            REDACTION_TOKEN,
            "phone",
        ),
        ("Call 9️⃣8️⃣7️⃣6️⃣5️⃣ 4️⃣3️⃣2️⃣1️⃣0️⃣", f"Call {REDACTION_TOKEN}", "phone"),
        ("Coach B5 ❤️ 9876543210", f"Coach B5 ❤️ {REDACTION_TOKEN}", "phone"),
        ("+1/415/555/0199", REDACTION_TOKEN, "phone"),
        ("+1,415,555,0199", REDACTION_TOKEN, "phone"),
        ("+44/7911/123456", REDACTION_TOKEN, "phone"),
        ("+91/98765/43210", REDACTION_TOKEN, "phone"),
        ("98765•43210", REDACTION_TOKEN, "phone"),
        ("98765·43210", REDACTION_TOKEN, "phone"),
    ],
)
def test_redaction_exact_outputs_and_idempotency(
    text: str, expected_text: str, expected_cat: str
) -> None:
    result = redact_contact_details(text, locale="en")
    assert result.redacted is True
    assert result.text == expected_text
    assert expected_cat in result.categories
    assert "\ufe0f" not in result.text or "❤️" in result.text
    assert "\u20e3" not in result.text
    repass = redact_contact_details(result.text, locale="en")
    assert repass.redacted is False
    assert repass.text == expected_text
