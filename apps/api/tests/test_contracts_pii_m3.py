from __future__ import annotations

from typing import Any

from httpx import AsyncClient

from saath_api.providers.messaging import FakeMessagingProvider

FORBIDDEN_PII_KEYS = {
    "name",
    "full_name",
    "passenger_name",
    "pax_name",
    "age",
    "dob",
    "gender",
    "gender_self",
    "gender_band",
    "phone",
    "phone_enc",
    "phone_bidx",
    "email",
    "pnr",
    "raw_pnr",
    "pnr_hash",
    "seat_no",
    "berth_no",
}


def _assert_no_pii(
    payload: Any,
    *,
    forbidden_values: list[str],
    allow_coach_map_seat_no: bool = False,
    path: str = "$",
) -> None:
    if payload is None:
        return
    if isinstance(payload, str):
        low = payload.lower()
        for val in forbidden_values:
            assert val.lower() not in low, f"PII leak {val!r} at {path}: {payload!r}"
        return
    if isinstance(payload, list):
        for idx, item in enumerate(payload):
            _assert_no_pii(
                item,
                forbidden_values=forbidden_values,
                allow_coach_map_seat_no=allow_coach_map_seat_no,
                path=f"{path}[{idx}]",
            )
        return
    if isinstance(payload, dict):
        is_layout_cell = (
            allow_coach_map_seat_no
            and ".seats[" in path
            and path.endswith("]")
            and "seat_type" in payload
        )
        for key, value in payload.items():
            norm = key.lower()
            if norm in FORBIDDEN_PII_KEYS and not (
                is_layout_cell and norm == "seat_no"
            ):
                raise AssertionError(
                    f"Forbidden PII key {key!r} exposed at {path}.{key}"
                )
            _assert_no_pii(
                value,
                forbidden_values=forbidden_values,
                allow_coach_map_seat_no=allow_coach_map_seat_no,
                path=f"{path}.{key}",
            )


async def _otp_login(
    client: AsyncClient,
    fake_messaging: FakeMessagingProvider,
    phone: str,
    *,
    alias: str,
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
    token = str(verify.json()["access"])
    await client.patch(
        "/v1/me",
        headers={"Authorization": f"Bearer {token}"},
        json={"display_alias": alias, "gender_self": "female"},
    )
    return token, str(verify.json()["user"]["id"])


async def test_m3_endpoints_suppress_co_passenger_pii(
    client: AsyncClient,
    fake_messaging: FakeMessagingProvider,
) -> None:
    tok_a, _ = await _otp_login(client, fake_messaging, "9876543301", alias="SecretAsha99")
    tok_b, _ = await _otp_login(client, fake_messaging, "9876543302", alias="SecretRamesh88")
    h_a = {"Authorization": f"Bearer {tok_a}"}
    h_b = {"Authorization": f"Bearer {tok_b}"}

    v_a = (
        await client.post(
            "/v1/journeys/verify",
            headers=h_a,
            json={"mode": "train", "pnr": "4111111111"},
        )
    ).json()
    v_b = (
        await client.post(
            "/v1/journeys/verify",
            headers=h_b,
            json={"mode": "train", "pnr": "4222222222"},
        )
    ).json()

    await client.put(
        f"/v1/parties/{v_b['party']['id']}/goal",
        headers=h_b,
        json={
            "goal_type": "open_to_help",
            "movers": [v_b["seat_holders"][0]["id"]],
            "constraints": {},
        },
    )
    await client.put(
        f"/v1/parties/{v_a['party']['id']}/goal",
        headers=h_a,
        json={
            "goal_type": "lower",
            "movers": [v_a["seat_holders"][0]["id"]],
            "constraints": {},
        },
    )

    matches_res = await client.get(f"/v1/parties/{v_a['party']['id']}/matches", headers=h_a)
    assert matches_res.status_code == 200
    matches_body = matches_res.json()
    assert len(matches_body["items"]) >= 1
    _assert_no_pii(
        matches_body,
        forbidden_values=["SecretRamesh88", "9876543302", "4222222222"],
    )

    coach_map_res = await client.get(
        f"/v1/journeys/{v_a['journey']['id']}/coach-map?coach=B3",
        headers=h_a,
    )
    assert coach_map_res.status_code == 200
    _assert_no_pii(
        coach_map_res.json(),
        forbidden_values=["SecretRamesh88", "9876543302", "4222222222"],
        allow_coach_map_seat_no=True,
    )

    card_id = matches_body["items"][0]["card_id"]
    swap_res = await client.post("/v1/swaps", headers=h_a, json={"card_id": card_id})
    assert swap_res.status_code == 201
    swap_id = swap_res.json()["id"]

    pre_confirm_detail = await client.get(f"/v1/swaps/{swap_id}", headers=h_b)
    assert pre_confirm_detail.status_code == 200
    _assert_no_pii(
        pre_confirm_detail.json(),
        forbidden_values=["SecretAsha99", "9876543301", "4111111111", "B3-11"],
    )

    # Confirm swap and check public verify has zero PII
    v0 = swap_res.json()["version"]
    a1 = await client.post(f"/v1/swaps/{swap_id}/accept", headers=h_a, json={"version": v0})
    assert a1.status_code == 200
    a2 = await client.post(
        f"/v1/swaps/{swap_id}/accept",
        headers=h_b,
        json={"version": a1.json()["version"]},
    )
    assert a2.status_code == 200
    card_json = await client.get(f"/v1/swaps/{swap_id}/card?format=json", headers=h_a)
    assert card_json.status_code == 200
    pub_code = card_json.json()["public_code"]

    pub_res = await client.get(f"/v1/public/swap-cards/{pub_code}")
    assert pub_res.status_code == 200
    _assert_no_pii(
        pub_res.json(),
        forbidden_values=[
            "SecretAsha99",
            "SecretRamesh88",
            "9876543301",
            "9876543302",
            "4111111111",
            "4222222222",
        ],
    )
