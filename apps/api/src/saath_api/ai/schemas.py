from __future__ import annotations

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from saath_api.journeys.schemas import GoalConstraintsDTO, StandingOfferDTO


class ConciergeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    journey_id: UUID
    text: str = Field(min_length=1, max_length=1000)


class ConciergeProposalDTO(BaseModel):
    model_config = ConfigDict(extra="forbid")

    goal_type: Literal[
        "together",
        "lower",
        "upper",
        "same_coach",
        "window",
        "aisle",
        "legroom",
        "specific_seats",
        "open_to_help",
    ]
    movers: list[UUID]
    preferred_seats: list[str] = Field(default_factory=list, max_length=4)
    constraints: GoalConstraintsDTO = Field(default_factory=GoalConstraintsDTO)
    standing_offer: StandingOfferDTO | None = None
    summary: str | None = None


class DraftRequestBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    card_id: str = Field(min_length=4, max_length=128)
    tone: str = Field(default="polite", min_length=1, max_length=32)
    lang: Literal["en", "hi"] | None = None


class DraftRequestResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str = Field(min_length=1, max_length=300)
