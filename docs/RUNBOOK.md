# Saath Incident, Breach Notification & Operations Runbook

This runbook governs security incident response, statutory **CERT-In (6-hour)** and **DPDP Act / DPBI (72-hour)** breach notifications, cryptographic key rotation, and infrastructure outage recovery for Saath.

---

## 1. Security Incident & Data Breach Notification Runbook

### 1.1 Statutory Deadlines (India)

| Regulator / Recipient | Legal Authority | Mandatory Window | Required Content & Action |
|---|---|---|---|
| **CERT-In** (`incident@cert-in.org.in`) | CERT-In Directions dated 28 April 2022 (under IT Act §70B) | **Within 6 hours** of noticing or being notified of a reportable cyber incident | Incident type, affected systems, UTC/IST timestamps, indicators of compromise, containment actions taken. Maintain **180 days** of ICT/security logs within India. |
| **Data Protection Board of India (DPBI)** & **Affected Data Principals** | DPDP Act, 2023 §8(6) & DPDP Rules, 2025 | **Intimation without delay** + **full notification within 72 hours** of becoming aware of a personal data breach | Nature, extent, timing, and duration of breach; categories of personal data affected (e.g., encrypted phones, hashes, metadata); likely impact; remedial/mitigation measures taken; and **Grievance Officer** contact details (`grievance@saath.example`). |

### 1.2 Severity Triage Matrix

| Severity | Criteria | First Response SLA | Escalation |
|---|---|---|---|
| **SEV-1 (Critical / PII or Key Compromise)** | Suspected unauthorised access to PostgreSQL (`users`, `phone_enc`, `bookings`), Redis, Ed25519 private keys, AES/HMAC keys, or confirmed data exfiltration / auth bypass. | **Immediate (< 15 min)** | Incident Commander + Security Lead + DPO / Grievance Officer + Legal Counsel. Start 6h CERT-In & 72h DPDP clocks. |
| **SEV-2 (Major Outage)** | Complete API `/readyz` failure, PostgreSQL primary down, Redis down, Arq scheduler stalled > 15 min, or all rail/OTP providers failing. | **< 15 min** | On-call Backend SRE + Ops Lead. |
| **SEV-3 (Degraded / Single Provider)** | Single rail provider circuit breaker open (`cb:rail:*:open`), elevated WhatsApp/MSG91 dead-letter queue, or partial WS degradation (clients on SSE/polling fallback). | **< 30 min** | On-call SRE; inspect `/v1/admin/providers/health`. |

### 1.3 Containment & Forensics Checklist (SEV-1)

1. **Declare Incident & Freeze Evidence:**
   - Start incident log with exact IST & UTC timestamps.
   - **Preserve `audit_log`** and Railway/Cloudflare/Postgres logs immediately (export immutable snapshot to restricted incident bucket; never truncate `audit_log`).
2. **Enable User Protection / Maintenance Mode (if active exploitation):**
   - Toggle `maintenance_banner` feature flag via `PATCH /v1/admin/flags/maintenance_banner` (`{ "value": { "enabled": true, "message": "..." } }`).
   - Tighten Cloudflare WAF / rate limits at edge.
3. **Revoke Compromised Sessions & Credentials:**
   - Rotate affected secrets per Section 2 below.
   - If user JWTs or refresh tokens are suspected compromised, execute mass revocation in `refresh_tokens` (`UPDATE refresh_tokens SET revoked_at = NOW() WHERE revoked_at IS NULL`) and rotate `JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY`.
   - If an admin account is compromised, remove email from `ADMIN_SSO_ALLOWED_EMAILS` / Workspace group and revoke admin sessions.
4. **Assess Breach Scope:**
   - Verify whether `PHONE_AES_KEY` or `PHONE_BLIND_INDEX_KEY` was exposed alongside `users.phone_enc` / `users.phone_bidx`.
   - Verify whether `PNR_PEPPER` was exposed alongside `bookings.pnr_hash`.
   - Record exact count of affected `users` rows and whether raw PII vs encrypted/hashed records were accessed.
5. **Dispatch Notifications:**
   - **T + <= 6 hours:** File initial incident report to **CERT-In**.
   - **T + <= 72 hours:** Submit DPDP breach notification to **DPBI** and notify affected Data Principals (via SMS/WhatsApp/in-app notice where contactable) with actionable guidance and Grievance Officer contact.

---

## 2. Cryptographic Key & Secret Rotation Procedures

All secrets below are defined in `apps/api/src/saath_api/core/config.py` and `.env.example`.

