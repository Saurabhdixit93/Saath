from __future__ import annotations

from typing import Any

from httpx import AsyncClient


async def test_healthz_ok(client: AsyncClient) -> None:
    resp = await client.get("/healthz")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}
    assert "x-request-id" in resp.headers


async def test_readyz_ok_with_real_postgres_and_redis(client: AsyncClient) -> None:
    resp = await client.get("/readyz")
    assert resp.status_code == 200
    assert resp.json() == {
        "status": "ready",
        "checks": {"postgres": "ok", "redis": "ok"},
    }


async def test_readyz_returns_503_problem_json_when_redis_unavailable(
    client: AsyncClient,
) -> None:
    app: Any = client.app  # type: ignore[attr-defined]
    original_redis = app.state.redis

    class BrokenRedis:
        async def ping(self) -> bool:
            raise ConnectionError("Redis unreachable")

    app.state.redis = BrokenRedis()
    try:
        resp = await client.get("/readyz")
        assert resp.status_code == 503
        assert resp.headers["content-type"].startswith("application/problem+json")
        body = resp.json()
        assert body["code"] == "dependency_unavailable"
        assert body["status"] == 503
    finally:
        app.state.redis = original_redis
