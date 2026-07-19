# ADR-0005: Installed source plugins

- Status: Accepted
- Date: 2026-07-18
- Supersedes: ADR-0003's rejection of a runtime plugin boundary

## Context

The household wants book sources to be independently deployable by the operator.
Core `k` must not acquire book bytes itself. ADR-0003 assumed
fewer than two acquisition sources and rejected a plugin SDK; three concrete sources
now make that assumption false.

## Decision

Source plugins are operator-installed directories under `PLUGIN_DIR`. Each contains a
strict `plugin.json` manifest and a Node entrypoint implementing protocol version 1.
Core discovers manifests but never downloads or installs plugin code. Presence in the
reviewed deployment folder means active; there is no end-user configuration control.

Core invokes one short-lived child process per command using one JSON request on
stdin and one JSON response on stdout. Commands are `describe`, `search`, `detail`,
and `acquire`. Only `acquire` may write bytes, and only to the random quarantine path
created and supplied by core. Public HTTP DTOs contain opaque plugin/item/option IDs,
never executable URLs, headers, cookies, selectors, or output paths.

The first installed plugins are:

1. Project Gutenberg: OPDS search/detail and official EPUB acquisition.
2. Standard Ebooks: low-volume public catalog/detail scraping and same-origin EPUB.
3. Internet Archive: Advanced Search plus metadata-listed EPUBs, restricted to
   explicit Public Domain Mark or CC0 rights evidence.

Plugins are trusted operator-installed code, but process input/output, time, bytes,
manifest paths, and environment are bounded. The manifest declares exact source
origins, rights basis, formats, limits, and review evidence. Core rechecks manifest,
plugin digest, preflight revision, output size/hash, and EPUB structure.

Anna's Archive, VK, arbitrary URL fetching, caller cookies, DRM circumvention, and
generic browser recipes remain absent capabilities and fail as unknown plugin IDs.

## Standards and adoption

- Project Gutenberg uses OPDS 1.2 / Atom rather than custom HTML discovery.
- Standard Ebooks uses its public semantic catalog because anonymous OPDS access is
  permissioned; responses are cached and requests remain human-triggered.
- Internet Archive uses its documented Advanced Search and Metadata APIs.
- A small child-process protocol is built locally because no installed dependency
  combines deployment-controlled activation, opaque IDs, quarantine output, and this app's
  rights boundary. Existing source protocols and parsers are adopted instead.

## Consequences

Adding a source requires deploying a reviewed plugin directory. Removing its
directory removes its search and acquisition capability on process restart. Core remains source-
agnostic and cannot fetch a book file directly.

Child-process separation is not a sandbox for hostile operator code. Deployment must
mount only reviewed plugins. Remote plugin marketplaces and runtime installation are
out of scope.

## Rejected alternatives

- In-process dynamic imports: plugin code would share all process secrets and state.
- Declarative URL templates: insufficient for OPDS, semantic HTML, rights checks, and
  redirect validation.
- Generic crawler/browser plugin: creates unbounded policy and SSRF exposure.
- One hard-coded provider service in core: violates the requested plugin-only
  acquisition boundary.
