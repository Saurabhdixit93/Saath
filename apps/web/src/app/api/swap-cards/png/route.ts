import { NextResponse } from "next/server";
import { z } from "zod";
import type { SwapCardDTO } from "@saath/contracts";
import { renderSwapCardPngBuffer } from "@/lib/swapCardPng";

export const runtime = "nodejs";

const RequestSchema = z.object({
  locale: z.enum(["en", "hi"]).default("en"),
  card: z.object({
    proposal_id: z.string(),
    public_code: z.string().regex(/^SW-[A-Z0-9]{4,16}$/),
    signature: z.string(),
    public_key: z.string(),
    alg: z.literal("Ed25519").optional(),
    service: z.string(),
    date: z.string(),
    mode: z.enum(["train", "flight", "bus"]),
    revoked: z.boolean(),
    revoked_reason: z.string().nullable().optional(),
    confirmed_at: z.string(),
    qr_url: z.string(),
    tte_note: z.string().optional(),
    participants: z.array(
      z.object({
        alias: z.string(),
        from_seat: z.string(),
        to_seat: z.string(),
        gives_seat: z.string(),
        gets_seat: z.string(),
        decided_at: z.string().nullable().optional(),
      })
    ),
  }),
});

export async function POST(req: Request) {
  try {
    const raw: unknown = await req.json();
    const parsed = RequestSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid Swap Card payload" },
        { status: 422 }
      );
    }

    const png = await renderSwapCardPngBuffer(
      parsed.data.card as SwapCardDTO,
      parsed.data.locale
    );
    return new NextResponse(new Uint8Array(png), {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        "Content-Disposition": `attachment; filename="saath-swap-${parsed.data.card.public_code}.png"`,
      },
    });
  } catch {
    return NextResponse.json(
      { error: "Failed to render Swap Card PNG" },
      { status: 500 }
    );
  }
}
