from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol
from uuid import UUID


@dataclass(frozen=True)
class GatewayOrderDTO:
    provider: str
    provider_order_id: str
    amount_paise: int
    currency: str
    checkout_mode: str


class PaymentGatewayProvider(Protocol):
    name: str

    async def create_order(
        self,
        *,
        order_id: UUID,
        amount_paise: int,
        currency: str,
        receipt: str,
        notes: dict[str, str],
    ) -> GatewayOrderDTO: ...

    def verify_webhook_signature(self, raw_body: bytes, signature: str) -> bool: ...

    def verify_payment_signature(
        self, *, gateway_order_id: str, gateway_payment_id: str, signature: str
    ) -> bool: ...
