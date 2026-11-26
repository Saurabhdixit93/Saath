from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class KarmaLedgerEntryDTO(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: int
    proposal_id: UUID | None = None
    delta: int
    points: int
    state: Literal["pending", "credited", "reversed"]
    reason: str
    created_at: datetime


class KarmaBadgeDTO(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: str
    title: str
    description: str
    earned_at: datetime


class LeaderboardEntryDTO(BaseModel):
    model_config = ConfigDict(extra="forbid")

    rank: int
    display_alias: str
    points: int
    swaps_completed: int


class KarmaWalletResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    balance: int
    pending: int
    redeemed_points: int
    available_balance: int
    history: list[KarmaLedgerEntryDTO]
    badges: list[KarmaBadgeDTO]
    leaderboard: list[LeaderboardEntryDTO]


class RewardItemDTO(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: str
    title_en: str
    title_hi: str
    description_en: str | None = None
    description_hi: str | None = None
    cost_points: int
    stock: int | None = None


class RewardRedemptionDTO(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: UUID
    reward_code: str
    points_spent: int
    status: str
    created_at: datetime


class RewardsCatalogueResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: bool
    items: list[RewardItemDTO]
    redemptions: list[RewardRedemptionDTO]


class RedeemRewardRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reward_code: str = Field(min_length=1, max_length=64)


class RedeemRewardResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: UUID
    reward_code: str
    points_spent: int
    status: str
    created_at: datetime
