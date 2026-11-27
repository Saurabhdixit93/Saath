<p align="center">
  <img src="https://img.shields.io/badge/status-active_development-blue" alt="Status">
  <img src="https://img.shields.io/badge/license-proprietary-red" alt="License">
  <img src="https://img.shields.io/badge/node-%3E%3D22-green" alt="Node">
  <img src="https://img.shields.io/badge/python-3.12-blue" alt="Python">
  <img src="https://img.shields.io/badge/DPDP%20Act-compliant-brightgreen" alt="DPDP">
</p>

# 🚆 Saath — India's Seat Swap Platform

**Saath** (_"together"_ in Hindi) is India's first privacy-first seat-swap platform for Indian Railways and domestic flights. Passengers enter their PNR or boarding pass, set a seat-swap goal, and Saath's OR-Tools matching engine finds optimal multi-way swap cycles — all without exposing personal data.

> _"Apni seat pasand nahi? Saath se swap karo."_

---

## ✨ Key Features

| Feature | Description |
|---------|-------------|
| 🔐 **Zero-Knowledge PNR Verification** | PNR and phone numbers encrypted at rest (AES-256-GCM + HMAC-SHA256 blind index). Raw PII never stored. |
| 🧩 **OR-Tools Match Engine** | Google OR-Tools constraint solver finds optimal multi-way swap cycles in under 2 seconds. |
| 💬 **Masked Chat** | End-to-end masked chat between swap parties — no phone numbers or PII exchanged until both confirm. |
| ✈️ **Railways + Flights** | Supports Indian Railways PNR and domestic flight boarding passes (BCBP barcode scanning via ZXing WASM). |
| 🛡️ **DPDP Act 2023 Compliance** | Itemized consent ledger, right to data portability (8-file ZIP export), right to erasure with 24h sweep, and immutable audit trail. |
| ⭐ **Karma Economy** | Double-entry karma ledger with anti-fraud velocity caps, tiered badges, and rewards redemption catalog. |
| 🤖 **AI Swap Concierge** | Anthropic Claude-powered concierge with streaming SSE, smart pitch drafting, and pre-accept PII/scam guardrails. |
| 🌐 **Bilingual PWA** | Progressive Web App with `next-intl` (English + Hindi), offline-first via Serwist service worker, and push notifications (VAPID). |
| 🏢 **Admin Operations Portal** | Full-featured ops dashboard: funnel analytics, provider health, moderation queue, feature flags, fraud graph, and DPDP audit log. |
| 📊 **Observability** | OpenTelemetry instrumentation (FastAPI, SQLAlchemy, Redis) with OTLP export and PostHog product analytics. |

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Docker Compose                           │
│                                                                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────────────┐   │
│  │  web      │  │  admin   │  │   api    │  │  worker +     │   │
│  │  Next.js  │  │  Next.js │  │  FastAPI │  │  scheduler    │   │
│  │  :29400   │  │  :29402  │  │  :29401  │  │  (Arq)        │   │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └───────┬───────┘   │
│       │              │             │                │           │
│       └──────────────┴─────────────┴────────────────┘           │
│                            │                                    │
│                 ┌──────────┴──────────┐                         │
│                 │                     │                         │
│           ┌─────┴─────┐        ┌─────┴─────┐                   │
│           │ PostgreSQL│        │   Redis   │                   │
│           │   16      │        │     7     │                   │
│           └───────────┘        └───────────┘                   │
└─────────────────────────────────────────────────────────────────┘
```

---

## 📁 Monorepo Structure

```
saath/
├── apps/
│   ├── api/              # FastAPI backend (Python 3.12, uv)
│   │   ├── src/saath_api/
│   │   │   ├── auth/         # EdDSA JWT, OTP, refresh token rotation
│   │   │   ├── journeys/     # PNR verification, journey management
│   │   │   ├── matching/     # OR-Tools swap cycle solver
│   │   │   ├── swaps/        # Swap lifecycle, seat locks, confirmations
│   │   │   ├── messaging/    # Masked chat, WhatsApp, SMS (MSG91)
│   │   │   ├── karma/        # Double-entry ledger, badges, rewards
│   │   │   ├── ai/           # Claude concierge, guardrails
│   │   │   ├── dpdp/         # DPDP consent, export, erasure
│   │   │   ├── admin/        # Admin API (analytics, moderation, flags)
│   │   │   ├── notifications/# VAPID push, outbox queue
│   │   │   ├── providers/    # Rail, flight, payment provider adapters
│   │   │   ├── pricing/      # Swap pricing engine
│   │   │   ├── parties/      # Group/party swap management
│   │   │   ├── realtime/     # WebSocket hub
│   │   │   └── core/         # Settings, DB, middleware, telemetry
│   │   ├── alembic/          # Database migrations
│   │   ├── config/           # YAML configs (rate limits, karma, plans)
│   │   └── tests/            # pytest + hypothesis
│   │
│   ├── web/              # Passenger-facing PWA (Next.js 15, React 19)
│   │   └── src/
│   │       ├── app/[locale]/  # i18n routes (en/hi)
│   │       ├── components/    # Chat, seat maps, swap cards
│   │       └── lib/           # AI, chat, notifications, realtime
│   │
│   └── admin/            # Operations portal (Next.js 15)
│       └── src/app/
│           ├── audit/         # DPDP immutable audit log
│           ├── moderation/    # Content moderation queue
│           ├── flags/         # Feature flag management
│           └── fraud/         # Karma collusion graph & disputes
│
├── packages/
│   ├── ui/               # Shared design system (tokens, components)
│   │   └── src/
│   │       ├── tokens.css     # Light/dark theme, WCAG 2.2 AA
│   │       └── components/    # Button, Toast, BottomSheet, etc.
│   └── contracts/        # Auto-generated typed API client (openapi-fetch)
│
├── e2e/                  # Playwright E2E tests
├── load/k6/             # k6 load tests (200 RPS, 5K WebSockets)
├── scripts/chaos/       # Chaos engineering scripts
├── docs/
│   ├── DECISIONS.md      # Architecture Decision Records (ADRs)
│   ├── LAUNCH.md         # Launch checklist
│   ├── RUNBOOK.md        # Operations runbook
│   ├── REAL_ENV_SETUP.md # External services integration guide
│   └── legal/            # Privacy policy & terms (DPDP aligned)
│
├── docker-compose.yml    # Full 7-service stack
├── CHANGELOG.md          # Version history
└── CLAUDE.md             # AI coding assistant context
```

---

## 🚀 Quick Start

### Prerequisites

- **Node.js** ≥ 22, **pnpm** ≥ 10
- **Python** 3.12, **uv** (Python package manager)
- **Docker** & **Docker Compose** (for containerized deployment)

### Local Development

```bash
# 1. Clone
git clone https://github.com/Saurabhdixit93/Saath.git
cd Saath

