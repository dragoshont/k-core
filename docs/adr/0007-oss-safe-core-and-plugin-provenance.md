# ADR-0007: OSS-safe core and plugin provenance

- Status: Accepted
- Date: 2026-07-19
- Extends: ADR-0002, ADR-0005, ADR-0006

## User-visible outcome

`k` can be published as a legitimate open-source core without publishing one
household's identities, topology, secrets, or private plugins. A deployment still has
exactly three profiles and still uses operator-issued setup or recovery codes followed
by a four-digit PIN. Sources whose book provenance is not established may contribute
metadata, but cannot expose a download or delivery action.

## Context

The private prototype encoded household names in SQL constraints, TypeScript literal
types, contracts, stories, tests, and image smoke checks. Its container also copied the
whole `plugins/` directory. Making that repository public in place would retain those
values in history and would make a future private plugin easy to include accidentally.

A plugin manifest is deployment-reviewed code, but its assertion about book rights is
not sufficient authority for an external effect. The user wants sources with unclear
provenance to remain searchable while keeping `k` a lawful acquisition system.

## Decision

### Public lineage

The existing repository and history remain private. A reviewed snapshot with a new
root commit becomes the public lineage. Publication does not preserve fork ancestry or
copy private run artifacts. Phase 6 prepares and verifies that snapshot but cannot
publish: its GitHub workflow has `contents: read`, performs no registry login, and has
no `push: true` build step. Repository creation and GHCR publication are a separate
phase.

The public project uses Apache-2.0 metadata. `package.json` remains `private: true` to
prevent accidental npm publication; that flag is unrelated to source licensing.

### Three durable profile slots

Profiles have three immutable UUID identities:

| Slot | UUID | Neutral slug | Neutral display name |
|---:|---|---|---|
| 1 | `00000000-0000-4000-8000-000000000001` | `member-1` | `Member 1` |
| 2 | `00000000-0000-4000-8000-000000000002` | `member-2` | `Member 2` |
| 3 | `00000000-0000-4000-8000-000000000003` | `member-3` | `Member 3` |

UUIDs are identity and foreign-key ownership. Slugs and display names are
operator-owned aliases. A deployment may set aliases through `PROFILE_CONFIG_FILE`, a
non-secret JSON document conforming to `contracts/profile-config.schema.json`.
Missing configuration means the exact neutral document above.

The parser reads at most 16 KiB, requires UTF-8 JSON, rejects unknown fields, and
requires the fixed UUID in each ordered slot. A slug is already-normalized lowercase
ASCII matching `^[a-z][a-z0-9-]{0,63}$`; it cannot be UUID-shaped or one of `admin`,
`api`, `auth`, `healthz`, `oauth`, `profile`, `profiles`, `readyz`, `session`, `setup`,
`unlock`, `search`, `activity`, or `operations`. Slugs are unique by exact value.

A display name is 1-120 Unicode code points, has no C0/C1 control or Unicode format
character, has no leading or trailing whitespace, and must equal its NFKC normalization. Display names
are unique by `NFKC(value).toLocaleLowerCase("und")`. Duplicate normalized aliases or
any invalid file produce the fixed error `PROFILE_CONFIGURATION_INVALID`; errors do
not include file contents or alias values.

Browser and API profile selection and all mutations use the immutable profile UUID.
Query-string profile selection also accepts UUID only. The operator command
`k admin credential-code --profile <slug>` is the only slug-targeted mutation and
must resolve exactly one configured slug. Display names never identify a profile.
External provider identities remain account connections and never unlock `k`.

### Config-aware migration boundary

Configuration is parsed and semantically validated before a database transaction is
opened. The existing TypeScript migrator receives the validated value and an
`explicitFile` flag; no SQL migration reads files or environment variables.

Inside the existing transaction, the migrator acquires its advisory lock, reads schema
versions and current profile rows, and performs a preflight before applying any pending
migration:

- a fresh database may use neutral defaults;
- an existing database with exact neutral aliases may use neutral defaults;
- an existing database with any non-neutral alias requires an explicit file whose
  three UUIDs match the database slots;
- absence, invalid configuration, an unexpected UUID, or a row count other than three
  aborts before migration SQL or alias mutation.

Migration 0007 is structural SQL. It captures the pre-0007 aliases by UUID, removes
household-literal checks, installs fixed-slot and bounded-alias constraints, and
installs a trigger that permits alias mutation only when the transaction-local
`k.profile_alias_migration` flag is set. Immediately after 0007 structural SQL, the
TypeScript migrator sets that local flag, updates all three aliases by UUID using one
parameterized statement, verifies exact config/database equality, and only then writes
the migration marker. The same reconciliation runs idempotently when version 7 is
already applied.

