from __future__ import annotations

from typing import Any

import structlog
from fastapi import FastAPI, HTTPException, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from pydantic.json_schema import models_json_schema

logger = structlog.get_logger(__name__)

PROBLEM_JSON_MEDIA_TYPE = "application/problem+json"


class ProblemFieldError(BaseModel):
    field: str
    message: str
    type: str


class ProblemDetail(BaseModel):
    type: str = Field(default="https://saath.app/problems/error")
    title: str
    status: int
    detail: str
    code: str
    errors: list[ProblemFieldError] | None = None


class ProblemDetailError(Exception):
    def __init__(
        self,
        *,
        status_code: int,
        code: str,
        title: str,
        detail: str,
        type_uri: str | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.code = code
        self.title = title
        self.detail = detail
        self.type_uri = type_uri or f"https://saath.app/problems/{code}"
        self.headers = headers or {}


def _problem_response(
    *,
    status_code: int,
    code: str,
    title: str,
    detail: str,
    type_uri: str | None = None,
    errors: list[ProblemFieldError] | None = None,
    headers: dict[str, str] | None = None,
) -> JSONResponse:
    payload = ProblemDetail(
        type=type_uri or f"https://saath.app/problems/{code}",
        title=title,
        status=status_code,
        detail=detail,
        code=code,
        errors=errors,
    )
    return JSONResponse(
        status_code=status_code,
        content=payload.model_dump(exclude_none=True),
        media_type=PROBLEM_JSON_MEDIA_TYPE,
        headers=headers,
    )


def register_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(ProblemDetailError)
    async def handle_problem_error(_request: Request, exc: ProblemDetailError) -> JSONResponse:
        return _problem_response(
            status_code=exc.status_code,
            code=exc.code,
            title=exc.title,
            detail=exc.detail,
            type_uri=exc.type_uri,
            headers=exc.headers,
        )

    @app.exception_handler(HTTPException)
    async def handle_http_exception(_request: Request, exc: HTTPException) -> JSONResponse:
        detail = exc.detail if isinstance(exc.detail, str) else "HTTP error"
        return _problem_response(
            status_code=exc.status_code,
            code=f"http_{exc.status_code}",
            title=detail,
            detail=detail,
            headers=dict(exc.headers) if exc.headers else None,
        )

    @app.exception_handler(RequestValidationError)
    async def handle_validation_error(
        _request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        field_errors: list[ProblemFieldError] = []
        for err in exc.errors():
            loc = ".".join(str(part) for part in err.get("loc", ()))
            field_errors.append(
                ProblemFieldError(
                    field=loc,
                    message=str(err.get("msg", "Invalid value")),
                    type=str(err.get("type", "value_error")),
                )
            )
        return _problem_response(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            code="validation_error",
            title="Validation Error",
            detail="Request validation failed.",
            errors=field_errors,
        )

    @app.exception_handler(Exception)
    async def handle_unexpected_error(request: Request, exc: Exception) -> JSONResponse:
        logger.exception(
            "unhandled_exception",
            path=str(request.url.path),
            method=request.method,
            exc_info=exc,
        )
        return _problem_response(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            code="internal_error",
            title="Internal Server Error",
            detail="An unexpected error occurred.",
        )


def openapi_error_responses(*statuses: int) -> dict[int | str, dict[str, Any]]:
    mapping: dict[int | str, dict[str, Any]] = {}
    for code in statuses:
        mapping[code] = {
            "description": "RFC 9457 Problem Details error response",
            "content": {
                PROBLEM_JSON_MEDIA_TYPE: {"schema": {"$ref": "#/components/schemas/ProblemDetail"}}
            },
        }
    return mapping


def ensure_problem_schemas(schema: dict[str, Any]) -> dict[str, Any]:
    components = schema.setdefault("components", {})
    schemas = components.setdefault("schemas", {})
    if "ProblemDetail" not in schemas or "ProblemFieldError" not in schemas:
        _, top_schema = models_json_schema(
            [(ProblemDetail, "validation"), (ProblemFieldError, "validation")],
            ref_template="#/components/schemas/{model}",
        )
        defs = top_schema.get("$defs", {})
        for name, definition in defs.items():
            schemas.setdefault(name, definition)
    return schema
