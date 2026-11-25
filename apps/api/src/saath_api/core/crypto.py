from __future__ import annotations

import base64
import hashlib
import hmac
import os
import re
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi import status

from saath_api.core.config import Settings
from saath_api.core.errors import ProblemDetailError
from saath_api.core.ids import uuid7

_PHONE_RE = re.compile(r"^(?:\+?91)?([6-9][0-9]{9})$")
_PHONE_AAD = b"saath:phone:v1"
_PASSWORD_HASHER = PasswordHasher()


def normalize_indian_phone(raw: str) -> str:
    cleaned = re.sub(r"[\s\-()]+", "", raw.strip())
    match = _PHONE_RE.fullmatch(cleaned)
    if not match:
        raise ProblemDetailError(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            code="invalid_phone",
            title="Invalid Indian mobile number",
            detail="Phone number must be a valid 10-digit Indian mobile number (+91).",
        )
    return f"+91{match.group(1)}"


def _decode_key_bytes(key_b64: str) -> bytes:
    raw = base64.b64decode(key_b64.encode("ascii"))
    if len(raw) != 32:
        raise ValueError("Encryption/HMAC key must decode to exactly 32 bytes")
    return raw


def encrypt_phone(phone_e164: str, aes_key_b64: str) -> bytes:
    key = _decode_key_bytes(aes_key_b64)
    nonce = os.urandom(12)
    ciphertext = AESGCM(key).encrypt(nonce, phone_e164.encode("utf-8"), _PHONE_AAD)
    return nonce + ciphertext


def decrypt_phone(blob: bytes, aes_key_b64: str) -> str:
    if len(blob) < 28:
        raise ValueError("Invalid encrypted phone payload")
    key = _decode_key_bytes(aes_key_b64)
    nonce = blob[:12]
    ciphertext = blob[12:]
    plaintext = AESGCM(key).decrypt(nonce, ciphertext, _PHONE_AAD)
    return plaintext.decode("utf-8")


def blind_index_phone(phone_e164: str, hmac_key_b64: str) -> bytes:
    key = _decode_key_bytes(hmac_key_b64)
    return hmac.new(key, phone_e164.encode("utf-8"), hashlib.sha256).digest()


def hash_token(raw_token: str) -> bytes:
    return hashlib.sha256(raw_token.encode("utf-8")).digest()


def hmac_sha256_bytes(secret: str, value: str | bytes) -> bytes:
    payload = value.encode("utf-8") if isinstance(value, str) else value
    return hmac.new(secret.encode("utf-8"), payload, hashlib.sha256).digest()


def hmac_sha256_hex(secret: str, value: str | bytes) -> str:
    return hmac_sha256_bytes(secret, value).hex()


def verify_hmac_sha256_hex(secret: str, payload: bytes, signature: str) -> bool:
    expected = hmac_sha256_hex(secret, payload)
    return hmac.compare_digest(expected, signature.strip().lower())


def hash_pnr(pnr: str, pepper: str) -> bytes:
    normalized = pnr.strip().upper()
    return hmac_sha256_bytes(pepper, normalized)


def hash_invite_token(token: str, secret: str) -> bytes:
    return hmac_sha256_bytes(secret, token.strip())


def hash_otp(code: str) -> str:
    return _PASSWORD_HASHER.hash(code)


def verify_otp_hash(otp_hash: str, code: str) -> bool:
    try:
        return _PASSWORD_HASHER.verify(otp_hash, code)
    except (VerifyMismatchError, InvalidHashError):
        return False


def create_anon_token(settings: Settings, anon_id: UUID | None = None) -> tuple[str, int]:
    now = datetime.now(UTC)
    ttl = settings.jwt_anon_ttl_seconds
    uid = anon_id or uuid7()
    payload: dict[str, Any] = {
        "sub": f"anon:{uid}",
        "kind": "anon",
        "scopes": ["anon"],
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(seconds=ttl)).timestamp()),
        "jti": str(uuid7()),
    }
    token = jwt.encode(payload, settings.jwt_private_key, algorithm="EdDSA")
    return token, ttl


def create_access_token(
    settings: Settings,
    *,
    user_id: UUID,
    device_id: UUID,
    scopes: tuple[str, ...] = ("user",),
) -> tuple[str, int]:
    now = datetime.now(UTC)
    ttl = settings.jwt_access_ttl_seconds
    payload: dict[str, Any] = {
        "sub": str(user_id),
        "kind": "user",
        "device_id": str(device_id),
        "scopes": list(scopes),
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(seconds=ttl)).timestamp()),
        "jti": str(uuid7()),
    }
    token = jwt.encode(payload, settings.jwt_private_key, algorithm="EdDSA")
    return token, ttl


def decode_jwt(token: str, public_key_pem: str, *, verify_exp: bool = True) -> dict[str, Any]:
    decoded = jwt.decode(
        token,
        public_key_pem,
        algorithms=["EdDSA"],
        options={"require": ["sub", "kind", "exp", "iat"], "verify_exp": verify_exp},
    )
    if not isinstance(decoded, dict):
        raise jwt.InvalidTokenError("Invalid JWT payload")
    return decoded
