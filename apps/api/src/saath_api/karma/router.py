from __future__ import annotations

from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession

from saath_api.auth.dependencies import Actor, require_user_actor
from saath_api.core.db import get_db
from saath_api.core.errors import openapi_error_responses
from saath_api.karma.schemas import (
    KarmaWalletResponse,
    RedeemRewardRequest,
    RedeemRewardResponse,
    RewardsCatalogueResponse,
)
from saath_api.karma.service import (
    get_karma_wallet,
    get_rewards_catalogue,
    redeem_reward,
)

router = APIRouter(prefix="/v1", tags=["karma"])


@router.get(
    "/karma",
    response_model=KarmaWalletResponse,
    responses=openapi_error_responses(
        status.HTTP_401_UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN,
    ),
)
async def get_v1_karma(
    actor: Actor = Depends(require_user_actor),
    db: AsyncSession = Depends(get_db),
) -> KarmaWalletResponse:
    return await get_karma_wallet(db=db, actor=actor)


@router.get(
    "/karma/rewards",
    response_model=RewardsCatalogueResponse,
    responses=openapi_error_responses(
        status.HTTP_401_UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN,
    ),
)
async def get_v1_karma_rewards(
    actor: Actor = Depends(require_user_actor),
    db: AsyncSession = Depends(get_db),
) -> RewardsCatalogueResponse:
    return await get_rewards_catalogue(db=db, actor=actor)


@router.post(
    "/karma/rewards/redeem",
    response_model=RedeemRewardResponse,
    status_code=status.HTTP_201_CREATED,
    responses=openapi_error_responses(
        status.HTTP_401_UNAUTHORIZED,
        status.HTTP_403_FORBIDDEN,
        status.HTTP_404_NOT_FOUND,
        status.HTTP_409_CONFLICT,
        status.HTTP_422_UNPROCESSABLE_ENTITY,
    ),
)
async def post_v1_karma_rewards_redeem(
    body: RedeemRewardRequest,
    actor: Actor = Depends(require_user_actor),
    db: AsyncSession = Depends(get_db),
) -> RedeemRewardResponse:
    return await redeem_reward(db=db, actor=actor, req=body)
