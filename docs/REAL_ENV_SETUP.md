# Saath — Production & Realistic Environment Setup Guide

This guide details how to transition Saath from development/sandbox defaults to **100% real live external services** across PNR verification, bot protection, Web Push notifications, WhatsApp messaging, SMS, AI Concierge, and payment processing.

---

## 1. Real Cryptographic Keys (Already Configured)

Real production-grade cryptographic keys have been generated and configured in `.env`:

| Key Name | Algorithm | Purpose | Status in `.env` |
| :--- | :--- | :--- | :--- |
| `JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY` | **Ed25519 (EdDSA)** | High-throughput, tamper-proof user and admin JWT access tokens | **Configured** |
| `SWAP_CARD_SIGNING_PRIVATE_KEY` / `SWAP_CARD_SIGNING_PUBLIC_KEY` | **Ed25519 (EdDSA)** | Cryptographic signature on digital Swap Cards (`/v/[code]`) | **Configured** |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | **NIST P-256 (secp256r1)** | Browser Web Push notification delivery | **Configured** |
| `PHONE_AES_KEY` | **AES-256-GCM** | 32-byte authenticated encryption for mobile numbers | **Configured** |
| `PHONE_BLIND_INDEX_KEY` | **HMAC-SHA256** | 32-byte blind index for deduplicated phone lookup without plaintext storage | **Configured** |
| `POSTHOG_API_KEY` | **PostHog Cloud** | Product analytics, telemetry, and journey funnel metrics | **Configured** |

---

## 2. Cloudflare Turnstile (Live Bot Protection)

Cloudflare Turnstile provides seamless, CAPTCHA-less bot detection.

### Test & Staging (Already Active in `.env`):
Cloudflare provides official always-passing testing keys that execute real HTTP verification requests to `https://challenges.cloudflare.com/turnstile/v0/siteverify`:
```env
TURNSTILE_MODE=cloudflare
TURNSTILE_SITE_KEY=1x00000000000000000000AA
TURNSTILE_SECRET_KEY=1x00000000000000000000000000000000AA
NEXT_PUBLIC_TURNSTILE_MODE=cloudflare
NEXT_PUBLIC_TURNSTILE_SITE_KEY=1x00000000000000000000AA
```

