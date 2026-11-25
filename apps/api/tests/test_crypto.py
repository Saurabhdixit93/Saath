from __future__ import annotations

import pytest

from saath_api.core.config import Settings
from saath_api.core.crypto import (
    blind_index_phone,
    create_access_token,
    create_anon_token,
    decode_jwt,
    decrypt_phone,
    encrypt_phone,
    hash_otp,
    normalize_indian_phone,
    verify_otp_hash,
)
from saath_api.core.errors import ProblemDetailError
from saath_api.core.ids import uuid7


def test_indian_phone_normalization() -> None:
    assert normalize_indian_phone("9876543210") == "+919876543210"
    assert normalize_indian_phone("+91 98765-43210") == "+919876543210"
    assert normalize_indian_phone("919876543210") == "+919876543210"

    for invalid in ("1234567890", "9८७६५४३२१०", "9٩٨٧٦٥٤٣٢١", "9８７６５４３２１０"):
        with pytest.raises(ProblemDetailError) as exc:
            normalize_indian_phone(invalid)
        assert exc.value.code == "invalid_phone"


def test_uuid7_strictly_monotonic_within_same_ms() -> None:
    ids = [uuid7() for _ in range(5000)]
    assert all(u.version == 7 for u in ids)
    assert all(ids[i] < ids[i + 1] for i in range(len(ids) - 1))


def test_phone_aes_gcm_and_blind_index() -> None:
    settings = Settings(env="test")
    phone = "+919876543210"

    enc1 = encrypt_phone(phone, settings.phone_aes_key)
    enc2 = encrypt_phone(phone, settings.phone_aes_key)
    assert enc1 != enc2  # random 12B nonce
    assert phone.encode() not in enc1
    assert decrypt_phone(enc1, settings.phone_aes_key) == phone

    idx1 = blind_index_phone(phone, settings.phone_blind_index_key)
    idx2 = blind_index_phone(phone, settings.phone_blind_index_key)
    assert idx1 == idx2
    assert len(idx1) == 32


def test_argon2_otp_hash_and_verify() -> None:
    digest = hash_otp("482910")
    assert "482910" not in digest
    assert verify_otp_hash(digest, "482910") is True
    assert verify_otp_hash(digest, "000000") is False


def test_eddsa_jwt_anon_and_user_claims() -> None:
    settings = Settings(env="test")
    anon_jwt, anon_ttl = create_anon_token(settings)
    assert anon_ttl == 7200
    anon_claims = decode_jwt(anon_jwt, settings.jwt_public_key)
    assert anon_claims["kind"] == "anon"
    assert str(anon_claims["sub"]).startswith("anon:")
    assert anon_claims["scopes"] == ["anon"]

    uid = uuid7()
    did = uuid7()
    user_jwt, user_ttl = create_access_token(settings, user_id=uid, device_id=did)
    assert user_ttl == 900
    user_claims = decode_jwt(user_jwt, settings.jwt_public_key)
    assert user_claims["kind"] == "user"
    assert user_claims["sub"] == str(uid)
    assert user_claims["device_id"] == str(did)
    assert user_claims["scopes"] == ["user"]
