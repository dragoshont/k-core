# Phase 2 Plan: Application Foundation

- Status: Approved for semantic plan review
- Date: 2026-07-17
- Governing decisions: ADR-0001 through ADR-0004
- Contract: `contracts/http.openapi.yaml`
- Executable Phase 2 contract: `contracts/http.phase-2.openapi.yaml`

## Outcome

After Phase 2, Member 1, Member 2, or Member 3 can open the private server-rendered
site, set or recover a PIN using an operator-issued one-time code, unlock a fixed
profile, search Open Library, and inspect metadata-only book details. The same domain
services power HTML and JSON routes. No route claims acquisition, conversion, email,
or durable delivery capability.

## Scope

Phase 2 implements:

1. A Node 24 server-rendered web host that composes the approved React components.
2. PostgreSQL migrations and fixed profile seed data.
3. An operator CLI for setup and recovery codes.
4. PIN setup, login, logout, reauthentication, PIN change, sessions, throttling,
   CSRF/Origin validation, and the private request boundary.
5. Open Library metadata-only search and detail with caching and a 3 RPS limiter.
6. `/healthz` and fail-closed `/readyz`.
7. Unit, integration, migration, HTML/JSON parity, and adversarial tests.

Phase 2 explicitly excludes acquisition, upload, artifacts, preflight execution,
operations, workers, Calibre, EPUBCheck, SMTP, OPDS, Playwright acquisition,
Kubernetes/IaC, live secrets, and games. The corresponding API paths remain marked
Phase 3 and are not registered by the Phase 2 host.

## Phase 2 UI Truth Table

Phase 1 remains the approved end-state component/story source. Phase 2 composes only
the subset below; hidden items are not disabled placeholders and are not advertised in
navigation, HTML, capability metadata, or the executable Phase 2 OpenAPI contract.

| Surface | Phase 2 behavior | Phase 3 behavior |
|---|---|---|
| Unlock and Setup | Active; full setup/recovery/login states | Unchanged |
| Search | Active; Open Library only; every result is `metadata-only` | Adds other providers and acquisition capability |
| Book Detail | Active; bibliographic evidence only; no option selector or availability action | Adds approved acquisition options |
| Profile identity | Active; profile name, session/logout, PIN change | Unchanged |
| Profile Kindle destination/sender | Hidden; no delivery API is registered | Active after delivery backend exists |
| Activity navigation/page | Hidden; no operation API or placeholder page | Active after durable operations exist |
| Delivery Preflight | Hidden; no action or route | Active after acquisition/delivery checks exist |

`ApplicationShell` receives a Phase 2 navigation model containing Search and Profile
only; this is an input to the existing component, not a second shell. `BookDetail`
receives no acquisition options and therefore renders metadata evidence without a
button. `ProfileSettings` is split by existing sections: Phase 2 composes only the PIN
identity section, while Kindle/sender sections are not rendered. Any needed section
visibility becomes explicit component props and Storybook states before SSR binding.

The executable contract is `contracts/http.phase-2.openapi.yaml`. It contains only the
11 implemented paths and constrains catalog values to `metadata-only`, an empty
`acquisitionOptions` array, one Open Library provider, and explicit `fresh|stale`
evidence. `contracts/http.openapi.yaml` remains the accepted end-state contract.

## Tournament

| Option | Pros | Cons | Blast radius | Durability | Verification | Verdict |
|---|---|---|---|---|---|---|
| Minimal auth/search patch | Smallest immediate diff | Creates schema and contract drift before delivery work | Medium | Low | Moderate | Lose |
| Contract-scoped modular-monolith slice | One identity/search truth; preserves approved boundaries | Auth and migration work is security-sensitive | Medium | High | High but deterministic | **Win** |
| Defer and rewrite the end-state contract | Lowest immediate risk | Reopens approved decisions without current evidence | Low | Medium | Low utility | Lose |

The winning plan phase-annotates the accepted end-state contract and implements only
the identity/search subset. This is the first YAGNI rung that provides a real,
testable household site without building Phase 3 side effects.

## Stack And Dependencies

- Node 24 standard `http`, `crypto`, URL, streams, and testable service modules.
- `react-dom/server` for static server-rendered HTML using the approved components.
- `pg` for explicit, auditable PostgreSQL queries. No ORM or query-builder layer.
- `argon2` for Argon2id PIN verification.
- `ipaddr.js` for security-critical IPv4/IPv6 CIDR parsing and matching instead of a
  hand-written network parser.
- Existing Vitest for Node tests. PostgreSQL integration tests use an ephemeral
  `postgres:16-alpine` container launched by a repository script; no test framework
  dependency is added.

