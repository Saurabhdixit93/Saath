# Saath Production Launch Checklist

This checklist covers every regulatory, messaging, cryptographic, infrastructure, backup, and observability step required before flipping `ENV=production`.

---

## 1. TRAI DLT Registration (MSG91 SMS)

Indian telecom regulations (TRAI TCCCPR) block unregistered commercial/transactional SMS at the operator scrubbing layer. Complete before enabling `SMS_MODE=msg91`:
1. Register Saath's Indian legal entity as a **Principal Entity (PE)** on a TRAI DLT portal (e.g., Airtel, Jio, Vodafone Idea, BSNL, or Tata).
2. Register and get approval for Sender ID / Header **`SAATHI`** (`MSG91_SENDER_ID=SAATHI`).
3. Register and link exact **Content Templates** in MSG91 with approved DLT Template IDs:
   - **OTP Template (`MSG91_DLT_TE_ID_OTP`):** Used by `/api/v5/otp` for login/verification codes.
   - **Transactional Swap Alert Template (`MSG91_DLT_TE_ID_NOTIFY`):** Used by `/api/v5/flow/` for match/swap/chart alerts.
4. Set `MSG91_AUTH_KEY`, `MSG91_SENDER_ID=SAATHI`, `MSG91_DLT_TE_ID_OTP`, `MSG91_DLT_TE_ID_NOTIFY`, and `SMS_MODE=msg91`.
5. Run a live DLT scrubbing test across Jio, Airtel, and Vi numbers in both `en` and `hi` before launch.

---

## 2. Meta WhatsApp Cloud API & Bilingual Templates

1. Complete **Meta Business Verification** and link the production WhatsApp Business Account (WABA) phone number (`WHATSAPP_PHONE_NUMBER_ID`).
2. Configure the webhook callback URL (`/v1/webhooks/whatsapp`) with `WHATSAPP_VERIFY_TOKEN` and `WHATSAPP_APP_SECRET` (HMAC-SHA256 signature verification).
3. Submit and confirm **Utility / Authentication** template approvals in both **`en_US`** and **`hi`** (`notifications/templates.py` & `providers/messaging.py`):
   - `saath_otp_verify`
   - `saath_match_found`
   - `saath_swap_request`
   - `saath_swap_confirmed`
   - `saath_chart_changed`
   - `saath_swap_invalidated`
   - `saath_confirm_swap`
   - `saath_message_new`
   - `saath_karma_credited`
   - `saath_karma_reversed`
   - `saath_badge_unlocked`
   - `saath_reward_redemption`
   - `saath_update`
4. Set `WHATSAPP_MODE=live`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, and `WHATSAPP_VERIFY_TOKEN`.

---

## 3. Web Push (VAPID Keys)

1. Generate a production **P-256 VAPID** keypair (never reuse dev keys):
   ```bash
   npx web-push generate-vapid-keys --json
   ```
2. Configure backend (`api` + `worker`):
   - `PUSH_MODE=vapid`
   - `VAPID_PUBLIC_KEY=<base64url public key>`
   - `VAPID_PRIVATE_KEY=<base64url private key>`
   - `VAPID_SUBJECT=mailto:grievance@<production-domain>` (must be a real non-`.example` contact address)
3. Configure frontend (`web`):
   - `NEXT_PUBLIC_VAPID_PUBLIC_KEY=<same base64url public key>`

---

## 4. Railway Production Topology & Mandatory Startup Guards

### 4.1 Services (India / Mumbai `ap-south` Region)
Provision all services inside the India region to meet DPDP & CERT-In log residency requirements:
1. **`postgres`**: Managed PostgreSQL 16 (primary + read replica `DATABASE_READ_URL`).
2. **`redis`**: Managed Redis 7 with `--appendonly yes` persistence.
3. **`api`**: FastAPI (`alembic upgrade head && uvicorn saath_api.main:app --host 0.0.0.0 --port 8000`), healthcheck `/readyz`.
4. **`worker`**: Arq background worker (`arq saath_api.worker.WorkerSettings`).
5. **`scheduler`**: Arq cron scheduler (`arq saath_api.worker.SchedulerSettings`).
6. **`web`**: Next.js 15 passenger PWA (`:3000`) behind Cloudflare WAF/CDN with `NEXT_PUBLIC_APP_URL=https://...` so CSP includes `upgrade-insecure-requests`.
7. **`admin`**: Next.js 15 internal Ops Portal (`:3001`) on a restricted subdomain (`ADMIN_URL`) with Google Workspace SSO (`NEXT_PUBLIC_ADMIN_SSO_ENABLED=true`, `noindex, nofollow`).

### 4.2 Production Environment Variables & Startup Validation (`core/config.py`)
`apps/api/src/saath_api/core/config.py` **refuses to boot** when `ENV=production` if any dev secret or fake/sandbox mode remains set. Verify all of the following:

