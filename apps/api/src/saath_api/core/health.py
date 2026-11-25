from __future__ import annotations

from fastapi import APIRouter, Request, status
from pydantic import BaseModel

from saath_api.core.db import check_db_ready
from saath_api.core.errors import ProblemDetailError, openapi_error_responses
from saath_api.core.redis import check_redis_ready

router = APIRouter(tags=["health"])


class HealthResponse(BaseModel):
    status: str


class ReadyChecks(BaseModel):
    postgres: str
    redis: str


class ReadyResponse(BaseModel):
    status: str
    checks: ReadyChecks


@router.get("/healthz", response_model=HealthResponse)
async def healthz() -> HealthResponse:
    return HealthResponse(status="ok")


@router.get(
    "/readyz",
    response_model=ReadyResponse,
    responses=openapi_error_responses(status.HTTP_503_SERVICE_UNAVAILABLE),
)
async def readyz(request: Request) -> ReadyResponse:
    pg_ok = await check_db_ready(request.app.state.db_engine)
    redis_ok = await check_redis_ready(request.app.state.redis)
    if not pg_ok or not redis_ok:
        raise ProblemDetailError(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            code="dependency_unavailable",
            title="Dependency Unavailable",
            detail=(
                f"Readiness check failed: postgres={'ok' if pg_ok else 'error'}, "
                f"redis={'ok' if redis_ok else 'error'}."
            ),
        )
    return ReadyResponse(
        status="ready",
        checks=ReadyChecks(postgres="ok", redis="ok"),
    )