# 2. Copy environment file
cp .env.example .env   # edit with your keys

# 3. Start infrastructure
docker compose up -d postgres redis

# 4. API (Python)
cd apps/api
uv sync
alembic upgrade head
uvicorn saath_api.main:app --reload --port 8000

# 5. Web (Next.js) — in another terminal
cd apps/web
pnpm install
pnpm dev    # → http://localhost:3000

# 6. Admin — in another terminal
cd apps/admin
pnpm install
pnpm dev    # → http://localhost:3001
```

### Docker Compose (Production)

```bash
# Full stack — builds and runs all 7 services
docker compose up -d --build

# Default ports:
#   Web    → :29400
#   API    → :29401
#   Admin  → :29402
#   Postgres & Redis are internal-only (not exposed to host)
```

---

## 🔧 Tech Stack

| Layer | Technology |
|-------|-----------|
| **API** | Python 3.12, FastAPI, SQLAlchemy 2 (async), Alembic, Pydantic v2 |
| **Worker/Scheduler** | Arq (Redis-backed async task queue) |
| **Match Engine** | Google OR-Tools (constraint programming solver) |
| **Frontend** | Next.js 15, React 19, TanStack Query, Tailwind CSS |
| **Design System** | Custom tokens (WCAG 2.2 AA), shared `@saath/ui` package |
| **i18n** | `next-intl` — English + Hindi |
| **PWA** | Serwist (service worker), VAPID web push |
| **Auth** | EdDSA (Ed25519) JWTs, phone OTP, refresh token rotation with family reuse detection |
| **Encryption** | AES-256-GCM (phone), HMAC-SHA256 (blind index), Argon2 (OTP hashing) |
| **AI** | Anthropic Claude Sonnet/Haiku via streaming SSE |
| **Database** | PostgreSQL 16 |
| **Cache/Queue** | Redis 7 (rate limiting, OTP, Arq job queue, pub/sub) |
| **API Client** | Auto-generated typed client via OpenAPI (`openapi-fetch`) |
| **Observability** | OpenTelemetry (FastAPI, SQLAlchemy, Redis) + PostHog |
| **Testing** | pytest + hypothesis (API), Vitest (web), Playwright (E2E), k6 (load) |
| **Monorepo** | pnpm workspaces + Turborepo |
| **Containerization** | Docker, Docker Compose (7 services) |

---

## 🛡️ Security & Privacy

Saath is built with privacy as a core architectural principle, not a bolt-on:

- **Zero-knowledge PNR storage** — PNR numbers are never stored in plaintext. They are hashed with a pepper for lookup and encrypted for display.
- **Phone number privacy** — AES-256-GCM encryption at rest with HMAC-SHA256 blind index for lookups. Raw phone numbers exist only in-memory during active requests.
- **DPDP Act 2023 compliance** — Full implementation of India's Digital Personal Data Protection Act:
  - Itemized consent notice with granular per-purpose opt-in
  - Right to data portability (ZIP export with zero PII leaks)
  - Right to erasure (immediate revocation + 24h retention sweep)
  - Immutable append-only audit log
- **Masked chat** — Swap participants communicate through masked channels. No PII exchanged until mutual confirmation.
- **Swap Card signing** — Ed25519 signed swap cards prevent forgery.
- **Rate limiting** — Atomic Redis Lua-based sliding window rate limiter on all sensitive endpoints.
- **Token security** — Refresh token family reuse detection with automatic revocation of compromised token chains.

---

## 📋 API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /healthz` | Liveness probe |
| `GET /readyz` | Readiness probe (Postgres + Redis) |
| `POST /v1/auth/anonymous` | Anonymous session |
| `POST /v1/auth/otp/start` | Send OTP to phone |
| `POST /v1/auth/otp/verify` | Verify OTP + login |
| `POST /v1/auth/refresh` | Rotate refresh token |
| `GET /v1/me` | Current user profile |
| `PATCH /v1/me` | Update profile |
| `GET /v1/me/consents` | DPDP consent ledger |
| `POST /v1/me/consents` | Grant/revoke consent |
| `GET /v1/me/export` | DPDP data portability export |
| `DELETE /v1/me` | DPDP right to erasure |
| `GET /docs` | Interactive API documentation (Swagger) |