Do not add Redis, BullMQ, an auth framework, a generic cache, OpenAPI code generation,
GraphQL, an object store, or a separate server-side component layer.

## Ordered Slices

### 2.1 Contract And Migration Foundation

Scope:

- Add `x-implementation-phase` to every OpenAPI path.
- Add ordered up/down migrations with an advisory-lock migrator.
- Seed exactly three deterministic profile rows.
- Add migration and schema-constraint integration tests.

Checkpoint: an empty PostgreSQL 16 database migrates up, contains exactly the three
profiles, migrates down in local/CI, and rejects invalid profile/state/digest rows.

### 2.2 Operator Credential CLI

Scope:

- `k admin credential-code --profile <slug> --purpose <setup|recovery> [--ttl 15m]`.
- Generate 32 random bytes and print the 43-character base64url code once.
- Store only SHA-256 bytes; never place the code in logs, argv, or audit details.
- Setup issuance is allowed only for `setup-required` profiles.
- Recovery issuance atomically increments credential revision, marks
  `recovery-required`, revokes sessions, consumes prior codes, and audits the action.

Checkpoint: setup/recovery issuance and every invalid state are transaction-tested;
captured logs and database rows contain no raw code.

### 2.3 Identity And Private Boundary

Scope:

- Credential redemption, login, logout, reauthentication, and PIN change.
- Persisted profile/source throttles and lock escalation.
- Opaque session cookies and signed double-submit CSRF.
- Same-origin Origin/Referer enforcement.
- Trusted-proxy, canonical HTTPS origin, and private-client CIDR middleware.
- Shared command/query handlers for HTML and JSON.

Checkpoint: all auth transitions, restart-persistent throttles, CSRF/Origin, IDOR,
session rotation/revocation, and private-boundary adversarial tests pass.

### 2.4 SSR Routes

Scope:

- Bind `/`, `/unlock`, `/setup`, `/reauthenticate`, `/logout`, `/search`,
  `/books/:catalogRef`, and `/profile` to the approved components.
- Use Post/Redirect/Get for HTML mutations.
- Preserve only non-secret fields on failure.
- Omit Activity and delivery actions rather than presenting non-working controls.
- Serve generated token CSS and the minimal app CSS without requiring JavaScript.

Checkpoint: the full setup, unlock, search, detail, reauth, PIN-change, and logout
journey passes with JavaScript disabled.

### 2.5 Open Library Metadata

Scope:

- Use documented Open Library Search and Work/Edition JSON APIs only.
- Identify requests with application name and operator-provided contact.
- Enforce an aggregate maximum of 3 requests/second in the single Phase 2 process.
- Normalize and cache metadata; Phase 2 always returns `metadata-only`, with no
  acquisition options or executable download URL.
- Serve fresh cache immediately; on upstream failure, serve eligible stale cache with
  explicit stale evidence; return `503` when no usable cache exists.

Checkpoint: fixtures prove normalization, limiter behavior, fresh/stale cache,
upstream failure, malformed references, query bounds, and zero acquisition leakage.

### 2.6 Readiness And Closure

Scope:

- `/healthz` checks process liveness only.
- `/readyz` checks validated config, private-boundary prerequisites, required secret
  presence, database reachability, and expected schema version.
- Provider outage does not fail readiness.
- Run backend checks, secret scans, migration rollback, HTML/JSON parity, and two
  implementation judges.

Checkpoint: Phase 2 gates pass without implementing or advertising Phase 3 routes.

## Database Contract

Migrations are UTF-8 SQL files with explicit up/down sections. `migrate` takes a
PostgreSQL advisory lock, records versions in `schema_migrations`, applies forward in
order, and refuses a database newer than the binary.

### `profiles`

- `profile_id uuid primary key`
- `slug text not null unique` with a bounded normalized alias constraint
- `display_name text not null unique` with a bounded normalized alias constraint
- `credential_state text not null check (credential_state in ('setup-required','ready','recovery-required'))`
- `credential_revision integer not null default 0 check (credential_revision >= 0)`
- `pin_verifier text null`
- `pin_fingerprint bytea null check (pin_fingerprint is null or octet_length(pin_fingerprint)=32)`
- `pin_updated_at timestamptz null`
- `kindle_address text null`
- `destination_revision integer not null default 0 check (destination_revision >= 0)`
- `created_at`, `updated_at timestamptz not null default now()`
- Partial unique index on `pin_fingerprint where pin_fingerprint is not null`.

