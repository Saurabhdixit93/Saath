from __future__ import annotations

import uuid
from typing import Any

import pytest
from httpx import AsyncClient

from saath_api.auth.dependencies import Actor, authorize
from saath_api.core.errors import ProblemDetailError
from saath_api.providers.messaging import FakeMessagingProvider


async def _get_user_tokens(
    client: AsyncClient, fake_messaging: FakeMessagingProvider, phone: str
) -> dict[str, Any]:
    start = await client.post(
        "/v1/auth/otp/start",
        json={"phone": phone, "channel": "whatsapp", "turnstile": "ok"},
    )
    code = fake_messaging.sent_messages[-1].code
    verify = await client.post(
        "/v1/auth/otp/verify",
        json={"request_id": start.json()["request_id"], "code": code},
    )
    return verify.json()  # type: ignore[no-any-return]


async def test_me_requires_user_jwt_and_updates_preferences(
    client: AsyncClient,
    fake_messaging: FakeMessagingProvider,
) -> None:
    unauth = await client.get("/v1/me")
    assert unauth.status_code == 401

    anon = await client.post("/v1/auth/anonymous", json={"turnstile": "ok"})
    anon_me = await client.get(
        "/v1/me", headers={"Authorization": f"Bearer {anon.json()['access']}"}
    )
    assert anon_me.status_code == 403
    assert anon_me.json()["code"] == "user_auth_required"

    tokens = await _get_user_tokens(client, fake_messaging, "9876540010")
    headers = {"Authorization": f"Bearer {tokens['access']}"}

    me = await client.get("/v1/me", headers=headers)
    assert me.status_code == 200
    assert me.json()["locale"] == "en"
    assert me.json()["women_only_default"] is False
    assert me.json()["gender_self"] == "undisclosed"

    # Actor IDs in body must be rejected
    bad_patch = await client.patch(
        "/v1/me",
        headers=headers,
        json={"user_id": str(uuid.uuid4()), "locale": "hi"},
    )
    assert bad_patch.status_code == 422

    patched = await client.patch(
        "/v1/me",
        headers=headers,
        json={
            "locale": "hi",
            "women_only_default": True,
            "display_alias": "Asha",
            "gender_self": "female",
        },
    )
    assert patched.status_code == 200
    body = patched.json()
    assert body["locale"] == "hi"
    assert body["women_only_default"] is True
    assert body["display_alias"] == "Asha"
    assert body["gender_self"] == "female"


def test_authorize_cross_actor_raises_403() -> None:
    owner = uuid.uuid4()
    other = uuid.uuid4()
    actor = Actor(
        kind="user",
        user_id=other,
        anon_id=None,
        device_id=uuid.uuid4(),
        scopes=frozenset({"user"}),
    )
    with pytest.raises(ProblemDetailError) as exc:
        authorize(actor, "journey.delete", resource_owner_id=owner)
    assert exc.value.status_code == 403

    owner_actor = Actor(
        kind="user",
        user_id=owner,
        anon_id=None,
        device_id=uuid.uuid4(),
        scopes=frozenset({"user"}),
    )
    authorize(owner_actor, "journey.delete", resource_owner_id=owner)


async def test_no_test_login_or_demo_reset_routes_exposed(client: AsyncClient) -> None:
    for path in ("/test-login", "/v1/test-login", "/admin/reset-demo", "/v1/admin/reset-demo"):
        resp = await client.post(path)
        assert resp.status_code == 404
