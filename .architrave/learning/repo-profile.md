# Architrave Repo Profile

Concise, validated repository description for future Architrave runs. Keep this high-signal and cite evidence; move detailed rules into docs or path-scoped instructions.

## Purpose

Self-hosted household book discovery and lawful acquisition service with exactly three
configurable profile aliases backed by immutable UUID slots. Search is broader than
acquisition; only authorized files may enter quarantine validation and delivery.

## Surfaces And Lanes

- Web UI: server-rendered React, Storybook-first, iPhone and constrained e-reader.
- Backend: TypeScript modular monolith with separate web/worker/migrate commands.
- Data: PostgreSQL contracts and forward migrations.
- Delivery: installed source plugins, quarantine/EPUB validation, durable worker, and
	SMTP mail adapter. Calibre/EPUBCheck remain deferred because initial sources are EPUB.
- IaC/runtime: owned by the sibling `homelab` repo; plan-only/read-only until gate.

## Source Of Truth

- `docs/architecture.md` and `docs/adr/` for architecture decisions.
- `contracts/http.capabilities.phase-3.openapi.yaml` for the active Phase 3 handshake;
	`contracts/http.capabilities.openapi.yaml` remains the accepted later-phase target.
- `docs/providers/policy.md` and `docs/security/threat-model.md` for trust boundaries.
- `docs/ui/design-spec.md`, `docs/design/ui-map.json`, and `tokens/tokens.json` for UI.

## Build And Test

Node commands are configured in `architrave.config.json`. `npm run build` builds the
server entrypoints and Storybook; `npm test` runs TypeScript, real-PostgreSQL backend,
browser/axe, and design-map tests; `npm run test:visual` captures constrained viewport
references; and `gates/reconcile.sh` verifies generated token CSS.

## Architecture Map

The application builds `web`, `worker`, `migrate`, and the operator `k admin`
command. Three reviewed source-v1 plugins remain the only active path to book bytes.
Production discovery also accepts strict capability-v2 manifests; core mediates the
selected capability, command, invocation credential, process bounds, response safety,
and recursive integrity. Phase 3 adds exact Google Books metadata and core-owned,
identity-only Google/Amazon account connections with encrypted grants. PostgreSQL owns
preflight and durable operation state; the worker performs plugin acquisition,
quarantine validation, and SMTP submission. `k` owns application/release artifacts;
`homelab` owns deployed Kubernetes state.

## Recurring Gotchas

- Four-digit PIN is permitted only behind private LAN/VPN HTTPS with persistent
	throttling; public ingress is a blocker.
- Metadata is never evidence of acquisition rights.
- SMTP acceptance means Submitted, not Kindle delivery.
- Unknown provider, target, rights basis, or half-configuration fails closed.

## Validated Facts