`kindle_address` and `destination_revision` are an intentional expand-first schema
step from the accepted architecture. They remain null/zero and have no Phase 2 route,
UI, or capability. Adding them before profiles hold real auth state avoids a Phase 3
rewrite of this security-sensitive table; their presence does not activate delivery.

Seed IDs are stable and non-secret:

| Slug | UUID | Initial state |
|---|---|---|
| `member-1` | `00000000-0000-4000-8000-000000000001` | `setup-required` |
| `member-2` | `00000000-0000-4000-8000-000000000002` | `setup-required` |
| `member-3` | `00000000-0000-4000-8000-000000000003` | `setup-required` |

### `credential_codes`

- UUID primary key; restrictive profile foreign key.
- Purpose `setup|recovery`, credential revision, 32-byte unique digest.
- Non-secret issuer label, issue/expiry/consumption timestamps and reason.
- Expiry must be after issue and no more than 24 hours.
- Consumption timestamp and reason are both null or both non-null.
- At most one unconsumed code per profile via a partial unique index.

### `auth_throttles`

- Composite primary key `(scope, category, subject_key)`.
- Scope `profile|source`; category `pin|credential`.
- Profile scopes require a profile foreign key and its UUID as subject key.
- Source scopes store only a 64-character HMAC-derived key, never a raw address.
- Failure count, window, lock level `0..3`, and optional `locked_until` persist.

### `sessions`

- UUID primary key and profile foreign key with cascade.
- Unique 32-byte token digest; raw session token is never stored.
- Created, last-seen, recent-auth, idle expiry, absolute expiry, revocation fields.
- Revocation reason is constrained to logout, credential reset, PIN change, recovery
  issue, expiry, or rotation; timestamp and reason are both null or non-null.
- Partial indexes support active profile lookup and expiry cleanup.

### `provider_cache`

- Primary key `(provider_id, resource_kind, cache_key)`.
- Phase 2 provider is exactly `open-library`; kind is `search|detail`.
- SHA-256 cache key, HTTP status, normalized JSON, optional ETag/Last-Modified,
  fetched/fresh/stale/access timestamps with ordering constraints.

### `audit_events`

- UUID primary key; immutable through role privileges.
- Actor kind `operator-cli|profile|system`, optional profile foreign key, label.
- Action, constrained target kind, target ID, constrained outcome.
- Correlation/request UUIDs, optional source hash, redacted JSON details.
- Indexes by target/time, actor/time, correlation, and action/time.

Tables intentionally absent: `preflights`, `operations`, `operation_stages`,
`artifacts`, and `delivery_attempts`.

## Authentication Contract

- PINs remain strings matching `^[0-9]{4}$`; leading zeroes are preserved.
- Store Argon2id verifiers with per-row salts and a runtime `PIN_PEPPER`.
- Reject duplicate household PINs using
  `HMAC-SHA256(PIN_REUSE_SECRET, pin)` in `pin_fingerprint`.
- The weak-PIN deny list is a reviewed, committed TypeScript constant under the
  identity module. It contains only PIN strings, is covered by table tests, and is not
  runtime-configurable or stored in PostgreSQL.
- Credential codes are decoded from base64url and compared by constant-time digest.
- Session tokens are 32 random bytes; store only SHA-256. Cookie:
  `__Host-k.sid; Secure; HttpOnly; SameSite=Strict; Path=/`.
- Signed double-submit CSRF cookie: `__Host-k.csrf; Secure; SameSite=Strict; Path=/`.
- Idle expiry 30 minutes; absolute expiry 12 hours; recent-auth window 10 minutes.
- Reauthentication rotates the session token. PIN change and recovery issuance revoke
  every session for that profile.
- PIN profile locks: failures 1-2 record only; delay after 3; five failures in 15
  minutes lock 15 minutes; repeat windows escalate to one hour, then 24 hours.
- Source lock: ten failures in one hour locks that source for one hour.
- Mutations require CSRF plus matching Origin. Referer is accepted only when Origin is
  absent and matches the exact configured HTTPS origin; missing both fails closed.

## Private Request Boundary

Except for cluster-local probes:

1. The immediate peer must be within `TRUSTED_PROXY_CIDRS`.
2. Only the canonical forwarded values supplied by that peer are parsed.
3. Forwarded scheme and host must equal `PUBLIC_ORIGIN` using HTTPS.
4. The resolved client address must be inside `ALLOWED_PRIVATE_CLIENT_CIDRS`.
5. Every configured client range must itself be private; public ranges reject startup.

Direct pod access, caller-appended forwarding chains, foreign hosts, non-HTTPS origin,
and public clients fail before authentication.

