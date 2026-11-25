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
    ):
        assert expected in paths

    assert "ProblemDetail" in schema["components"]["schemas"]
    anon_403 = paths["/v1/auth/anonymous"]["post"]["responses"]["403"]["content"]
    assert "application/problem+json" in anon_403
    assert anon_403["application/problem+json"]["schema"] == {
        "$ref": "#/components/schemas/ProblemDetail"
    }
