# Architecture & Implementation Decisions

## ADR-001: `refresh_tokens.family_id` and `replaced_by` for Reuse Detection
- **Context:** `DATA_MODEL.md §Identity` defines `refresh_tokens(id, user_id, device_id, token_hash, expires_at, revoked_at)`, while `AI_BUILD_PROMPTS.md §Prompt 2` requires that reuse of a rotated/revoked refresh token immediately revokes the entire token family.
- **Decision:** Add `family_id uuid NOT NULL` (indexed) and `replaced_by uuid NULL REFERENCES refresh_tokens(id) ON DELETE SET NULL` to `refresh_tokens` in Alembic migration `0001_identity_and_audit.py`. Token rotation runs in a transaction with `SELECT ... FOR UPDATE`; presenting a token with `revoked_at IS NOT NULL` revokes all active rows sharing `family_id` and logs `auth.refresh_reuse_detected` to `audit_log`.

## ADR-002: WCAG 2.2 AA Accessible Ink & Button Complements in `packages/ui/src/tokens.css`
- **Context:** `DESIGN.md §3` defines raw brand tokens `--primary: #E2572B` (light), `--primary: #FF7A4D` (dark), `--secondary: #4FB3BD` (dark), and `--warning: #D99A1E`. Pairing `#FFFFFF` directly on `#E2572B` gives 3.73:1 (< 4.5:1 for normal text), and `#FFFFFF` on `#FF7A4D` gives 2.58:1.
- **Decision:** Preserve all `DESIGN.md §3` CSS variables verbatim for brand/icon/seat-ring fidelity, and define explicit accessible button/ink tokens (`--primary-btn-bg: #C8441B`, `--primary-ink: #FFFFFF` in light; `--primary-btn-bg: #FF7A4D`, `--primary-ink: #0F1115` in dark; `--secondary-ink: #0F1115` in dark; `--warning-ink: #1C1A17`; `--success-btn-bg: #247247`) plus `:root[data-theme="dark"]` alongside `@media (prefers-color-scheme: dark)` so both OS preference and explicit `ThemeToggle` pass WCAG 2.2 AA (`>= 4.5:1`).

## ADR-003: `PATCH /v1/me` Accepts `gender_self` Alongside `locale`, `women_only_default`, `display_alias`
- **Context:** `API_SPEC.md` mentions `locale`, `women_only_default`, and `alias` on `/v1/me`, while `DATA_MODEL.md` defines `users.gender_self` (`female|male|other|undisclosed`) and M2 `women_only` goal constraint requires `gender_self = 'female'` (or mover `gender_band = 'F'`).
- **Decision:** Expose `gender_self` in `GET /v1/me` and optional `gender_self` in `PATCH /v1/me` in M1 so profile preferences and `packages/contracts` are aligned ahead of M2.

## ADR-004: Ephemeral Ed25519 Keys in `ENV=development` Only
- **Context:** Running `apps/api` or offline OpenAPI export locally without pre-provisioned PEM strings should work seamlessly while preventing insecure defaults in production.
- **Decision:** When `ENV=production`, missing `JWT_PRIVATE_KEY`/`JWT_PUBLIC_KEY` or `TURNSTILE_MODE=fake` / `WHATSAPP_MODE=fake` / `SMS_MODE=fake` fail validation on startup. In `ENV=development` or `ENV=test`, if `JWT_PRIVATE_KEY` is unset, `Settings` generates a consistent in-process Ed25519 keypair (or loads from `.env`).