### Production Setup:
1. Log in to [Cloudflare Dashboard](https://dash.cloudflare.com/).
2. Navigate to **Turnstile** > **Add Site**.
3. Name your site (e.g., `Saath Production`) and add your domains (`saath.app`, `api.saath.app`).
4. Select **Managed** or **Non-interactive** mode.
5. Copy the generated **Site Key** and **Secret Key** into `.env`:
   ```env
   TURNSTILE_MODE=cloudflare
   TURNSTILE_SITE_KEY=<your-production-site-key>
   TURNSTILE_SECRET_KEY=<your-production-secret-key>
   NEXT_PUBLIC_TURNSTILE_MODE=cloudflare
   NEXT_PUBLIC_TURNSTILE_SITE_KEY=<your-production-site-key>
   ```

---

## 3. Web Push (VAPID Notifications)

Web push notifications allow passengers to receive real-time match alerts and chat notifications directly on mobile and desktop browsers even when the app is closed.

* `.env` is already configured with real P-256 VAPID keys:
  ```env
  PUSH_MODE=vapid
  VAPID_PUBLIC_KEY=BJphb9kGc04qWrWs5yAC9scu2HrX7cIT8FlxJ1c7usv6E1WQBwmVbbWD_3L9-gCqn9AtGOINGvAqRT0UWuSEMf8
  VAPID_PRIVATE_KEY=6H-qprjMkzcEIGV1viHl0hRlZeEs27So6N2CiNIwk-E
  VAPID_SUBJECT=mailto:privacy@saath.app
  NEXT_PUBLIC_VAPID_PUBLIC_KEY=BJphb9kGc04qWrWs5yAC9scu2HrX7cIT8FlxJ1c7usv6E1WQBwmVbbWD_3L9-gCqn9AtGOINGvAqRT0UWuSEMf8
  ```

---

## 4. Razorpay Payment Gateway (₹199 Trip Pass & B2B Subscriptions)

Saath uses Razorpay for Group-Organiser Trip Pass checkouts (individual peer-to-peer swaps remain 100% free).

### Test Sandbox Setup:
1. Sign up for free at [Razorpay](https://dashboard.razorpay.com/signup).
2. Switch to **Test Mode** on the top navigation bar.
3. Go to **Settings** > **API Keys** > **Generate Key**.
4. Update `.env`:
   ```env
   PAYMENT_PROVIDER=razorpay
   RAZORPAY_KEY_ID=rzp_test_...
   RAZORPAY_KEY_SECRET=...
   NEXT_PUBLIC_RAZORPAY_KEY_ID=rzp_test_...
   RAZORPAY_WEBHOOK_SECRET=...
   ```
5. In **Settings** > **Webhooks**, add endpoint `https://<your-api-domain>/v1/pricing/webhooks/razorpay` and select events: `payment.captured`, `order.paid`.

---

## 5. Anthropic Claude AI Concierge

Saath includes an AI Swap Concierge powered by Claude 3.5 Sonnet (for polite, persuasive swap pitches) and Claude 3.5 Haiku (for instant scam and PII moderation).

### Setup:
1. Get an API key from [Anthropic Console](https://console.anthropic.com/).
2. In `.env`:
   ```env
   AI_MODE=anthropic
   ANTHROPIC_API_KEY=sk-ant-api03-...
   ANTHROPIC_CONCIERGE_MODEL=claude-3-5-sonnet-20241022
   ANTHROPIC_FAST_MODEL=claude-3-5-haiku-20241022
   ```
3. When set, `apps/api/src/saath_api/providers/llm.py` connects directly to Anthropic's streaming SSE endpoint.

---

## 6. Meta WhatsApp Cloud API

WhatsApp is the primary channel for OTPs, match notifications, and swap confirmations in India.

### Setup:
1. Go to [Meta for Developers](https://developers.facebook.com/) and create a **Business App**.
2. Add the **WhatsApp** product.
3. In **API Setup**, retrieve your **Temporary Access Token** (or create a System User Permanent Token) and **Phone Number ID**.
4. Under **App Settings** > **Basic**, copy your **App Secret**.
5. Update `.env`:
   ```env
   WHATSAPP_MODE=live
   WHATSAPP_PHONE_NUMBER_ID=...
   WHATSAPP_ACCESS_TOKEN=...
   WHATSAPP_APP_SECRET=...
   WHATSAPP_VERIFY_TOKEN=saath_wa_verify_token
   ```
6. In **WhatsApp** > **Configuration**, set Webhook URL: `https://<your-api-domain>/v1/notifications/webhooks/whatsapp` with Verify Token `saath_wa_verify_token` and subscribe to `messages`.

---

## 7. MSG91 SMS Gateway (TRAI DLT Compliance)

Fallback SMS provider when WhatsApp is opted out or unavailable.

### Setup:
1. Create an account at [MSG91](https://msg91.com/).
2. Retrieve your **Auth Key** from Dashboard > API Keys.
3. Register your Sender ID (e.g. `SAATHI`) and DLT Template IDs on the Indian DLT portal (e.g., Jio / Airtel DLT).
4. In `.env`:
   ```env
   SMS_MODE=msg91
   MSG91_AUTH_KEY=...
   MSG91_SENDER_ID=SAATHI
   MSG91_DLT_TE_ID_OTP=...
   MSG91_DLT_TE_ID_NOTIFY=...
   ```

---

## 8. Rail PNR Live Provider (Indian Railways Data)

Saath supports dual-vendor failover routing (`ProviderRouter`) with automatic circuit breaking for live train status and PNR verification.

### Option A: RapidAPI Indian Railways / IRCTC API (Instant Free Tier)
1. Sign up on [RapidAPI](https://rapidapi.com/).
2. Subscribe to **IRCTC Indian Railway** (by `trains-api`) or **Indian Railway PNR Status** (free tier includes 500 requests/month).
3. Retrieve your RapidAPI Key and set in `.env`:
   ```env
   RAIL_PROVIDER_MODE=live
   PROVIDER_RAIL_A_BASE_URL=https://irctc1.p.rapidapi.com
   PROVIDER_RAIL_A_API_KEY=<your-rapidapi-key>
   PROVIDER_RAIL_TIMEOUT_MS=4000
   ```

### Option B: Commercial B2B Aggregator (ConfirmTkt / RailYatri / Official IRCTC Partner)
If you have commercial credentials with an authorized railway data aggregator:
```env
RAIL_PROVIDER_MODE=live
PROVIDER_RAIL_A_BASE_URL=https://api.vendor-a.com/v1
PROVIDER_RAIL_A_API_KEY=<vendor-a-api-key>
PROVIDER_RAIL_B_BASE_URL=https://api.vendor-b.com/v1
PROVIDER_RAIL_B_API_KEY=<vendor-b-api-key>
PROVIDER_RAIL_TIMEOUT_MS=3000
```

---

## 9. Running Realistic E2E Test Suites

Saath includes **357 executable Playwright tests** across 81 specs covering:
* **Tier 1**: Core Happy Paths (PNR verification, seat geometry, matching, swap card, chat, karma, DPDP, admin portal)
* **Tier 2**: Edge cases (circular swaps, lock expiration, offline PWA cache, privacy boundaries)
* **Tier 3**: Multi-party Bay cycles, 3-way/4-way chain swaps, payment webhook simulations
* **Tier 4**: Chaos resilience, provider timeout failover, zero-PII leak audits

### Executing the E2E Suite:
```bash
# 1. Start full containerized stack
docker compose up -d

# 2. Run Playwright E2E tests
pnpm test:e2e

# Or run specific tier:
npx playwright test --grep "@tier1"
```