### 2.1 `JWT_PRIVATE_KEY` & `JWT_PUBLIC_KEY` (Ed25519 PEM — User, Anon & Admin JWTs)
- **Impact:** Signed access tokens (`JWT_ACCESS_TTL_SECONDS=900`, `JWT_ANON_TTL_SECONDS=7200`, `ADMIN_JWT_TTL_SECONDS=3600`).
- **Planned / Incident Rotation:**
  1. Generate new Ed25519 keypair:
     ```bash
     openssl genpkey -algorithm Ed25519 -out jwt_private.pem
     openssl pkey -in jwt_private.pem -pubout -out jwt_public.pem
     ```
  2. Update `JWT_PRIVATE_KEY` and `JWT_PUBLIC_KEY` in Railway environment variables across `api`, `worker`, and `scheduler`.
  3. Rolling restart services. Active access tokens signed by the old key immediately fail signature check (`401`); legitimate user clients transparently call `POST /v1/auth/refresh` (single-flight refresh in `AuthProvider` / `dpdp.ts`) to mint tokens under the new key.
  4. **Emergency compromise:** Also revoke all rows in `refresh_tokens` so every user and admin must re-authenticate via OTP / Google Workspace SSO.

### 2.2 `SWAP_CARD_SIGNING_PRIVATE_KEY` & `SWAP_CARD_SIGNING_PUBLIC_KEY` (Ed25519 PEM)
- **Impact:** Cryptographic signatures (`EdDSA`) on issued `swap_cards`.
- **Rotation:**
  1. Generate a new Ed25519 keypair and update `SWAP_CARD_SIGNING_PRIVATE_KEY` + `SWAP_CARD_SIGNING_PUBLIC_KEY` across `api` and `worker`.
  2. **If private key compromised:** Mark potentially forged/compromised active cards `revoked = true` in `swap_cards`, notify affected parties, and regenerate cards under the new keypair.

### 2.3 `PNR_PEPPER`
- **Impact:** Keyed `HMAC-SHA256(PNR_PEPPER, pnr.strip().upper())` stored in `bookings.pnr_hash`.
- **Important Constraint:** Changing `PNR_PEPPER` changes the digest for any PNR, breaking hash equality against existing `bookings.pnr_hash` rows (and duplicate claim detection for active journeys).
- **Planned Rotation:** Schedule during low-traffic maintenance after active journeys settle, or support dual-pepper lookup during a 30-day transition window before retiring the old pepper.
- **Emergency Rotation:** Generate a new >= 32-byte random secret (`openssl rand -base64 32`), update `PNR_PEPPER`, restart `api` & `worker`, and prompt active users to re-verify if needed.

### 2.4 `PHONE_AES_KEY` (32-byte Base64, AES-256-GCM with AAD `saath:phone:v1`)
- **Impact:** Encrypts `users.phone_enc` (12-byte random nonce + AES-GCM ciphertext).
- **Rotation Procedure (Transactional Re-Encryption):**
  1. Generate new 32-byte key: `openssl rand -base64 32`.
  2. Run an offline/maintenance migration script holding **both** `OLD_PHONE_AES_KEY` and `NEW_PHONE_AES_KEY`:
     - Batch-read `users(id, phone_enc)` (`FOR UPDATE`), decrypt with `OLD_PHONE_AES_KEY` (AAD `b"saath:phone:v1"`), re-encrypt with `NEW_PHONE_AES_KEY` (fresh 12-byte `os.urandom(12)` nonce, AAD `b"saath:phone:v1"`), and commit.
  3. Deploy `PHONE_AES_KEY=<NEW_PHONE_AES_KEY>` across `api`, `worker`, and `scheduler`, and zeroize `OLD_PHONE_AES_KEY`.

### 2.5 `PHONE_BLIND_INDEX_KEY` (32-byte Base64, HMAC-SHA256)
- **Impact:** Deterministic lookup index `users.phone_bidx` used during OTP login/registration.
- **Rotation Procedure:**
  1. Generate new 32-byte key: `openssl rand -base64 32`.
  2. In a maintenance transaction alongside `PHONE_AES_KEY` decryption: decrypt `users.phone_enc` to recover canonical `+91...` phone, recompute `HMAC-SHA256(NEW_PHONE_BLIND_INDEX_KEY, phone)`, and update `users.phone_bidx`.
  3. Deploy `PHONE_BLIND_INDEX_KEY` across `api`, `worker`, and `scheduler`.

