# Phase 3 Plan: Installed public-domain plugins and delivery

- Status: Approved by explicit user instruction
- Date: 2026-07-18
- Contract: `contracts/http.phase-3.openapi.yaml`
- Governing decisions: ADR-0001, ADR-0002, ADR-0004, ADR-0005

## Outcome

After this phase, a household profile can search operator-installed public-domain
sources, inspect an authorized EPUB option, create a delivery preflight, queue a
durable operation, and track acquisition through SMTP submission. `k` cannot acquire
book bytes except through an operator-installed plugin.

## Functional scope

1. Discover strict plugin manifests from `PLUGIN_DIR`; installed means active.
2. Implement Project Gutenberg, Standard Ebooks, and Internet Archive plugins.
3. Add read-only installed source listing and source attribution.
4. Aggregate installed plugin search/detail with cache and provenance. Phase 3 removes
  the in-core Open Library catalog path; metadata and acquisition are plugin-only.
5. Add Kindle destination settings, preflights, durable operations, a worker,
   quarantine/basic EPUB validation, and SMTP delivery.
6. Bind the approved Search, DeliveryPreflight, Activity, Operation, and Profile UI
   states to real handlers, including no-JavaScript forms.

The runtime requires `OUTBOUND_CONTACT` to identify source-plugin requests. Source
origins and URLs remain inside reviewed plugin manifests and implementations; core
has no provider base-URL setting.

## Explicit exclusions

- Anna's Archive, VK, arbitrary URL/cookie/header input, generic browser automation,
  torrents, DRM removal, or unreviewed remote plugin installation.
- Non-EPUB conversion in this slice. All initial plugins expose EPUB.
- Live credentials, Kubernetes, DNS, TLS, egress policy, or deployment changes.

## Source evidence

| Plugin | Search/detail | Acquisition | Rights gate |
|---|---|---|---|
| Project Gutenberg | OPDS search and item feeds | OPDS-listed official EPUB | Feed rights statement; fixed Gutenberg origin |
| Standard Ebooks | Public semantic catalog/detail HTML | Same-origin `?source=download` EPUB | Source catalog is dedicated via CC0; zero cross-origin redirects; missing selectors/download hint fail that item only |
| Internet Archive | Advanced Search and Metadata JSON | Metadata-listed EPUB under `/download/` | Exact Public Domain Mark/CC0 license URL; redirects only to HTTPS `archive.org` or hosts ending `.archive.org`, max 3, public resolved IPs only |

Wikisource was evaluated but deferred: the hosted exporter is protected by a browser
challenge and this environment has no Calibre, Pandoc, or EPUBCheck. It is not counted
as one of the three functional plugins.

## Plugin protocol

- Manifest: schema/protocol version, ID/display/version, relative `.mjs` entrypoint,
  capabilities, exact allowed hosts, rights basis/jurisdiction/review date, formats,
  timeout, response bytes, artifact bytes.
- Request: one JSON object on stdin with `protocolVersion`, `command`, and command-
  specific opaque input.
- Response: one bounded JSON object on stdout. Stderr is diagnostic and bounded.
- `search(query)`: normalized candidates, no URLs.
- `detail(itemId)`: normalized item plus opaque acquisition options, no URLs.
- `acquire(itemId, optionId, destinationPath)`: writes one file to the supplied path
  and returns media type, size, hash, and rights evidence.

## Ordered slices

1. Contract and ADR; strict manifest validation and three installed plugin folders.
2. Additive migration for plugin cache, preflights, operations/stages,
   artifacts, and delivery attempts.
3. Plugin host plus source adapters; parser and live-probe fixtures.
4. Installed-plugin aggregated search/detail and Profile source attribution.
5. Delivery settings, preflight, operation queue, worker, EPUB validation, SMTP port.
6. SSR/API binding, no-JS journey, hardening, full deterministic and semantic gates.

## Migration and rollback

Migrations are additive. Down migration removes Phase 3 tables only in local/CI; it
must fail when durable operations or delivery attempts exist. Production rollback
after writes is stop worker plus backup restore or forward fix, never silent deletion.

## Test strategy

- Manifest path traversal, duplicate ID, malformed schema, missing entrypoint, unknown
  plugin, and prohibited IDs fail closed.
- Installed inventory, profile data isolation, plugin removal/change digest checks,
  and cache separation by plugin digest.
- Each source parses realistic fixtures and acquires an EPUB through a bounded local
  server; optional live smoke checks remain separate.
- Core source/acquisition modules contain no book-download URL or generic fetch path.
- Public `catalogRef`, item IDs, and option IDs match opaque non-URL patterns; Phase 3
  responses have no `coverUrl` or source URL fields.
- Standard Ebooks allows zero cross-origin redirects and fails closed on parser
  selector drift. Internet Archive allows at most three HTTPS redirects only within
  `archive.org`/`*.archive.org`, with public-IP validation on every hop.
- Preflight does not acquire; stale/consumed/revision-changed snapshots fail.
- Concurrent idempotent operation creation, lease claim, stage persistence, cancel,
  artifact hash/size/basic EPUB checks, SMTP accepted/rejected/ambiguous behavior.
- JSON/HTML parity and no-JS source listing → search → detail → preflight → queue → Activity.

## Human approvals

The user's explicit implementation request approves local code, migrations, source
network probes, tests, and commits. Live SMTP credentials, a real Kindle address,
plugin deployment outside this repository, IaC, and runtime mutation remain separate
approval gates.