| Fact | Evidence | Last Checked |
|---|---|---|
| The clean public lineage and release have not started. | ADR-0007 and the active Phase 6 ledger | 2026-07-19 |
| Architrave config, design map, and tokens are valid JSON. | `gates/checks.sh --quick` | 2026-07-17 |
| OpenAPI contract parses and declares 17 paths. | Ruby YAML parse and Redocly lint recorded in run gates | 2026-07-17 |
| No application or runtime deployment exists yet. | New repository status and Phase 0 runtime artifact | 2026-07-17 |
| Phone, 320px, 200% zoom, and e-reader references render without overflow or browser console errors. | `npm run test:visual`; `artifacts/screenshots/` | 2026-07-18 |
| Wave 1 implements three deployment-active public-domain source plugins, plugin-only acquisition, durable preflight/worker operations, bounded EPUB validation, and an SMTP adapter. | `plugins/`, `src/modules/plugins/`, `src/modules/delivery/`; `.architrave/runs/k-phase3-20260718/` | 2026-07-18 |
| Plugin activation is operator/deployment-owned; Profile and HTTP expose read-only source attribution and no enable/disable mutation. | ADR-0005, router/UI sweep, migration regression | 2026-07-18 |
| Wave 1 deterministic closure passed build, 65 backend tests, 69 browser/axe tests, 69 mapped declarations, visual references, token reconciliation, and dependency audit. | `.architrave/runs/k-phase3-20260718/deterministic-gates.md` | 2026-07-18 |
| Wave 1 semantic closure passed independent GPT-family and Claude-family implementation judges with zero Blockers and zero Majors. | `.architrave/runs/k-phase3-20260718/judge-post.md` | 2026-07-18 |
| Capability runtime Phase 2 supports strict source-v1/capability-v2 production conformance, pre-spawn command and authorization mediation, bounded correlated process envelopes, recursive full-tree integrity, and exact legacy-v1 snapshot transition. | `src/modules/plugins/`; `plugins/lib/runtime.mjs`; `.architrave/runs/k-wave2-20260718/deterministic-gates.md` | 2026-07-18 |
| Catalog activates only one unambiguous complete public-domain book source capability per plugin; metadata, identity, mail, destination, movie-only, and ambiguous same-plugin sources are excluded. | `src/modules/plugins/capabilities.ts`; `tests/backend/plugin-catalog.test.ts` | 2026-07-18 |
| Capability runtime Phase 2 deterministic closure passes: 72 backend tests, 89 browser/axe tests, 89 mapped declarations, token reconciliation, run validation, and zero production dependency vulnerabilities. | `.architrave/runs/k-wave2-20260718/deterministic-gates.md` | 2026-07-18 |
| Capability runtime Phase 2 semantic closure passes independent GPT-family and Claude-family implementation judges with zero Blockers and zero Major concerns. | `.architrave/runs/k-wave2-20260718/judge-post.md` | 2026-07-18 |
| Phase 3 Google Books metadata uses one exact capability, a callback-only redacted deployment key, fixed-host protocol-v2 invocation, exact ISBN or normalized title/primary-author matching, digest-bound one-day/seven-day cache entries, and additive evidence that cannot change source rights or acquisition. | `plugins/google-books/`; `src/modules/common/application-secrets.ts`; `src/modules/plugins/catalog.ts`; 58 focused and 151 full backend tests | 2026-07-18 |
| Phase 3 provider accounts use strict deployment registrations/keyrings, AES-256-GCM account/authorization-bound custody, one-use PKCE/OIDC state, static OIDC metadata, mediated provider exchange, opaque callback completion, and identity-only Google/Amazon Profile views. | `migrations/0006_metadata_provider_accounts.sql`; `src/modules/provider-accounts/`; `tests/backend/provider-{accounts,account-state,exchange,http-router}.test.ts` | 2026-07-18 |
| Phase 3 disconnect remains a protected non-mutating preview; durable submission and destination impact handling remain Phase 4. Consumed OAuth records are retained for seven days and cleaned after expired receipts. | `contracts/http.capabilities.phase-3.openapi.yaml`; `src/modules/http/router.ts`; `src/modules/provider-accounts/{service,store}.ts` | 2026-07-18 |
| Phase 3 deterministic closure passes 151 backend tests, 89 Storybook/axe tests, 81 active mapped declarations, 16 visual captures, backend checks, reconciliation, run validation, diff checks, and a zero-vulnerability production audit. | `.architrave/runs/k-wave2-20260718/deterministic-gates.md` | 2026-07-18 |
| Phase 3 semantic closure passes independent GPT-family and Claude-family implementation judges with zero Blockers and zero Major concerns after loop-1 repairs. | `.architrave/runs/k-wave2-20260718/judge-post.md` | 2026-07-18 |
| Live credentials, IaC, and application deployment remain absent. | Phase 3 ledger and runtime observer artifact | 2026-07-18 |
| Phase 6 profile configuration uses exact neutral defaults or a strict 16 KiB file, reconciles aliases only in migration 0007 by immutable UUID, and fails web/worker/operator paths closed on database drift. | ADR-0007; `src/modules/config/`; `migrations/0007_profile_alias_configuration.sql`; 119 focused tests and `gates/backend-checks.sh` | 2026-07-19 |
| Phase 6 public-source closure scans 225 candidate files, validates permitted license evidence for all 377 locked packages, and packages only shared plugin `lib`, the reviewed inventory, and six reviewed plugins. The local amd64 image passed all-21-layer inventory and isolated neutral/custom migration smoke; independent Claude and GPT implementation judges passed. | `.oss-snapshot.json`; `scripts/check-{public-snapshot,dependency-licenses,image-inventory}.*`; `scripts/phase6-image-gate.sh`; `.architrave/runs/k-oss-deployment-20260719/judge-post.md` | 2026-07-19 |

## Last Reviewed

2026-07-19 during run `k-oss-deployment-20260719`; Phase 6 complete, Phase 7 not started.
