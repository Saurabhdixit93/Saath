from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from saath_api.auth.dependencies import Actor, require_user_actor
from saath_api.core.db import get_db
from saath_api.core.errors import ProblemDetailError, openapi_error_responses
from saath_api.dpdp.schemas import (
    ConsentsListResponse,
    DeleteAccountResponse,
    SaveConsentsRequest,
    SaveConsentsResponse,
)
from saath_api.dpdp.service import (
    delete_user_account,
    export_user_data_zip,
    get_user_consents,
    save_user_consents,
)

router = APIRouter(prefix="/v1", tags=["dpdp"])


def _user_id(actor: Actor) -> UUID:
    # require_user_actor already guarantees a user id; this narrows the type for mypy.
    if actor.user_id is None:
        raise ProblemDetailError(
            status_code=status.HTTP_403_FORBIDDEN,
            code="user_auth_required",
            title="Phone Verification Required",
            detail="This action requires a verified user session.",
        )
    return actor.user_id


@router.get(
    "/me/consents",
    response_model=ConsentsListResponse,
    responses=openapi_error_responses(
        status.HTTP_401_UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN,
    ),
)
async def get_v1_me_consents(
    actor: Actor = Depends(require_user_actor),
    db: AsyncSession = Depends(get_db),
) -> ConsentsListResponse:
    return await get_user_consents(db=db, user_id=_user_id(actor))


@router.post(
    "/me/consents",
    response_model=SaveConsentsResponse,
    status_code=status.HTTP_200_OK,
    responses=openapi_error_responses(
        status.HTTP_401_UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN,
        status.HTTP_422_UNPROCESSABLE_ENTITY,
    ),
)
async def post_v1_me_consents(
    body: SaveConsentsRequest,
    actor: Actor = Depends(require_user_actor),
    db: AsyncSession = Depends(get_db),
) -> SaveConsentsResponse:
    return await save_user_consents(
        db=db,
        user_id=_user_id(actor),
        items=body.consents,
    )


@router.get(
    "/me/export",
    responses={
        200: {
            "content": {"application/zip": {}},
            "description": "Zipped JSON export of all personal data under DPDP Act 2023.",
        },
        **openapi_error_responses(
            status.HTTP_401_UNAUTHORIZED,
            status.HTTP_403_FORBIDDEN,
            status.HTTP_404_NOT_FOUND,
        ),
    },
)
async def get_v1_me_export(
    actor: Actor = Depends(require_user_actor),
    db: AsyncSession = Depends(get_db),
) -> Response:
    zip_bytes = await export_user_data_zip(db=db, user_id=_user_id(actor))
    return Response(
        content=zip_bytes,
        media_type="application/zip",
        headers={
            "Content-Disposition": 'attachment; filename="saath-data-export.zip"',
            "Content-Type": "application/zip",
        },
    )


@router.delete(
    "/me",
    response_model=DeleteAccountResponse,
    status_code=status.HTTP_200_OK,
    responses=openapi_error_responses(
        status.HTTP_401_UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN,
        status.HTTP_404_NOT_FOUND,
    ),
)
async def delete_v1_me(
    actor: Actor = Depends(require_user_actor),
    db: AsyncSession = Depends(get_db),
) -> DeleteAccountResponse:
    return await delete_user_account(db=db, user_id=_user_id(actor))
