# ADR-0001: Modular monolith with separate web and worker processes

- Status: Accepted
- Date: 2026-07-17

## Context

The product needs fast server-rendered search and a durable pipeline with browser,
file-conversion, and email side effects. It serves three people, so independent
microservices would add failure modes without useful scale. Calibre-Web Automated
overlaps with conversion and email, but cannot own `k`'s fixed-profile PIN policy,
rights provenance, provider capabilities, preflight revisions, or truthful operation
states without creating two competing state machines.

## Decision

Build one TypeScript codebase and image with `web`, `worker`, and `migrate` commands.
Use PostgreSQL as both durable application store and queue. Keep bounded contexts as
modules, not separately deployed packages. Adopt Calibre and EPUBCheck as constrained
tools rather than adopting a library manager as the product boundary.

The `k` repository owns the image; `homelab` owns deployment state.

## Consequences

One release and contract stay coherent, while the worker can be isolated from the
web process and granted narrower egress. PostgreSQL leases and idempotency require
careful tests. Calibre remains replaceable at the process boundary without a generic
conversion framework.

## Rejected alternatives

- **LazyLibrarian/Readarr:** acquisition-first provider models and, for Readarr,
  upstream retirement; neither satisfies the product trust boundary.
- **Calibre-Web Automated facade:** duplicates auth, provenance, and operation truth.
- **Inline side effects in the web process:** request timeouts and unsafe retries.
- **Microservices:** operational cost is unjustified for three users.
