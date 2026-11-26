from __future__ import annotations

import json

from httpx import AsyncClient

from saath_api.providers.messaging import FakeMessagingProvider


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


async def test_masked_chat_redaction_idempotency_translate_and_unmask_on_accept(
    client: AsyncClient,
    fake_messaging: FakeMessagingProvider,
) -> None:
    tok_a, uid_a = await _otp_login(client, fake_messaging, "9876543601")
    tok_b, uid_b = await _otp_login(client, fake_messaging, "9876543602")
    tok_c, _ = await _otp_login(client, fake_messaging, "9876543603")
    h_a = {"Authorization": f"Bearer {tok_a}"}
    h_b = {"Authorization": f"Bearer {tok_b}"}
    h_c = {"Authorization": f"Bearer {tok_c}"}

    va = (await client.post("/v1/journeys/verify", headers=h_a, json={"mode": "train", "pnr": "4111111111"})).json()
    vb = (await client.post("/v1/journeys/verify", headers=h_b, json={"mode": "train", "pnr": "4222222222"})).json()
    await client.put(f"/v1/parties/{vb['party']['id']}/goal", headers=h_b, json={"goal_type": "open_to_help", "movers": [vb["seat_holders"][0]["id"]], "constraints": {}})
    await client.put(f"/v1/parties/{va['party']['id']}/goal", headers=h_a, json={"goal_type": "lower", "movers": [va["seat_holders"][0]["id"]], "constraints": {}})

    matches = (await client.get(f"/v1/parties/{va['party']['id']}/matches?kind=pair", headers=h_a)).json()["items"]
    card_id = matches[0]["card_id"]

    # Cross-party chat creation rejected with 403
    cross = await client.post("/v1/conversations", headers=h_c, json={"card_id": card_id})
    assert cross.status_code == 403

    convo_resp = await client.post("/v1/conversations", headers=h_a, json={"card_id": card_id})
    assert convo_resp.status_code == 200
    convo = convo_resp.json()
    convo_id = convo["id"]
    assert convo["unmasked"] is False
    assert convo["partner_alias"].startswith("Passenger ")
    raw_convo_str = json.dumps(convo)
    assert uid_b not in raw_convo_str
    assert "20" not in convo["partner_alias"]

    # Idempotent conversation reuse
    convo_again = await client.post("/v1/conversations", headers=h_a, json={"card_id": card_id})
    assert convo_again.status_code == 200
    assert convo_again.json()["id"] == convo_id

    # Pre-accept obfuscated contact redaction + client_id idempotency
    m1 = await client.post(
        f"/v1/conversations/{convo_id}/messages",
        headers=h_a,
        json={"body": "Call me at nine eight seven six five four three two one zero or asha@okicici", "client_id": "cli-1"},
    )
    assert m1.status_code == 200
    d1 = m1.json()
    assert d1["moderation"] == "redacted"
    assert "•••" in d1["body"]
    assert "okicici" not in d1["body"]
    assert d1["redacted_hint"] == "Contact details unlock after you both agree"

    m1_dup = await client.post(
        f"/v1/conversations/{convo_id}/messages",
        headers=h_a,
        json={"body": "Different body ignored", "client_id": "cli-1"},
    )
    assert m1_dup.status_code == 200
    assert m1_dup.json()["id"] == d1["id"]

    # Benign quick reply + translate
    m2 = await client.post(
        f"/v1/conversations/{convo_id}/messages",
        headers=h_b,
        json={"body": "Happy to swap!", "client_id": "cli-2"},
    )
    assert m2.status_code == 200
    assert m2.json()["moderation"] == "ok"

    tr = await client.post(
        f"/v1/conversations/{convo_id}/translate",
        headers=h_a,
        json={"message_id": m2.json()["id"], "to": "hi"},
    )
    assert tr.status_code == 200
    assert tr.json()["to"] == "hi"
    assert len(tr.json()["translated_text"]) > 0

    # Hidden moderation message is excluded from recipient's GET /messages
    m_scam = await client.post(
        f"/v1/conversations/{convo_id}/messages",
        headers=h_a,
        json={"body": "Please send advance money and share your otp now", "client_id": "cli-scam"},
    )
    assert m_scam.status_code == 200
    assert m_scam.json()["moderation"] == "hidden"

    msgs_b = (await client.get(f"/v1/conversations/{convo_id}/messages", headers=h_b)).json()["items"]
    assert all(m["client_id"] != "cli-scam" for m in msgs_b)

    # Mutual swap accept unmasks conversation and allows phone post-accept
    swap = (await client.post("/v1/swaps", headers=h_a, json={"card_id": card_id})).json()
    acc1 = await client.post(f"/v1/swaps/{swap['id']}/accept", headers=h_a, json={"version": swap["version"]})
    assert acc1.status_code == 200
    acc2 = await client.post(f"/v1/swaps/{swap['id']}/accept", headers=h_b, json={"version": acc1.json()["version"]})
    assert acc2.status_code == 200

    list_a = (await client.get("/v1/conversations", headers=h_a)).json()["items"]
    assert list_a[0]["unmasked"] is True

    m_post = await client.post(
        f"/v1/conversations/{convo_id}/messages",
        headers=h_a,
        json={"body": "Meet near coach B3, call 9876543210", "client_id": "cli-post"},
    )
    assert m_post.status_code == 200
    assert "9876543210" in m_post.json()["body"]


