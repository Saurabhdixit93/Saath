# Saath Privacy Policy & DPDP Act Notice (v1.0)

> **Status:** Draft aligned with the Digital Personal Data Protection Act, 2023 (**DPDP Act**) and the Digital Personal Data Protection Rules, 2025 (**DPDP Rules**). Legal-entity particulars and counsel-verified fields are marked **`[TO BE CONFIRMED BY COUNSEL]`**.

- **Notice Version:** `1.0` (`DPDP_NOTICE_VERSION`)
- **Effective Date:** `[TO BE CONFIRMED BY COUNSEL]`
- **Data Fiduciary:** Saath Travel Technologies Pvt. Ltd. `[TO BE CONFIRMED BY COUNSEL]`
- **Registered Address:** Bengaluru / Mumbai, India `[TO BE CONFIRMED BY COUNSEL]`
- **Grievance Officer Contact:** `grievance@saath.example` `[TO BE CONFIRMED BY COUNSEL]` (also available at `/grievance`)

---

## Part A — English Privacy Notice

### 1. Personal Data We Collect & Itemised Purpose Mapping

Saath processes the minimum personal data strictly required for verified peer-to-peer seat-swap coordination. Under the DPDP Act, 2023, consents are collected and recorded item-by-item in the `consents` ledger (`purpose`, `notice_version`, `granted`, `at`) across **5 distinct purposes**:

| DPDP Purpose | Classification | Data Items Processed | Storage & Safeguards |
|---|---|---|---|
| `verification` | **Essential** | 10-digit Indian mobile number (`+91`), one-time password (OTP) verification, one-way keyed PNR hash (`bookings.pnr_hash`), journey schedule metadata (`journey_instances`), coarse `age_band` (`child \| adult \| senior \| unknown`), `gender_band` (`F \| M \| U`), `coach`, `seat_no`, `seat_type`, `bay`, `trust_tier`. | Phone encrypted at rest using **AES-256-GCM** (`users.phone_enc`, AAD `saath:phone:v1`) with an **HMAC-SHA256** blind index (`users.phone_bidx`). OTPs stored as **Argon2** hashes in Redis (60s TTL). PNRs stored solely as `HMAC-SHA256(PNR_PEPPER, pnr)`. |
| `matching` | **Essential** | Travel party groupings (`parties`, `party_members`), swap goals and constraints (`women_only`, `no_middle`, `same_coach_only`, `verified_only`, `standing_offer`), `match_candidates`, `swap_proposals`, `swap_participants` (`gives_seat`, `gets_seat`, `post_confirm`), signed `swap_cards` (`Ed25519`, `public_code`), pseudonymous `conversations`/`messages`, `blocks`, `reports`, `karma_ledger`, `badges`, and reliability counters (`reliability_accepted`, `reliability_completed`). | Co-travellers see only masked coach/berth/seat-type details prior to mutual acceptance. Pre-accept chat automatically redacts phone numbers, UPI IDs, and URLs. |
| `notifications` | **Optional** | `users.notification_prefs` (`push`, `whatsapp`, `sms`, `quiet_hours_enabled` 23:00–06:00 IST), `devices` (`push_endpoint`, `push_p256dh`, `push_auth`, `user_agent`, `last_seen_at`), and `notifications_outbox` delivery records. | Delivered via Web Push (VAPID P-256) and TRAI DLT-registered SMS. Non-urgent notifications respect 23:00–06:00 IST quiet hours unless within 2 hours of departure. |
| `analytics` | **Optional (Opt-in)** | Server-side product funnel events (e.g., verify -> goal -> match -> swap lifecycle counts) and `ai_usage_logs` (model, token counts, latency). | Strictly PII-masked before dispatch. Raw PNRs, mobile numbers, display aliases, and message bodies are never sent to PostHog. |
| `whatsapp` | **Optional** | Encrypted mobile number routing for WhatsApp OTP delivery, swap lifecycle templates, and interactive WhatsApp PNR status bot sessions. | Delivered over Meta WhatsApp Cloud API using pre-approved templates (`en_US` / `hi`) with HMAC-SHA256 webhook signature verification (`WHATSAPP_APP_SECRET`). |