> Full API documentation available at `http://localhost:29401/docs` when running.

---

## 🧪 Testing

```bash
# API unit + integration tests
cd apps/api && uv run pytest

# Web component tests
cd apps/web && pnpm test

# E2E tests (requires running stack)
cd e2e && pnpm test

# Load tests
cd load/k6 && k6 run scenarios/
```

---

## 📚 Documentation

| Document | Description |
|----------|-------------|
| [`CHANGELOG.md`](CHANGELOG.md) | Version history and release notes |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | Architecture Decision Records |
| [`docs/LAUNCH.md`](docs/LAUNCH.md) | Pre-launch checklist |
| [`docs/RUNBOOK.md`](docs/RUNBOOK.md) | Operations runbook |
| [`docs/REAL_ENV_SETUP.md`](docs/REAL_ENV_SETUP.md) | External services setup guide |
| [`docs/legal/privacy-policy.md`](docs/legal/privacy-policy.md) | DPDP-aligned privacy policy |
| [`docs/legal/terms-of-use.md`](docs/legal/terms-of-use.md) | Terms of use |

---

## 🗺️ Roadmap

| Milestone | Focus | Status |
|-----------|-------|--------|
| **M1** | Foundation, Infra, UI Tokens & Identity/Auth | ✅ Complete |
| **M2** | Journey Verification & PNR Engine | ✅ Complete |
| **M3** | Match Engine & Swap Lifecycle | ✅ Complete |
| **M4** | Masked Chat & Notifications | ✅ Complete |
| **M5** | Growth, Karma, AI Concierge & Admin | ✅ Complete |
| **M6** | DPDP Compliance, Admin UI & Production Hardening | ✅ Complete |

---

## 🤝 Contributing

This is currently a private project. If you're interested in contributing, please reach out to the maintainer.

---

## 📄 License

Proprietary — All rights reserved. See [Terms of Use](docs/legal/terms-of-use.md).

---

<p align="center">
  Built with ❤️ for Indian travellers 🇮🇳
</p>