## Route Ownership

| HTML | JSON | Shared service | Phase |
|---|---|---|---|
| `GET /`, `GET/POST /unlock` | profiles, login | Auth/session | 2 |
| `GET/POST /setup` | credential redemption | Auth | 2 |
| `GET/POST /reauthenticate` | reauthenticate | Auth/session | 2 |
| `POST /logout` | logout | Auth/session | 2 |
| `GET /search` | catalog search | Catalog | 2 |
| `GET /books/:catalogRef` | catalog detail | Catalog | 2 |
| `GET /profile`, `POST /profile/pin` | session, PIN change | Auth/session | 2 |
| `/healthz`, `/readyz` | same | Host health | 2 |
| delivery settings, preflight, operations, Activity execution | corresponding API | none | 3, not registered |

## Test Matrix

- Migration up/down, advisory lock, idempotent seed, newer-schema refusal, every DB
  check/unique constraint, and restore guidance.
- CLI setup/recovery state rules, code secrecy, one open code, expiry, and atomic
  recovery side effects.
- Wrong profile/purpose/revision, expiry, replay, supersession, and concurrent code
  redemption.
- Leading-zero PIN, weak PIN, duplicate household PIN, unchanged PIN, Argon2id pepper.
- Restart-persistent profile/source throttles, escalation, and scoped reset.
- Session creation/rotation/logout, all-session revocation, idle/absolute expiry.
- CSRF mismatch, foreign/missing Origin/Referer, direct pod access, forged forwarding,
  invalid/public CIDRs, and non-HTTPS origin.
- Search bounds, malformed catalog reference, cache hit, eligible stale fallback,
  uncached provider failure, 3 RPS limiter, JSON-only provider use, and no acquisition
  fields or URLs.
- HTML/JSON parity for domain result/problem codes; no PIN/code echo in HTML.
- JavaScript-disabled setup, unlock, search, detail, PIN change, and logout.
- Readiness fails for invalid config, missing secrets, DB/schema failure, but not an
  Open Library outage.

## Migration And Rollback

Migration order:

1. `0001_identity_core`: bookkeeping, profiles, credential codes, throttles, sessions,
   audit events, indexes, and constraints.
2. `0002_seed_fixed_profiles`: deterministic three-row seed.
3. `0003_open_library_cache`: provider cache and cleanup indexes.

Local/CI proves up then down on empty PostgreSQL. Once real PIN/session data exists,
rollback is previous image plus a pre-migration PostgreSQL backup restore; logical
down migration is not presented as safe for populated auth state. A backup and restore
drill is required before the first non-local migration.

The drill produces `artifacts/migration/phase-2-restore-drill.md` containing only
redacted command versions, schema version, row counts by table, backup checksum,
restore duration, and PASS/FAIL. It must not contain connection strings, PIN data,
session data, credential codes, or secret values. The first non-local migration is
blocked until this artifact passes semantic review.

## Readiness Configuration

Required, value-redacted configuration:

- `DATABASE_URL`
- `PUBLIC_ORIGIN` (exact HTTPS origin)
- `TRUSTED_PROXY_CIDRS`
- `ALLOWED_PRIVATE_CLIENT_CIDRS`
- `PIN_PEPPER`
- `PIN_REUSE_SECRET`
- `SESSION_SIGNING_KEY`
- `SOURCE_HASH_SECRET`
- `OPEN_LIBRARY_CONTACT`

The service logs only whether required values are present and valid, never their
contents.

## Approval Checklist

Already approved by the user's explicit autonomous-build instruction:

- Local Phase 2 code, tests, migrations, containerized PostgreSQL tests, and private
  GitHub commits after gates pass.
- The four-digit PIN residual-risk decision within private LAN/VPN HTTPS.
- The three fixed profiles and optional Kindle address schema columns.

Still requires real runtime input or a later phase gate:

- Secret values and PostgreSQL/runtime endpoints.
- Kubernetes, identity, network, DNS, TLS, and ExternalSecret changes.
- Any GitOps reconcile or live deployment.
- Any acquisition, browser automation, Calibre, email, or Kindle side effect.

## Blast Radius

- Highest: authentication and private-boundary middleware; errors can lock out users
  or admit an untrusted request.
- Medium: credential revisions, session revocation, and migrations; errors can corrupt
  identity state.
- Medium: Open Library limiter/cache; errors can violate provider policy or present
  stale metadata incorrectly.
- Low: SSR composition and probes; errors affect availability or operator signal.

Each slice ends in an executable checkpoint and can be reverted independently before
the next begins.