#### Optional Profile & Paid-Tool Records
- **Profile preferences (`/v1/me`):** Optional `display_alias` (pseudonymous), `locale` (`en \| hi`), `gender_self` (`female \| male \| other \| undisclosed` — used strictly to enforce `women_only` swaps), `women_only_default`, and `leaderboard_opt_in`.
- **Optional Paid Organiser / Partner Tools (`payment_orders`, `entitlements`):** Core peer-to-peer swaps are always `₹0`. Where a user voluntarily purchases an optional tool (such as the Group-Organiser Trip Pass at `₹199`), payment order identifiers and Razorpay webhook event IDs are stored for accounting and entitlement verification. Paid tools never grant seat-matching priority (`priority_seat_bump: false`).

---

### 2. Data We Explicitly NEVER Store

To minimise breach blast radius and uphold privacy-by-design:
1. **Raw PNRs:** Raw 10-digit Indian Railways PNRs and 7-character airline PNR codes are **never** written to PostgreSQL or logs; only `HMAC-SHA256(PNR_PEPPER, pnr)` (`pnr_hash`) is persisted.
2. **Passenger Names & Exact Ages:** Full passenger names, exact ages, and minor identities are stripped during ticket/BCBP parsing and are never persisted. Minors appear solely as `age_band = "child"`.
3. **Boarding Pass Images & PDFs:** Flight boarding pass barcodes (IATA BCBP) are decoded client-side on your device via WebAssembly (`zxing-wasm`) and `pdfjs-dist`; barcode images/PDFs are not uploaded to Saath servers (or, if any transient server fallback is invoked, deleted within a maximum TTL of 1 hour).
4. **No Raw PII to LLMs:** Raw PNRs, passenger names, and mobile numbers are never transmitted to Anthropic Claude models.
5. **Pre-Accept Co-Passenger Privacy:** Co-passenger names, phone numbers, exact ages, and unmasked identity details are never exposed before mutual swap acceptance.

---

### 3. Sub-Processors & Safeguards (6 Processors)

| # | Sub-Processor | Role & Processing Scope | Safeguards & Data Minimisation |
|---|---|---|---|
| 1 | **Cloudflare** | Edge CDN, Web Application Firewall (WAF), DDoS mitigation, and Cloudflare Turnstile bot verification. | TLS termination, edge rate-limiting, no access to encrypted PNR/phone database columns. |
| 2 | **Railway** | Cloud hosting (India / Mumbai region), managed PostgreSQL 16 and Redis 7. | TLS 1.3 in transit, encryption at rest, India data residency for primary database and CERT-In logs. |
| 3 | **PostHog** | Server-side product funnel analytics (active only when `analytics` consent is granted). | Strict PII masking; zero names, phone numbers, or PNRs transmitted. |
| 4 | **MSG91** | TRAI DLT-registered SMS OTP (`MSG91_DLT_TE_ID_OTP`) and transactional alert delivery (`MSG91_DLT_TE_ID_NOTIFY`), Sender ID `SAATHI`. | Receives only recipient phone number and templated alert variables. |
| 5 | **Meta (WhatsApp Cloud API)** | WhatsApp OTPs, swap notification templates, and interactive PNR bot messages. | Pre-approved bilingual templates; HMAC-verified webhooks. |
| 6 | **Anthropic (Claude API)** | Swap Concierge (`claude-sonnet-5-5`) and outreach drafts, translation, and chat moderation (`claude-haiku-5-5`). | Zero raw PNRs, passenger names, or mobile numbers sent to the LLM. |

---

### 4. Exact Data Retention Schedule

