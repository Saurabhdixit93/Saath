from __future__ import annotations

from uuid import UUID

import httpx

from saath_api.core.crypto import verify_hmac_sha256_hex
from saath_api.providers.base import ProviderError
from saath_api.providers.payment.base import GatewayOrderDTO


class RazorpayPaymentAdapter:
    name = "razorpay"

    def __init__(
        self,
        *,
        key_id: str,
        key_secret: str,
        webhook_secret: str,
        base_url: str = "https://api.razorpay.com/v1",
    ) -> None:
        self._key_id = key_id
        self._key_secret = key_secret
        self._webhook_secret = webhook_secret
        self._base_url = base_url.rstrip("/")

    async def create_order(
        self,
        *,
        order_id: UUID,
        amount_paise: int,
        currency: str,
        receipt: str,
        notes: dict[str, str],
    ) -> GatewayOrderDTO:
        _ = order_id
        if not self._key_id or not self._key_secret:
            raise ProviderError("Razorpay API credentials are not configured")
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.post(
                f"{self._base_url}/orders",
                auth=(self._key_id, self._key_secret),
                json={
                    "amount": amount_paise,
                    "currency": currency,
                    "receipt": receipt[:40],
                    "notes": notes,
                },
            )
        if resp.status_code >= 400:
            raise ProviderError(f"Razorpay order creation failed ({resp.status_code})")
        data = resp.json()
        return GatewayOrderDTO(
            provider=self.name,
            provider_order_id=str(data["id"]),
            amount_paise=int(data.get("amount", amount_paise)),
            currency=str(data.get("currency", currency)),
            checkout_mode="razorpay",
        )

    def verify_webhook_signature(self, raw_body: bytes, signature: str) -> bool:
        if not self._webhook_secret or not signature:
            return False
        return verify_hmac_sha256_hex(self._webhook_secret, raw_body, signature)

    def verify_payment_signature(
        self, *, gateway_order_id: str, gateway_payment_id: str, signature: str
    ) -> bool:
        if not self._key_secret or not signature:
            return False
        payload = f"{gateway_order_id}|{gateway_payment_id}".encode()
        return verify_hmac_sha256_hex(self._key_secret, payload, signature)