The web process never reconciles profiles. `/healthz` remains liveness-only.
`/readyz` compares the configured UUID/slug/display-name triples with the database and
returns `503 profile_configuration_mismatch` on drift. All other web routes fail with
the same generic readiness error. The worker checks parity before claiming work, and
the operator credential command checks parity before issuing a code.

Down-to-6 restores the aliases captured by UUID, removes the mutation trigger and
backup table, and leaves the generic fixed-slot/format constraints in place. It never
recreates household literals and never changes or deletes profile rows, PIN verifiers,
credential revisions or codes, sessions, throttles, destinations, provider accounts,
preflights, operations, artifacts, attempts, or audit events. A backup and restore
rehearsal remains mandatory before a real deployment cutover.

### Public and private plugin roots

`PUBLIC_PLUGIN_DIR` is the immutable, bundled public root. `PRIVATE_PLUGIN_DIR` is an
optional, distinct, read-only runtime root for a future separately built payload.
`PLUGIN_DIR` remains a development/test compatibility alias for one public root only
when neither new variable is set; combining it with either new variable is invalid.
Overlapping or identical roots are invalid.

Discovery validates each root independently, rejects symlinks and special files,
computes recursive path-framed integrity, then rejects duplicate plugin IDs or
capability IDs across the complete inventory. A private plugin cannot shadow a public
plugin. Missing explicitly configured roots make readiness fail.

The core image explicitly copies shared `lib` plus the reviewed public inventory:
`project-gutenberg`, `standard-ebooks`, `internet-archive`, `google-books`,
`google-gmail`, and `login-with-amazon`. It has no private-root build argument, registry
credential, installer, tag resolver, or OCI pull code. A future private payload may be
mounted by immutable digest; implementing or distributing that payload is not part of
this decision's current phase.

### Provenance is listing authority, not effect authority

The existing v2 catalog capability already separates `catalog.search`,
`catalog.detail`, and `catalog.acquire`. A source with unclear provenance declares
search and optional detail but no acquire command and no rights basis. Core classifies
its results as `metadata-only` with provenance state `unverified-provenance`, reason
code `UNVERIFIED_PROVENANCE`, and an empty acquisition-options array. Any options
returned by such a plugin are rejected as a protocol violation.

`public-domain`, `user-owned`, and `licensed-private` remain the only rights-basis
values. In this phase only a plugin present in the core-owned reviewed inventory,
with a current digest, an acquire-declaring catalog capability, `public-domain` in its
manifest, and reviewed provider-policy evidence receives `verified-public-domain`
provenance and may expose acquisition options. `user-owned` and `licensed-private`
remain recognized but effect-blocked until a later contract defines profile-bound
ownership or license evidence.

Core owns one rights-policy decision. Catalog normalization applies it; delivery
preflight recomputes it; queue creation validates the persisted snapshot; the worker
recomputes it immediately before acquisition and immediately before delivery. Missing,
stale, forged, changed, or plugin-only evidence blocks the effect. Metadata caches can
never add rights or acquisition options.

## Verification

The implementation must prove:

1. neutral and custom aliases migrate atomically and idempotently by UUID;
2. every profile-owned row and credential/session value survives alias changes and
   guarded rollback;
3. malformed, absent legacy, colliding, reserved, non-normalized, or stale config fails
   without mutation;
4. web, worker, and operator paths refuse config/database drift;
5. metadata-only sources are visible but cannot preflight, queue, acquire, or deliver,
   including forged cache/database and changed-plugin cases;
6. root overlap, symlinks, special files, path escapes, and public/private shadowing
   fail discovery;
7. the image contains exactly the reviewed public inventory and no private payload;
8. the public snapshot scan finds no household denylist value, private topology,
   proprietary marker, secret, unexpected plugin, or private run artifact.

## Consequences

Deployments must carry their non-secret profile file whenever aliases differ from the
neutral defaults. A missing file intentionally causes an outage rather than silently
renaming identities. Unknown-provenance sources remain useful for discovery but cannot
turn into acquisition capability. Private plugin distribution and profile-bound
ownership/license evidence require later decisions.

## Rejected alternatives

- Make the private repository public or rewrite it in place: removed values remain hard
  to audit and accidental disclosure is irreversible.
- Keep household aliases as a permanent private patch: every sync recreates the privacy
  risk and forks identity behavior.
- Trust a plugin's rights declaration: code that requests an effect cannot also be the
  sole authority that approves it.
- Replace PIN login with Authentik: changes the identity boundary and does not solve
  source-history or plugin-provenance problems.