| Data Category | Retention Window | Deletion / Anonymisation Mechanism |
|---|---|---|
| PNR hashes (`bookings`), `seat_holders`, `parties`, `goals`, `match_candidates`, chat `messages` | **Journey arrival + 30 days** (`bookings.purge_after`) | Automated nightly Arq scheduler purge job. |
| Uploaded ticket images / PDFs (if transient fallback used) | **Never stored** (client-side decode) or **1 hour max TTL** | In-memory transient discard. |
| OTP hashes (Redis) | **60 seconds** | Redis automatic TTL expiry (`max 5` attempts). |
| Party invite links (`parties.invite_expires_at`) | **48 hours** | Expiry enforcement + nightly purge. |
| Seat invite links (`seat_invites`) | **72 hours** | Expiry enforcement + nightly purge. |
| Refresh tokens (`refresh_tokens`) | **30 days** (or immediate on logout/reuse/erasure) | Family-ID reuse revocation & expiry cleanup. |
| Pseudonymous `swap_proposals` & signed `swap_cards` | **2 years** | Retained without raw PII for Karma and dispute integrity. |
| Moderation/safety `reports` & CERT-In ICT security logs (`audit_log`) | **180 days** rolling in India | CERT-In Directions (2022) compliance; purged after window where no legal hold applies. |
| Karma ledger (`karma_ledger`) | **Life of account** | Anonymised immediately (`user_id = NULL`) upon account deletion. |
| Account erasure (`DELETE /v1/me`) | **Immediate session revocation; full PII removal within 24 hours** | Immediate `users.status = 'deleted'`, refresh token revocation, `karma_ledger` anonymisation, and scheduled 24-hour PII scrub. |

---

### 5. Children's & Minors' Data (DPDP Act Section 9)

- You must be **18 years of age or older** to create a Saath account, grant DPDP consents, or agree to a seat swap.
- Saath does **not** knowingly collect personal data directly from children/minors under 18, nor do we perform behavioural tracking or targeted advertising directed at children.
- Minors travelling on a verified adult's booking appear solely as non-identified party members (`age_band = "child"`) without any name, exact age, or phone number.

---

### 6. Your Rights as a Data Principal & Grievance Redressal

Under the DPDP Act, 2023 and DPDP Rules, 2025, you may exercise the following rights at any time:
1. **Right to Access & Data Portability:** Download an immediate ZIP archive of your account data (`GET /v1/me/export`, containing JSON files without raw PNRs, encryption keys, or minor identities) from `/profile`.
2. **Right to Withdraw Consent:** Toggle optional DPDP purposes (`notifications`, `analytics`, `whatsapp`) on `/profile` (`POST /v1/me/consents`) at any time without affecting prior lawful processing.
3. **Right to Correction & Erasure:** Update your profile preferences or invoke **"Delete my data"** (`DELETE /v1/me`) on `/profile` for immediate session revocation and full PII erasure within **24 hours**.
4. **Right of Grievance Redressal:** Contact our Designated Grievance Officer via `/grievance` or `grievance@saath.example` `[TO BE CONFIRMED BY COUNSEL]`.
   - **Acknowledgment:** Within **48 hours** `[TO BE CONFIRMED BY COUNSEL]`.
   - **Resolution Target:** Within **15–30 days**, and strictly within the **90-day statutory ceiling** under DPDP Rules, 2025 Rule 14(3) `[TO BE CONFIRMED BY COUNSEL]`.
5. **Escalation to the Data Protection Board of India (DPBI):** Under DPDP Act Section 13, if your grievance remains unresolved after exhausting our internal Grievance Officer process, you may file a complaint with the **Data Protection Board of India (DPBI)**.

---

## Part B — हिंदी गोपनीयता सूचना (Hindi Privacy Summary)

- **सूचना संस्करण:** `1.0` · **डेटा फ़िड्यूशियरी:** Saath Travel Technologies Pvt. Ltd. `[TO BE CONFIRMED BY COUNSEL]`
- **शिकायत अधिकारी ईमेल:** `grievance@saath.example` `[TO BE CONFIRMED BY COUNSEL]` (`/grievance`)

