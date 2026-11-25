from __future__ import annotations

from typing import Any

from httpx import AsyncClient
from starlette.requests import Request as StarletteRequest

from saath_api.auth.router import _client_ip
from saath_api.core.config import Settings
from saath_api.core.crypto import decode_jwt


async def test_anonymous_session_success(
    client: AsyncClient, test_settings: Settings
) -> None:
    resp = await client.post("/v1/auth/anonymous", json={"turnstile": "fake-ok"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["token_type"] == "bearer"
    assert body["expires_in"] == 7200

    claims = decode_jwt(body["access"], test_settings.jwt_public_key)
    assert claims["kind"] == "anon"
    assert str(claims["sub"]).startswith("anon:")


async def test_anonymous_turnstile_failure_returns_403_problem_json(
    client: AsyncClient,
) -> None:
    resp = await client.post("/v1/auth/anonymous", json={"turnstile": "fail-turnstile"})
    assert resp.status_code == 403
    assert resp.headers["content-type"].startswith("application/problem+json")
    assert resp.json()["code"] == "turnstile_failed"


async def test_anonymous_rejects_actor_id_in_body(client: AsyncClient) -> None:
    resp = await client.post(
        "/v1/auth/anonymous",
        json={"turnstile": "ok", "user_id": "00000000-0000-0000-0000-000000000001"},
    )
    assert resp.status_code == 422
    assert resp.headers["content-type"].startswith("application/problem+json")


async def test_anonymous_rate_limit(client: AsyncClient) -> None:
    for _ in range(20):
        r = await client.post("/v1/auth/anonymous", json={"turnstile": "ok"})
        assert r.status_code == 200
    blocked = await client.post("/v1/auth/anonymous", json={"turnstile": "ok"})
    assert blocked.status_code == 429
    assert blocked.json()["code"] == "rate_limited"


def test_client_ip_ignores_spoofed_xff_when_peer_untrusted() -> None:
    class _AppState:
        settings = Settings(env="test", trusted_proxies="10.0.0.1")

    class _App:
        state = _AppState()

    scope: dict[str, Any] = {
        "type": "http",
        "method": "POST",
        "path": "/v1/auth/anonymous",
        "headers": [(b"x-forwarded-for", b"1.2.3.4")],
        "client": ("198.51.100.42", 12345),
        "app": _App(),
    }
    req = StarletteRequest(scope)
    assert _client_ip(req) == "198.51.100.42"

    # When peer IS a trusted proxy, extracts rightmost untrusted hop
    scope["client"] = ("10.0.0.1", 12345)
    scope["headers"] = [(b"x-forwarded-for", b"9.9.9.9, 203.0.113.7, 10.0.0.1")]
    req_trusted = StarletteRequest(scope)
    assert _client_ip(req_trusted) == "203.0.113.7"

    # When trusted proxy sends only non-IP entries in X-Forwarded-For, fall back to peer_ip
    scope["headers"] = [(b"x-forwarded-for", b"unknown, invalid-hop")]
    req_non_ip = StarletteRequest(scope)
    assert _client_ip(req_non_ip) == "10.0.0.1"

    # When trusted proxy sends only valid trusted-proxy hops, return rightmost valid IP
    scope["headers"] = [(b"x-forwarded-for", b"10.0.0.1, unknown")]
    req_all_trusted = StarletteRequest(scope)
    assert _client_ip(req_all_trusted) == "10.0.0.1"
