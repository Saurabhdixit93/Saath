from __future__ import annotations

import asyncio
import json

import pytest
from fastapi.testclient import TestClient
from httpx import AsyncClient
from starlette.websockets import WebSocketDisconnect

from saath_api.core.config import Settings
from saath_api.core.crypto import create_anon_token
from saath_api.providers.messaging import FakeMessagingProvider
from saath_api.realtime.pubsub import publish_conversation_event, publish_user_event


async def _otp_login(
    client: AsyncClient,
    fake_messaging: FakeMessagingProvider,
    phone: str,
) -> tuple[str, str]:
    start = await client.post(
        "/v1/auth/otp/start",
        json={"phone": phone, "channel": "whatsapp", "turnstile": "ok"},
    )
    assert start.status_code == 200
    code = fake_messaging.sent_messages[-1].code
    verify = await client.post(
        "/v1/auth/otp/verify",
        json={"request_id": start.json()["request_id"], "code": code},
    )
    assert verify.status_code == 200
    return str(verify.json()["access"]), str(verify.json()["user"]["id"])


def test_ws_rejects_invalid_and_missing_auth_frame(test_settings: Settings) -> None:
    from saath_api.main import create_app

    app = create_app(settings=test_settings)
    with TestClient(app) as sync_client:
        with sync_client.websocket_connect("/v1/ws") as ws:
            ws.send_text(json.dumps({"type": "ping"}))
            with pytest.raises(WebSocketDisconnect) as exc_info:
                ws.receive_text()
            assert exc_info.value.code == 1008

        with sync_client.websocket_connect("/v1/ws") as ws:
            ws.send_text(json.dumps({"type": "auth", "token": "invalid.jwt.token"}))
            with pytest.raises(WebSocketDisconnect) as exc_info2:
                ws.receive_text()
            assert exc_info2.value.code == 4001


async def test_ws_auth_ping_pong_typing_and_pubsub_fanout(
    client: AsyncClient,
    fake_messaging: FakeMessagingProvider,
) -> None:
    tok_a, uid_a = await _otp_login(client, fake_messaging, "9876543501")
    tok_b, uid_b = await _otp_login(client, fake_messaging, "9876543502")
    h_a = {"Authorization": f"Bearer {tok_a}"}
    h_b = {"Authorization": f"Bearer {tok_b}"}

    va = (
        await client.post(
            "/v1/journeys/verify", headers=h_a, json={"mode": "train", "pnr": "4111111111"}
        )
    ).json()
    vb = (
        await client.post(
            "/v1/journeys/verify", headers=h_b, json={"mode": "train", "pnr": "4222222222"}
        )
    ).json()
    await client.put(
        f"/v1/parties/{vb['party']['id']}/goal",
        headers=h_b,
        json={
            "goal_type": "open_to_help",
            "movers": [vb["seat_holders"][0]["id"]],
            "constraints": {},
        },
    )
    await client.put(
        f"/v1/parties/{va['party']['id']}/goal",
        headers=h_a,
        json={"goal_type": "lower", "movers": [va["seat_holders"][0]["id"]], "constraints": {}},
    )

    matches = (
        await client.get(f"/v1/parties/{va['party']['id']}/matches?kind=pair", headers=h_a)
    ).json()["items"]
    convo = (
        await client.post("/v1/conversations", headers=h_a, json={"card_id": matches[0]["card_id"]})
    ).json()
    convo_id = convo["id"]

    app = client.app  # type: ignore[attr-defined]
    redis = app.state.redis

    with TestClient(app) as sync_client:
        with (
            sync_client.websocket_connect("/v1/ws") as ws_a,
            sync_client.websocket_connect("/v1/ws") as ws_b,
        ):
            ws_a.send_text(json.dumps({"type": "auth", "token": tok_a}))
            ws_b.send_text(json.dumps({"type": "auth", "token": tok_b}))
            assert ws_a.receive_json() == {"type": "ready"}
            assert ws_b.receive_json() == {"type": "ready"}

            ws_a.send_text(json.dumps({"type": "ping"}))
            assert ws_a.receive_json() == {"type": "pong"}

            ws_a.send_text(json.dumps({"type": "typing", "conversation_id": convo_id}))
            typing_evt = ws_b.receive_json()
            assert typing_evt["type"] == "typing"
            assert typing_evt["conversation_id"] == convo_id
            assert "user_id" not in typing_evt
            assert typing_evt["alias"].startswith("Passenger ")

            await publish_user_event(
                redis,
                uid_a,
                {
                    "type": "journey.chart",
                    "journey_id": va["journey"]["id"],
                    "state": "final",
                    "changed": True,
                },
            )
            chart_evt = ws_a.receive_json()
            assert chart_evt["type"] == "journey.chart"
            assert chart_evt["journey_id"] == va["journey"]["id"]

            await publish_conversation_event(
                redis,
                convo_id,
                {
                    "type": "message.new",
                    "conversation_id": convo_id,
                    "message": {"id": "m1", "body": "hi"},
                },
            )
            msg_evt = ws_b.receive_json()
            assert msg_evt["type"] in ("typing", "message.new")


async def test_sse_stream_requires_auth_and_streams_events(
    client: AsyncClient,
    test_settings: Settings,
) -> None:
    unauth = await client.get("/v1/events/stream")
    assert unauth.status_code == 401

    anon_tok, _ = create_anon_token(test_settings)
    app = client.app  # type: ignore[attr-defined]
    redis = app.state.redis

    # Trigger an event shortly after stream starts
    async def _publish_soon() -> None:
        await asyncio.sleep(0.05)
        await redis.publish("user:nonexistent", "{}")

    asyncio.create_task(_publish_soon())
    async with client.stream(
        "GET",
        "/v1/events/stream",
        headers={"Authorization": f"Bearer {anon_tok}"},
    ) as resp:
        assert resp.status_code == 200
        assert "text/event-stream" in resp.headers["content-type"]
        first_chunk = await resp.aiter_text().__anext__()
        assert ": connected" in first_chunk
