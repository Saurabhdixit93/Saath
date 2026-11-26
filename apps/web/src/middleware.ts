import createMiddleware from "next-intl/middleware";
import { NextRequest } from "next/server";
import { routing } from "./i18n/routing";
import { buildCspHeader, generateCspNonce } from "./lib/csp";

const intlMiddleware = createMiddleware(routing);

export default function middleware(request: NextRequest) {
  const nonce = generateCspNonce();
  const isDev = process.env.NODE_ENV !== "production";
  const csp = buildCspHeader({
    nonce,
    apiUrl: process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000",
    wsUrl: process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:8000/v1/ws",
    appUrl: process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000",
    posthogUrl: process.env.NEXT_PUBLIC_POSTHOG_HOST,
    isDev,
  });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);

  const nextReq = new NextRequest(request, {
    headers: requestHeaders,
  });

  const response = intlMiddleware(nextReq);
  response.headers.set("Content-Security-Policy", csp);

  if (!response.headers.has("location")) {
    const existingOverrides = (response.headers.get("x-middleware-override-headers") ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const mergedOverrides = Array.from(
      new Set([...existingOverrides, "x-nonce", "content-security-policy"])
    );
    response.headers.set("x-middleware-override-headers", mergedOverrides.join(","));
    response.headers.set("x-middleware-request-x-nonce", nonce);
    response.headers.set("x-middleware-request-content-security-policy", csp);
  }

  return response;
}

export const config = {
  matcher: [
    "/((?!api|_next|_vercel|sw\\.js|manifest\\.webmanifest|icons/.*|.*\\..*).*)",
  ],
};
