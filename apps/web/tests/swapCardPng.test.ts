import { describe, expect, it } from "vitest";
import type { SwapCardDTO } from "@saath/contracts";
import { renderSwapCardPngBuffer } from "../src/lib/swapCardPng";

const SAMPLE_CARD: SwapCardDTO = {
  proposal_id: "0193632e-0000-7000-8000-000000000020",
  public_code: "SW-7Q2K9M",
  signature: "ZmFrZXNpZw",
  public_key: "-----BEGIN PUBLIC KEY-----\nTEST\n-----END PUBLIC KEY-----",
  alg: "Ed25519",
  service: "IR 12951",
  date: "2026-12-01",
  mode: "train",
  revoked: false,
  revoked_reason: null,
  confirmed_at: "2026-11-25T10:00:00Z",
  qr_url: "http://localhost:3000/v/SW-7Q2K9M",
  tte_note: "Subject to TTE approval",
  participants: [
    {
      alias: "Passenger B3-UB #111",
      from_seat: "B3-11 UB",
      to_seat: "B3-20 LB",
      gives_seat: "B3-11 UB",
      gets_seat: "B3-20 LB",
      decided_at: "2026-11-25T10:00:00Z",
    },
    {
      alias: "Passenger B3-LB #222",
      from_seat: "B3-20 LB",
      to_seat: "B3-11 UB",
      gives_seat: "B3-20 LB",
      gets_seat: "B3-11 UB",
      decided_at: "2026-11-25T10:00:00Z",
    },
  ],
};

describe("renderSwapCardPngBuffer", () => {
  it("generates a valid PNG buffer with \\x89PNG header in en and hi locales", async () => {
    const pngEn = await renderSwapCardPngBuffer(SAMPLE_CARD, "en");
    expect(pngEn.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(true);
    expect(pngEn.byteLength).toBeGreaterThan(1000);

    const pngHi = await renderSwapCardPngBuffer(SAMPLE_CARD, "hi");
    expect(pngHi.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(true);
    expect(pngHi.byteLength).toBeGreaterThan(1000);
  }, 15_000);
});
