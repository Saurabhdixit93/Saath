# CLAUDE.md — Saath Engineering Rules (Prompt 0)

## Stack
- `apps/web`: Next.js 15 App Router, React 19, TypeScript (`strict`), Tailwind CSS v4 + `@saath/ui` CSS variables (`DESIGN.md §3`), `next-intl` (`en`/`hi`), Serwist PWA, TanStack Query, Zod, `@saath/contracts` (`openapi-fetch`).
- `apps/admin`: Separate Next.js 15 + React 19 + TypeScript (`strict`) admin portal on `:3001`, SSO-guarded, zero test/demo routes.
- `apps/api`: Python 3.12 (`uv`), FastAPI + Uvicorn, Pydantic v2, SQLAlchemy 2 async + `asyncpg` + Alembic, Redis (`redis-py` asyncio), `Arq`, Google OR-Tools, `httpx`, `structlog`, OpenTelemetry.
- `packages/contracts`: FastAPI-exported OpenAPI JSON (`openapi.json`) → `openapi-typescript` + `openapi-fetch`.
- `packages/ui`: Shared Saath design tokens (`tokens.css`) and WCAG 2.2 AA components.

## Non-Negotiable Rules
1. **Actor ALWAYS derived from auth token**: Never accept `user_id`, `sender_id`, or `passenger_id` in request bodies; use `current_actor()` and `authorize(actor, action, resource)`.
2. **Pre-confirm PII suppression**: Never return another passenger's `name`, `age`, `gender`, or exact `seat_no` before mutual swap confirmation; add contract tests.
3. **Zero raw PNR / passenger names in DB**: Store only `HMAC-SHA256(PNR_PEPPER, pnr)` (`pnr_hash`), `age_band`, and `gender_band`. Store phones only as AES-256-GCM (`phone_enc`) + HMAC-SHA256 blind index (`phone_bidx`).
4. **Adapter interfaces**: Every external provider goes behind a Protocol interface with timeout, retry (1), circuit breaker, and fake implementation for tests. `ENV=production` forbids fake adapters.
5. **Transactional outbox**: Domain state changes write a `notifications_outbox` row in the same database transaction.
6. **YAML-driven business config**: Karma points, chart timing rules, rate limits, and pricing plans live in YAML under `apps/api/config/`, never hardcoded in Python.
7. **Accessibility & i18n**: Mobile-first, WCAG 2.2 AA (`≥ 48px` tap targets, colour + icon/pattern seat legends), every string i18n'd (`en`/`hi`), empty/loading/error states on every screen.
8. **No production test/demo routes**: Never expose `/test-login`, `/admin/reset-demo`, or `/v1/billing/sandbox/*` when `ENV=production`.
9. **Discipline**: Keep changes scoped, end with tests passing + lint/typecheck clean, update `CHANGELOG.md` and `docs/DECISIONS.md` for architectural choices.
