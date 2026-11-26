export interface BuildCspOptions {
  nonce: string;
  apiUrl?: string;
  wsUrl?: string;
  appUrl?: string;
  posthogUrl?: string;
  isDev: boolean;
}

export function generateCspNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export function toOrigin(rawUrl: string | undefined | null): string | null {
  const trimmed = rawUrl?.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return new URL(trimmed).origin;
  } catch {
    return null;
  }
}

export function buildCspHeader(opts: BuildCspOptions): string {
  const apiOrigin = toOrigin(opts.apiUrl);
  const wsOrigin = toOrigin(opts.wsUrl);
  const posthogOrigin = toOrigin(opts.posthogUrl);
  const appUrl = (opts.appUrl ?? "").trim();

  const scriptSrc = [
    "'self'",
    `'nonce-${opts.nonce}'`,
    "'wasm-unsafe-eval'",
    ...(opts.isDev ? ["'unsafe-eval'"] : []),
    "https://challenges.cloudflare.com",
  ].join(" ");

  const connectSrc = [
    "'self'",
    ...(apiOrigin ? [apiOrigin] : []),
    ...(wsOrigin ? [wsOrigin] : []),
    "https://challenges.cloudflare.com",
    "https://fastly.jsdelivr.net",
    ...(posthogOrigin ? [posthogOrigin] : []),
  ].join(" ");

  const imgSrc = ["'self'", "data:", "blob:", ...(apiOrigin ? [apiOrigin] : [])].join(" ");

  const directives = [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src ${imgSrc}`,
    "font-src 'self' data:",
    `connect-src ${connectSrc}`,
    "frame-src 'self' https://challenges.cloudflare.com",
    "worker-src 'self' blob:",
    "media-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];

  if (!opts.isDev && appUrl.startsWith("https://")) {
    directives.push("upgrade-insecure-requests");
  }

  return directives.join("; ");
}