- **Core & Network:** `ENV=production`, `APP_URL`, `API_BASE_URL`, `ADMIN_URL`, `CORS_ORIGINS`, `TRUSTED_PROXIES`, `LOG_LEVEL=INFO`.
- **Database & Cache:** `DATABASE_URL` (TLS required), `DATABASE_READ_URL`, `REDIS_URL` (TLS `rediss://`).
- **Cryptography (Zero Dev Defaults):**
  - `JWT_PRIVATE_KEY` & `JWT_PUBLIC_KEY` (non-empty Ed25519 PEMs)
  - `SWAP_CARD_SIGNING_PRIVATE_KEY` & `SWAP_CARD_SIGNING_PUBLIC_KEY` (non-empty Ed25519 PEMs)
  - `PNR_PEPPER` (unique >= 32-byte random secret; NOT `_DEV_PNR_PEPPER`)
  - `PHONE_AES_KEY` (unique 32-byte base64 key; NOT `_DEV_PHONE_AES_KEY`)
  - `PHONE_BLIND_INDEX_KEY` (unique 32-byte base64 key; NOT `_DEV_PHONE_BLIND_INDEX_KEY`)
  - `INVITE_TOKEN_SECRET` (unique secret; NOT `_DEV_INVITE_TOKEN_SECRET`)
- **Live Provider Modes (No `fake` / `sandbox`):**
  - `TURNSTILE_MODE=cloudflare`, `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`
  - `RAIL_PROVIDER_MODE=live`, `PROVIDER_RAIL_A_BASE_URL`, `PROVIDER_RAIL_A_API_KEY`, `PROVIDER_RAIL_B_BASE_URL`, `PROVIDER_RAIL_B_API_KEY`, `PROVIDER_RAIL_TIMEOUT_MS=3000`
  - `FLIGHT_PROVIDER_MODE=live`, `PROVIDER_FLIGHT_BASE_URL`, `PROVIDER_FLIGHT_API_KEY`
  - `WHATSAPP_MODE=live`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`
  - `SMS_MODE=msg91`, `MSG91_AUTH_KEY`, `MSG91_SENDER_ID=SAATHI`, `MSG91_DLT_TE_ID_OTP`, `MSG91_DLT_TE_ID_NOTIFY`
  - `PUSH_MODE=vapid`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`
  - `AI_MODE=anthropic`, `ANTHROPIC_API_KEY`, `ANTHROPIC_CONCIERGE_MODEL=claude-sonnet-5-5`, `ANTHROPIC_FAST_MODEL=claude-haiku-5-5`
  - `PAYMENT_PROVIDER=razorpay`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`
- **Admin SSO (Passwordless disabled in `ENV=production`):**
  - `ADMIN_SSO_CLIENT_ID`, `ADMIN_SSO_CLIENT_SECRET`, `ADMIN_SSO_ALLOWED_EMAILS`, `ADMIN_JWT_TTL_SECONDS=3600`
  - Confirm `POST /v1/admin/auth/session` rejects `{ email }` without a verified Google OIDC `id_token` / `code`, and confirm `/v1/billing/sandbox/*` is disabled.
- **Public Web Vars:**
  - `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_WS_URL` (`wss://...`), `NEXT_PUBLIC_APP_URL` (`https://...`), `NEXT_PUBLIC_TURNSTILE_MODE=cloudflare`, `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `NEXT_PUBLIC_RAZORPAY_KEY_ID`, `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `NEXT_PUBLIC_ADMIN_SSO_ENABLED=true`.

---

## 5. PostgreSQL Backups & Point-in-Time Recovery (PITR)

1. Enable continuous **WAL archiving / PITR** and encrypted daily automated snapshots on the Mumbai PostgreSQL 16 cluster (minimum 7–30 day PITR window, encrypted with provider KMS).
2. Perform and document a **pre-launch restore drill** into an isolated staging database (`RPO <= 5 min`, `RTO <= 30 min`).
3. **DPDP Erasure vs. Backup Reconciliation:** Maintain an immutable tombstones/erasure log of erased `user_id` hashes outside the main backup so that if a PITR restore is ever executed, any `DELETE /v1/me` requests completed after the snapshot timestamp are immediately re-applied before reopening traffic.

---

## 6. Observability, SLOs & Production Alerts (`SYSTEM_DESIGN.md §11`)

1. Wire telemetry environment variables:
   - `OTEL_EXPORTER_OTLP_ENDPOINT` & `OTEL_SERVICE_NAME=saath-api` (FastAPI, Redis, SQLAlchemy spans)
   - `SENTRY_DSN` (backend/worker exception tracking with PII scrubbing)
   - `POSTHOG_API_KEY` & `POSTHOG_HOST` (server-side PII-masked funnel events, gated by user `analytics` consent)
2. Configure automated PagerDuty/Slack/Ops alerts matching `SYSTEM_DESIGN.md §11`:
   - **Provider Success Rate:** Alert if any upstream rail/flight/messaging provider success rate drops **below `90%` over 5 minutes**.
   - **Verify Latency SLO:** Alert if **p95 `/v1/journeys/verify` latency exceeds `6 seconds`**.
   - **WebSocket Error Rate:** Alert if `/v1/ws` error/disconnect rate **exceeds `2%`**.
   - **Notification Outbox Lag:** Alert if `notifications_outbox` lag **exceeds `60 seconds`** or `dead_letter` count spikes.
   - **Synthetic Readiness Probe:** Poll `GET /readyz` every `30s` from Mumbai edge; alert on 2 consecutive non-200 responses.
   - **CERT-In Log Retention:** Verify `audit_log` and edge/application ICT logs remain retained for **180 days** in India.