async def test_block_and_three_distinct_reports_auto_restrict(
    client: AsyncClient,
    fake_messaging: FakeMessagingProvider,
) -> None:
    tok_target, _ = await _otp_login(client, fake_messaging, "9876543701")
    tok_r1, _ = await _otp_login(client, fake_messaging, "9876543702")
    tok_r2, _ = await _otp_login(client, fake_messaging, "9876543703")
    tok_r3, _ = await _otp_login(client, fake_messaging, "9876543704")

    h_t = {"Authorization": f"Bearer {tok_target}"}
    vt = (await client.post("/v1/journeys/verify", headers=h_t, json={"mode": "train", "pnr": "4111111111"})).json()
    await client.put(f"/v1/parties/{vt['party']['id']}/goal", headers=h_t, json={"goal_type": "open_to_help", "movers": [vt["seat_holders"][0]["id"]], "constraints": {}})

    convo_ids: list[str] = []
    for pnr, tok in [("4222222222", tok_r1), ("4333333333", tok_r2), ("4444444444", tok_r3)]:
        hdr = {"Authorization": f"Bearer {tok}"}
        vr = (await client.post("/v1/journeys/verify", headers=hdr, json={"mode": "train", "pnr": pnr})).json()
        await client.put(f"/v1/parties/{vr['party']['id']}/goal", headers=hdr, json={"goal_type": "lower", "movers": [vr["seat_holders"][0]["id"]], "constraints": {}})
        matches = (await client.get(f"/v1/parties/{vr['party']['id']}/matches", headers=hdr)).json()["items"]
        target_card = next((m for m in matches if m["kind"] == "pair"), matches[0])
        convo = (await client.post("/v1/conversations", headers=hdr, json={"card_id": target_card["card_id"]})).json()
        convo_ids.append(convo["id"])

    # Reporter 1, 2, 3 submit distinct reports
    for idx, (tok, cid) in enumerate([(tok_r1, convo_ids[0]), (tok_r2, convo_ids[1]), (tok_r3, convo_ids[2])]):
        rep = await client.post(
            "/v1/reports",
            headers={"Authorization": f"Bearer {tok}"},
            json={"conversation_id": cid, "reason": "harassment"},
        )
        assert rep.status_code == 200
        assert rep.json()["status"] == "open"
        assert "report_id" in rep.json()
        if idx == 2:
            assert rep.json()["auto_restricted"] is True

    # Auto-restricted target user cannot send messages (403)
    blocked_send = await client.post(
        f"/v1/conversations/{convo_ids[0]}/messages",
        headers=h_t,
        json={"body": "Hello", "client_id": "restricted-1"},
    )
    assert blocked_send.status_code == 403

    # Block user by alias_ref stops messaging with 403
    convo_r1 = (await client.get(f"/v1/conversations/{convo_ids[0]}/messages", headers={"Authorization": f"Bearer {tok_r1}"})).json()["conversation"]
    blk = await client.post(
        "/v1/users/block",
        headers={"Authorization": f"Bearer {tok_r1}"},
        json={"alias_ref": convo_r1["partner_alias_ref"]},
    )
    assert blk.status_code == 200
    assert blk.json()["blocked"] is True

    r1_send = await client.post(
        f"/v1/conversations/{convo_ids[0]}/messages",
        headers={"Authorization": f"Bearer {tok_r1}"},
        json={"body": "Hi after block", "client_id": "after-blk"},
    )
    assert r1_send.status_code == 403