### 1. हम कौन-सा डेटा एकत्र करते हैं और क्यों (5 DPDP उद्देश्य)
1. **verification (अनिवार्य):** 10 अंकों का मोबाइल नंबर (AES-256-GCM एन्क्रिप्टेड + HMAC-SHA256 ब्लाइंड इंडेक्स), Redis में Argon2 OTP हैश (60 सेकंड), एकतरफ़ा HMAC-SHA256 PNR हैश, यात्रा मेटाडेटा, आयु वर्ग (`child/adult/senior/unknown`), लिंग वर्ग (`F/M/U`), कोच और सीट कोड।
2. **matching (अनिवार्य):** ग्रुप, स्वैप लक्ष्य, `women_only` जैसी शर्तें, मैच उम्मीदवार, स्वैप प्रस्ताव, डिजिटल स्वैप कार्ड, और गुमनाम चैट/कर्म लेजर।
3. **notifications (वैकल्पिक):** Web Push, WhatsApp या SMS प्राथमिकताएँ, और शांत समय (23:00–06:00 IST)।
4. **analytics (वैकल्पिक):** PII-मुक्त फ़नल विश्लेषण (नाम, फ़ोन या PNR कभी नहीं भेजे जाते)।
5. **whatsapp (वैकल्पिक):** WhatsApp Cloud API के ज़रिए OTP, स्वैप अलर्ट और PNR बॉट उत्तर।

### 2. डेटा जो हम कभी सहेजते नहीं हैं
- मूल 10 अंकों का रेलवे PNR या 7 अक्षरों का फ़्लाइट PNR कभी डेटाबेस में नहीं लिखा जाता।
- यात्रियों के पूरे नाम, सटीक उम्र और नाबालिगों की पहचान सहेजी नहीं जाती (`age_band=child` केवल)।
- बोर्डिंग पास की छवि या PDF आपके डिवाइस पर ही WebAssembly से पढ़े जाते हैं।
- AI मॉडल (Anthropic Claude) को कभी मूल PNR, नाम या फ़ोन नंबर नहीं भेजे जाते।

### 3. हमारे 6 सब-प्रोसेसर
1. **Cloudflare** (CDN, WAF, DDoS और Turnstile)
2. **Railway** (भारत/मुंबई में एप्लिकेशन होस्टिंग, PostgreSQL 16 और Redis 7)
3. **PostHog** (PII-मास्क्ड सर्वर-साइड विश्लेषण, केवल `analytics` सहमति पर)
4. **MSG91** (TRAI DLT-पंजीकृत SMS OTP और अलर्ट, Sender ID `SAATHI`)
5. **Meta (WhatsApp Cloud API)** (WhatsApp OTP और स्वैप टेम्पलेट)
6. **Anthropic (Claude API)** (बिना मूल PII के स्वैप सहायक और मॉडरेशन)

### 4. संग्रहण अवधि और आपके अधिकार
- **यात्रा डेटा और चैट:** यात्रा समाप्ति + **30 दिन** (रात को स्वचालित मिटाया जाता है)।
- **OTP हैश:** **60 सेकंड**; **ग्रुप आमंत्रण:** **48 घंटे**; **सीट आमंत्रण:** **72 घंटे**; **रिफ़्रेश टोकन:** **30 दिन**।
- **स्वैप कार्ड/रिकॉर्ड:** **2 वर्ष**; **सुरक्षा रिपोर्ट और CERT-In लॉग:** **180 दिन** (भारत में)।
- **नाबालिग नियम (DPDP धारा 9):** खाता बनाने या स्वैप स्वीकार करने के लिए आयु **18+** अनिवार्य है।
- **आपके अधिकार:** `/profile` से कभी भी वैकल्पिक सहमति बदलें, **ZIP डेटा एक्सपोर्ट** (`GET /v1/me/export`) तुरंत डाउनलोड करें, या **24 घंटे के भीतर खाता हटाने** (`DELETE /v1/me`) का अनुरोध करें। शिकायत के लिए `/grievance` पर जाएँ (48 घंटे में पावती, 15–30 दिन में समाधान, अधिकतम 90 दिन सीमा `[TO BE CONFIRMED BY COUNSEL]`), और असंतुष्ट होने पर **DPBI** में शिकायत दर्ज करें।
