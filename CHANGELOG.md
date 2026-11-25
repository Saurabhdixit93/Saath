# Changelog

## [0.1.0] — Milestone M1 (Foundation, Infra, UI Tokens & Identity/Auth)
- Initialized `pnpm` + Turborepo monorepo (`apps/api`, `apps/web`, `apps/admin`, `packages/ui`, `packages/contracts`).
- Added `docker-compose.yml` (`postgres:16`, `redis:7`, `api`, `worker`, `scheduler`, `web`, `admin`), Dockerfiles, `Makefile`, `.env.example`, `CLAUDE.md`, and GitHub Actions CI workflow.
- Added YAML configuration files in `apps/api/config/` (`rate_limits.yaml`, `chart_rules.yaml`, `karma.yaml`, `plans.yaml`).
- Implemented FastAPI app factory, `/healthz`, `/readyz` (Postgres + Redis readiness), RFC 9457 `application/problem+json` exception handlers, `structlog` JSON logging, OpenTelemetry setup, and Arq worker shell.
- Implemented Alembic `0001_identity_and_audit` (`pgcrypto`, `transport_mode`, `users`, `devices`, `refresh_tokens`, `consents`, `audit_log`).
- Implemented Identity & Auth (`/v1/auth/anonymous`, `/v1/auth/otp/start`, `/v1/auth/otp/verify`, `/v1/auth/refresh`, `/v1/auth/logout`, `/v1/me`) with EdDSA (Ed25519) JWTs, AES-256-GCM + HMAC-SHA256 phone privacy, Argon2 Redis OTPs, rotating 30d refresh tokens with family reuse revocation, `TurnstileVerifier`, and `MessagingProvider`.
- Implemented offline OpenAPI export and `packages/contracts` typed `openapi-fetch` client with single-flight 401 refresh.
- Implemented `packages/ui` Saath design tokens (light `#FAF7F2` / dark `#0F1115` with `data-theme` and WCAG 2.2 AA ink overrides) and accessible components (`SaathLogo`, `Button`, `Toast`, `BottomSheet`, `LanguageSwitcher`, `ThemeToggle`, `EmptyState`, `SeatLegendBadge`).
- Implemented `apps/web` (`:3000`) Next.js 15 PWA (`next-intl` `en`/`hi`, Serwist SW, `AuthProvider`, `PhoneOtpSheet`, `/profile`, Home shell) and `apps/admin` (`:3001`) SSO-ready ops shell.

## [0.1.1] — Milestone M1 Iteration 2 (Security, A11y & Concurrency Hardening)
- Fixed `createSaathClient` (`packages/contracts`) to snapshot unconsumed `Request` clones in `onRequest` so 401 refresh + retry works on `PATCH`/`POST` mutations with bodies.
- Fixed `/v1/auth/otp/verify` and `AuthProvider` to clear/ignore expired anonymous JWTs (`>2h`), coalesce `refreshTokens()`, support `cloudflare` Turnstile acquisition/resend resets, and localize logout toast.
- Hardened `Settings` (`ENV=production` checks for `flight_provider_mode` and dev AES/HMAC/pepper/invite secrets + 32-byte base64 startup validation), `_client_ip` trusted-proxy `X-Forwarded-For` parsing, ASCII-only phone/OTP matching, monotonic `uuid7()`, unhandled 500 logging, and OpenAPI `application/problem+json` schema refs.
- Made `SlidingWindowRateLimiter` atomic via Redis Lua script (with `fakeredis` lock fallback), guarded `verify_otp` with a per-`request_id` lock + `ON CONFLICT (phone_bidx)` user upsert + `pttl > 0` updates, and set `otp:cd` only after `MessagingProvider.send_otp` succeeds (`503` on `ProviderError`).
- Added dark-mode WCAG 2.2 AA `--danger-text` token, fixed `SeatLegendBadge` foreground ink, stabilized `BottomSheet`/`Toast` effect hooks, fixed `+91` paste truncation and `PNR` keyword priority, added `/profile` loading/error states, and added `.dockerignore` + `NEXT_PUBLIC_*` Dockerfile build args.
