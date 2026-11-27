from __future__ import annotations

import base64
import html
import io
import json
import secrets
from typing import Any

import qrcode
import qrcode.image.svg
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)
from PIL import Image, ImageDraw, ImageFont

_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def generate_public_code(length: int = 6) -> str:
    suffix = "".join(secrets.choice(_CODE_ALPHABET) for _ in range(length))
    return f"SW-{suffix}"


def canonical_card_bytes(payload: dict[str, Any]) -> bytes:
    return json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
    ).encode("utf-8")


def sign_swap_card(payload: dict[str, Any], private_key_pem: str) -> bytes:
    key = serialization.load_pem_private_key(
        private_key_pem.encode("utf-8"),
        password=None,
    )
    if not isinstance(key, Ed25519PrivateKey):
        raise ValueError("Swap card signing key must be Ed25519")
    return key.sign(canonical_card_bytes(payload))


def verify_swap_card_signature(
    payload: dict[str, Any],
    signature: bytes,
    public_key_pem: str,
) -> bool:
    try:
        key = serialization.load_pem_public_key(public_key_pem.encode("utf-8"))
        if not isinstance(key, Ed25519PublicKey):
            return False
        key.verify(signature, canonical_card_bytes(payload))
        return True
    except (InvalidSignature, ValueError, TypeError):
        return False


def encode_signature_b64(signature: bytes) -> str:
    return base64.urlsafe_b64encode(signature).decode("ascii").rstrip("=")


def render_swap_card_svg(payload: dict[str, Any], qr_url: str) -> str:
    public_code = html.escape(str(payload.get("public_code", "")))
    service = html.escape(str(payload.get("service", "")))
    svc_date = html.escape(str(payload.get("date", "")))
    revoked = bool(payload.get("revoked", False))
    participants = payload.get("participants", [])

    qr = qrcode.QRCode(border=1, box_size=4)
    qr.add_data(qr_url)
    qr.make(fit=True)
    qr_svg = qr.make_image(image_factory=qrcode.image.svg.SvgPathImage)
    qr_buf = io.BytesIO()
    qr_svg.save(qr_buf)
    qr_raw = qr_buf.getvalue().decode("utf-8")
    # Extract <path .../> from qrcode svg
    path_start = qr_raw.find("<path")
    path_end = qr_raw.find("/>", path_start)
    qr_path = qr_raw[path_start : path_end + 2] if path_start != -1 and path_end != -1 else ""

    rows_svg: list[str] = []
    y = 148
    for p in participants[:6]:
        from_s = html.escape(str(p.get("from_seat", "")))
        to_s = html.escape(str(p.get("to_seat", "")))
        alias = html.escape(str(p.get("alias", "")))
        rows_svg.append(
            f'<text x="28" y="{y}" font-family="monospace" font-size="16" font-weight="700" fill="#1C1A17">{from_s} &#8644; {to_s}</text>'
        )
        rows_svg.append(
            f'<text x="28" y="{y + 18}" font-family="sans-serif" font-size="11" fill="#6B645A">{alias}</text>'
        )
        y += 42

    card_h = max(300, y + 68)
    status_badge = (
        '<rect x="420" y="22" width="132" height="28" rx="14" fill="#C2362F"/>'
        '<text x="486" y="40" text-anchor="middle" font-family="sans-serif" font-size="12" font-weight="700" fill="#FFFFFF">REVOKED</text>'
        if revoked
        else '<rect x="420" y="22" width="132" height="28" rx="14" fill="#2E8B57"/>'
        '<text x="486" y="40" text-anchor="middle" font-family="sans-serif" font-size="12" font-weight="700" fill="#FFFFFF">VERIFIED</text>'
    )

    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="580" height="{card_h}" viewBox="0 0 580 {card_h}" role="img" aria-label="Saath Swap Card {public_code}">'
        f'<rect width="580" height="{card_h}" rx="18" fill="#FAF7F2" stroke="#E4DDD2" stroke-width="2"/>'
        f'<rect x="0" y="0" width="580" height="72" rx="18" fill="#1F6F78"/>'
        f'<rect x="0" y="54" width="580" height="18" fill="#1F6F78"/>'
        f'<text x="28" y="34" font-family="sans-serif" font-size="13" font-weight="700" letter-spacing="1.5" fill="#FAF7F2">SAATH SWAP CARD</text>'
        f'<text x="28" y="56" font-family="monospace" font-size="18" font-weight="700" fill="#FFFFFF">#{public_code}</text>'
        f"{status_badge}"
        f'<text x="28" y="102" font-family="sans-serif" font-size="15" font-weight="700" fill="#1C1A17">{service} &#183; {svc_date}</text>'
        f'<line x1="28" y1="116" x2="400" y2="116" stroke="#E4DDD2" stroke-width="1"/>'
        f"{''.join(rows_svg)}"
        f'<g transform="translate(425, 92) scale(1.1)">'
        f'<rect x="-6" y="-6" width="128" height="128" rx="8" fill="#FFFFFF" stroke="#E4DDD2"/>'
        f"{qr_path}"
        f"</g>"
        f'<text x="28" y="{card_h - 32}" font-family="sans-serif" font-size="12" font-weight="600" fill="#1F6F78">Subject to TTE approval &#183; No personal data shown</text>'
        f'<text x="28" y="{card_h - 14}" font-family="monospace" font-size="10" fill="#6B645A">{html.escape(qr_url)}</text>'
        f"</svg>"
    )


