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

## [0.5.0] — Milestone M5 (Growth, Karma Economy, AI Concierge & Admin API)
- Implemented Alembic `0005_m5_schema` with `seat_invites`, `karma_ledger`, `badges`, `feature_flags`, `rewards`, `ai_usage_logs`, and user consent/erasure columns.
- Built Invite-the-Seat growth mechanism (`/j/[token]`) with WhatsApp share cards and public SEO pages (`/pnr-status`, `/train/[no]/coach-position`, `/train/[no]/chart-time`, `/train/[no]/live`, `/flights/seat-map`, `/blog`).
- Implemented double-entry Karma ledger, anti-fraud velocity capping, tiered badges, and rewards redemption catalog.
- Integrated Anthropic Claude Sonnet/Haiku AI Swap Concierge with streaming SSE, smart pitch drafting, and pre-accept PII/scam guardrails.
- Added Backend Admin API (`/v1/admin/`) covering funnel analytics, provider health, moderation actions, fraud graph, and audit log.
- Delivered k6 load test suites (200 RPS verification, 5,000 concurrent WebSockets, match recompute storm) and chaos engineering verification scripts.

## [0.6.0] — Milestone M6 (DPDP Act Compliance, Admin UI & Final Production Hardening)
- Implemented end-to-end DPDP Act 2023 compliance:
  - Itemized consent notice and ledger API (`GET /v1/me/consents`, `POST /v1/me/consents`).
  - Right to data portability export (`GET /v1/me/export`) generating standard 8-file ZIP archive with zero PII leaks (`phone_enc`, `phone_bidx`, `raw_pnr`, `pnr_hash` strictly suppressed).
  - Right to erasure (`DELETE /v1/me`) with immediate token revocation, pending swap cancellation, seat lock releases, and 24-hour retention sweep.
  - Nightly ARQ retention purge job (`nightly_retention_purge_tick`) cleaning expired invites, stale bookings, and executing 24-hour erasure sweeps.
- Developed full-featured Admin Portal UI (`apps/admin` on port 3001):
  - Overview dashboard with route funnel conversion and provider/outbox health metrics.
  - Moderation queue with report filtering and Dismiss, Hide, Restrict, and Ban actions.
  - Feature flag management with interactive toggle switches and real-time PATCH API integration.
  - Fraud collusion graph visualizing circular karma pairs and dispute resolution with force-complete overrides.
  - Immutable DPDP audit log viewer with live action filtering.
- Re-exported typed DPDP contracts in `packages/contracts`.
- Verified complete Python AST compilation across all modules and tests (`python3 -m compileall`).
- Containerized full production stack in `docker-compose.yml` (`postgres:16`, `redis:7`, `api`, `worker`, `scheduler`, `web:3000`, `admin:3001`).


## [Unreleased] — Docker build fixes
- Fixed `apps/admin` production build: removed `any` usages (`adminFetch<T = unknown>`), surfaced the overview `loading` state via `aria-busy`, and added the missing `@types/node` devDependency.
- Fixed `apps/web` production build: swap-card PNG fonts now resolve from the app root at runtime so webpack no longer tries to bundle `.woff` files.
- `docker-compose.yml` now passes `NEXT_PUBLIC_*` as web/admin build args so browser bundles use the deploy's URLs instead of `localhost`.
- Added `scripts/vm-env.sh` to generate a single-VM `.env` with fresh JWT/swap-card/VAPID keys, phone/PNR secrets, admin allowlist, and the correct Turnstile test secret.
- Fixed `alembic upgrade head` failing on a fresh database: revision `0002_journeys_parties_goals_pricing` (35 chars) overflowed `alembic_version.version_num VARCHAR(32)`; renamed to `0002_journeys_parties_goals` and added `tests/test_alembic_revisions.py` to guard id length and a single head.
