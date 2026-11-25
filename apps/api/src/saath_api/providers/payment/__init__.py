from __future__ import annotations

from saath_api.core.config import Settings
from saath_api.providers.payment.base import GatewayOrderDTO, PaymentGatewayProvider
from saath_api.providers.payment.razorpay import RazorpayPaymentAdapter
from saath_api.providers.payment.sandbox import SandboxPaymentAdapter

__all__ = [
    "GatewayOrderDTO",
    "PaymentGatewayProvider",
    "RazorpayPaymentAdapter",
    "SandboxPaymentAdapter",
    "build_payment_provider",
]


def build_payment_provider(settings: Settings) -> PaymentGatewayProvider:
    if settings.payment_provider == "razorpay":
        return RazorpayPaymentAdapter(
            key_id=settings.razorpay_key_id,
            key_secret=settings.razorpay_key_secret,
            webhook_secret=settings.razorpay_webhook_secret,
        )
    return SandboxPaymentAdapter(webhook_secret=settings.razorpay_webhook_secret)
