from __future__ import annotations

from uuid import UUID

from saath_api.core.crypto import hmac_sha256_hex, verify_hmac_sha256_hex
from saath_api.providers.payment.base import GatewayOrderDTO

_SANDBOX_FALLBACK_SECRET = "saath-sandbox-webhook-secret"  # noqa: S105


class SandboxPaymentAdapter:
    name = "sandbox"

    def __init__(self, *, webhook_secret: str = "") -> None:
        self._secret = webhook_secret or _SANDBOX_FALLBACK_SECRET

    async def create_order(
        self,
        *,
        order_id: UUID,
        amount_paise: int,
        currency: str,
        receipt: str,
        notes: dict[str, str],
    ) -> GatewayOrderDTO:
        _ = (receipt, notes)
        return GatewayOrderDTO(
            provider=self.name,
            provider_order_id=f"order_sbx_{order_id.hex[:16]}",
            amount_paise=amount_paise,
            currency=currency,
            checkout_mode="sandbox",
        )

    def sign_webhook_payload(self, raw_body: bytes) -> str:
        return hmac_sha256_hex(self._secret, raw_body)

    def verify_webhook_signature(self, raw_body: bytes, signature: str) -> bool:
        if not signature:
            return False
        return verify_hmac_sha256_hex(self._secret, raw_body, signature)

    def verify_payment_signature(
        self, *, gateway_order_id: str, gateway_payment_id: str, signature: str
    ) -> bool:
        payload = f"{gateway_order_id}|{gateway_payment_id}".encode()
        return verify_hmac_sha256_hex(self._secret, payload, signature)