def render_swap_card_png(payload: dict[str, Any], qr_url: str) -> bytes:
    participants = payload.get("participants", [])
    width = 900
    height = max(480, 260 + len(participants) * 64)
    img = Image.new("RGB", (width, height), color=(250, 247, 242))
    draw = ImageDraw.Draw(img)
    font = ImageFont.load_default()

    # Header bar
    draw.rectangle([(0, 0), (width, 104)], fill=(31, 111, 120))
    draw.rectangle([(12, 12), (width - 12, height - 12)], outline=(228, 221, 210), width=2)

    public_code = str(payload.get("public_code", ""))
    service = str(payload.get("service", ""))
    svc_date = str(payload.get("date", ""))
    revoked = bool(payload.get("revoked", False))

    draw.text((32, 26), "SAATH SWAP CARD", fill=(250, 247, 242), font=font)
    draw.text((32, 56), f"#{public_code}", fill=(255, 255, 255), font=font)
    badge_color = (194, 54, 47) if revoked else (46, 139, 87)
    badge_text = "REVOKED" if revoked else "VERIFIED"
    draw.rounded_rectangle([(width - 180, 32), (width - 32, 72)], radius=16, fill=badge_color)
    draw.text((width - 142, 46), badge_text, fill=(255, 255, 255), font=font)

    draw.text((32, 132), f"{service}  |  {svc_date}", fill=(28, 26, 23), font=font)
    draw.line([(32, 160), (width - 260, 160)], fill=(228, 221, 210), width=2)

    y = 184
    for p in participants[:6]:
        from_s = str(p.get("from_seat", ""))
        to_s = str(p.get("to_seat", ""))
        alias = str(p.get("alias", ""))
        draw.text((32, y), f"{from_s}  <->  {to_s}", fill=(28, 26, 23), font=font)
        draw.text((32, y + 20), alias, fill=(107, 100, 90), font=font)
        y += 56

    # QR code on right side
    qr = qrcode.QRCode(border=1, box_size=5)
    qr.add_data(qr_url)
    qr.make(fit=True)
    qr_img = qr.make_image(fill_color="#1C1A17", back_color="#FFFFFF").convert("RGB")
    qr_img = qr_img.resize((180, 180))
    img.paste(qr_img, (width - 220, 136))

    draw.text(
        (32, height - 64),
        "Subject to TTE approval  |  Verified Ed25519 Swap Card",
        fill=(31, 111, 120),
        font=font,
    )
    draw.text((32, height - 40), qr_url, fill=(107, 100, 90), font=font)

    out = io.BytesIO()
    img.save(out, format="PNG")
    return out.getvalue()
