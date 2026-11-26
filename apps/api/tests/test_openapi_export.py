from __future__ import annotations

import json
from pathlib import Path

from saath_api.export_openapi import export_openapi_schema


def test_offline_openapi_export_contains_auth_and_problem_detail(tmp_path: Path) -> None:
    out_file = tmp_path / "openapi.json"
    written = export_openapi_schema(out_file)
    assert written == out_file

    schema = json.loads(out_file.read_text(encoding="utf-8"))
    paths = schema["paths"]
    for expected in (
        "/healthz",
        "/readyz",
        "/v1/auth/anonymous",
        "/v1/auth/otp/start",
        "/v1/auth/otp/verify",
        "/v1/auth/refresh",
        "/v1/auth/logout",
        "/v1/me",
        "/v1/flights/layouts",
        "/v1/journeys/verify",
        "/v1/journeys",
        "/v1/journeys/{journey_id}",
        "/v1/journeys/{journey_id}/reverify",
        "/v1/journeys/{journey_id}/party/invite",
        "/v1/party/join",
        "/v1/party/{party_id}/members/{seat_holder_id}",
        "/v1/parties/{party_id}/goal",
        "/v1/parties/{party_id}/organiser-summary",
        "/v1/parties/{party_id}/matches",
        "/v1/journeys/{journey_id}/coach-map",
        "/v1/swaps",
        "/v1/swaps/{swap_id}",
        "/v1/swaps/{swap_id}/accept",
        "/v1/swaps/{swap_id}/decline",
        "/v1/swaps/{swap_id}/cancel",
        "/v1/swaps/{swap_id}/confirm-completion",
        "/v1/swaps/{swap_id}/card",
        "/v1/public/swap-cards/{code}",
        "/v1/pricing/plans",
        "/v1/me/entitlements",
        "/v1/billing/checkout",
        "/v1/webhooks/payments",
        "/v1/b2b/keys",
        "/v1/b2b/stats",
        "/v1/events/stream",
        "/v1/conversations",
        "/v1/conversations/{conversation_id}/messages",
        "/v1/conversations/{conversation_id}/translate",
        "/v1/users/block",
        "/v1/reports",
        "/v1/me/push-subscriptions",
        "/v1/me/notification-prefs",
        "/v1/webhooks/whatsapp",
        "/v1/public/train/{train_no}/chart-time",
        "/v1/journeys/{journey_id}/invite-seat",
        "/v1/public/invites/{token}",
        "/v1/public/pnr-status/{pnr}",
        "/v1/public/train/{train_no}/live",
        "/v1/public/train/{train_no}/composition",
        "/v1/public/flight-layouts",
        "/v1/public/stats",
        "/v1/karma",
        "/v1/karma/rewards",
        "/v1/karma/rewards/redeem",
        "/v1/ai/concierge",
        "/v1/ai/draft-request",
    ):
        assert expected in paths

    assert "ProblemDetail" in schema["components"]["schemas"]
    assert "ProblemFieldError" in schema["components"]["schemas"]
    anon_403_resp = paths["/v1/auth/anonymous"]["post"]["responses"]["403"]
    anon_403 = anon_403_resp["content"]
    assert "application/json" not in anon_403
    assert "application/problem+json" in anon_403
    assert anon_403["application/problem+json"]["schema"] == {
        "$ref": "#/components/schemas/ProblemDetail"
    }
    block_responses = paths["/v1/users/block"]["post"]["responses"]
    assert "409" in block_responses
    assert "application/problem+json" in block_responses["409"]["content"]
    draft_responses = paths["/v1/ai/draft-request"]["post"]["responses"]
    assert "429" in draft_responses
    assert "application/problem+json" in draft_responses["429"]["content"]
