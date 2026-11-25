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
        "/v1/pricing/plans",
        "/v1/me/entitlements",
        "/v1/billing/checkout",
        "/v1/webhooks/payments",
        "/v1/b2b/keys",
        "/v1/b2b/stats",
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