### 2.6 `INVITE_TOKEN_SECRET` & External Provider Secrets
- **`INVITE_TOKEN_SECRET`:** Rotate in Railway env and restart `api`/`worker`. Existing signed invite links issued with the old secret become invalid (`48h`/`72h` max TTL; users simply generate a new invite).
- **Provider & SSO Secrets:** Rotate immediately in the vendor console and Railway env, then redeploy `api` & `worker`:
  - `ADMIN_SSO_CLIENT_SECRET` (Google Workspace OAuth)
  - `TURNSTILE_SECRET_KEY` (Cloudflare)
  - `WHATSAPP_APP_SECRET`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_VERIFY_TOKEN` (Meta)
  - `MSG91_AUTH_KEY` (MSG91)
  - `ANTHROPIC_API_KEY` (Anthropic)
  - `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` (Razorpay)
  - `VAPID_PRIVATE_KEY` / `VAPID_PUBLIC_KEY` / `NEXT_PUBLIC_VAPID_PUBLIC_KEY` (requires clients to re-subscribe Web Push)

---

## 3. Infrastructure & Provider Outage Procedures

### 3.1 PostgreSQL 16 Outage
1. Check `GET /readyz` on `api` and Railway Postgres service metrics (CPU, disk, max connections, long-running locks).
2. If primary is read-degraded: verify `DATABASE_READ_URL` replica serves read-only SEO/aggregate endpoints (`/v1/pnr-status/*`, `/v1/trains/*`).
3. If data corruption or accidental loss occurred: restore from Railway PostgreSQL WAL / Point-in-Time Recovery (**PITR**) to a verified recovery timestamp, then re-apply any `DELETE /v1/me` erasure events recorded since the recovery point (see `docs/LAUNCH.md §5`).

### 3.2 Redis 7 Outage
1. Check `/readyz` and Redis AOF (`--appendonly yes`) health in Railway.
2. **Expected Graceful Degradation:**
   - `RealtimeProvider` in `apps/web` automatically falls back from WebSocket (`/v1/ws`) -> SSE (`/v1/events/stream`) -> 15-second HTTP polling.
   - Circuit breaker state (`cb:rail:*`) and rate-limit counters reset cleanly when Redis recovers; active 60s OTP hashes in Redis expire and users simply request a new OTP.
3. Restart Redis with AOF enabled and confirm `/readyz` returns `200 OK`.

### 3.3 Rail, Flight, Messaging, Push & AI Provider Outages
1. Query `GET /v1/admin/providers/health` (or view the Admin Portal dashboard at `:3001`):
   - Inspect Redis rail circuit breakers `cb:rail:{provider_name}:open` / `cb:rail:{provider_name}:failures`.
   - Inspect in-process breakers for `flight_schedule`, `whatsapp_cloud`, `msg91_sms`, `vapid_webpush`, `anthropic_llm`, `cloudflare_turnstile`, `razorpay`.
   - Check `notifications_outbox` counts (`queued`, `sent`, `dead_letter`, `lag_seconds`).
2. **Failover Behaviour:**
   - `ProviderRouter` automatically fails over `Provider A -> Provider B -> Provider C (SMS/Declared fallback)` when `PROVIDER_RAIL_TIMEOUT_MS=3000` or upstream errors trip the circuit breaker.
   - If WhatsApp (`whatsapp_cloud`) fails, notifications fall back to Web Push / MSG91 SMS according to user preferences.
   - `notifications_outbox` retries failed deliveries up to **5 attempts** with backoff before marking `dead_letter`. Once an upstream provider recovers, replay `dead_letter` rows from the outbox or trigger notification re-dispatch after verifying provider health.
   - If `anthropic_llm` degrades, Swap Concierge gracefully surfaces `errorDisabled` and guides users to manual `Set swap goal`.

### 3.4 Arq Worker & Scheduler Outage (`worker` / `scheduler`)
1. Confirm both processes are running in Railway:
   - `worker`: `arq saath_api.worker.WorkerSettings`
   - `scheduler`: `arq saath_api.worker.SchedulerSettings`
2. Verify periodic cron jobs resume cleanly:
   - **Chart watcher:** every `5m`
   - **Outbox dispatcher:** every `30s`
   - **Swap proposal expiry:** every `1m`
   - **Post-journey confirmation prompt:** every `5m`
   - **Nightly DPDP retention purge & 24h erasure sweep:** nightly cron (`bookings.purge_after < now()`, expired `seat_invites` > 72h, expired `parties`, old reports/messages, and `users.erasure_requested_at <= now() - 24h`).
3. If `scheduler` was down across a nightly window, manually trigger or verify the next run clears any backlog in `bookings.purge_after` and pending 24h erasures without errors.
