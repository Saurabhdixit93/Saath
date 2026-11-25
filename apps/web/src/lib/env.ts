import { z } from "zod";

const envSchema = z.object({
  NEXT_PUBLIC_API_URL: z.string().url().default("http://localhost:8000"),
  NEXT_PUBLIC_WS_URL: z.string().default("ws://localhost:8000/v1/ws"),
  NEXT_PUBLIC_TURNSTILE_MODE: z.enum(["fake", "cloudflare"]).default("fake"),
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: z.string().default(""),
  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
});

export const publicEnv = envSchema.parse({
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000",
  NEXT_PUBLIC_WS_URL: process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:8000/v1/ws",
  NEXT_PUBLIC_TURNSTILE_MODE:
    process.env.NEXT_PUBLIC_TURNSTILE_MODE === "cloudflare" ? "cloudflare" : "fake",
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || "",
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000",
});
