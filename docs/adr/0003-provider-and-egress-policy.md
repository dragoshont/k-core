# ADR-0003: Capability-separated providers and deny-by-default acquisition

- Status: Accepted
- Date: 2026-07-17

## Context

Search results come from providers with different rights, freshness, formats, and
transport needs. Treating every metadata hit as downloadable would mislead users and
turn provider content into an SSRF or unlicensed-acquisition channel.

## Decision

Separate metadata discovery from acquisition. Register each provider in code with a
capability descriptor, rights basis, approved origin set, limits, and transport.
Clients receive opaque provider IDs rather than executable URLs. The initial registry
contains Open Library metadata, a reviewed public-domain acquisition provider, and a
user-owned upload path. Private OPDS follows after the first slice.

Browser acquisition is provider-specific and remains disabled until its egress tests
pass. Anna's Archive, unlicensed VK downloads, DRM circumvention, caller-supplied URLs,
and generic browser recipes are absent from the registry and covered by negative tests.

## Consequences

The UI can state `metadata-only`, `candidate`, or `deliverable` honestly. Adding a
provider requires code review and policy evidence, not runtime configuration alone.
Some searches will correctly offer no Send action.

## Rejected alternatives

- **General crawler or URL downloader:** creates unbounded legal and SSRF exposure.
- **Search-engine scraping:** unstable, violates source policies, and loses provenance.
- **Runtime plug-in SDK:** unnecessary with fewer than two approved acquisition sources.
- **Hidden unsupported providers:** hiding capability is not removing its risk.
