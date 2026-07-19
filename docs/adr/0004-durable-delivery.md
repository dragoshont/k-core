# ADR-0004: Durable operations and ambiguous email handling

- Status: Accepted
- Date: 2026-07-17

## Context

Acquisition, validation, conversion, and email can outlive an HTTP request and can
fail between external side effects and database commits. Retrying an uncertain email
submission may send the same book twice.

## Decision

Represent every acquire-and-send request as a PostgreSQL-backed operation with
ordered stages, leases, evidence, and an idempotency key. Bind the operation to an
expiring preflight snapshot and destination revision. Recheck the destination and
sender immediately before email.

Write a delivery attempt and deterministic Message-ID before SMTP. SMTP acceptance
ends the pipeline as `succeeded`, presented as **Submitted**. A timeout or crash after
possible acceptance becomes `blocked` with `DELIVERY_UNKNOWN`; only a fresh human
confirmation may create a new send operation.

## Consequences

Jobs survive navigation, logout, worker restart, and browser sleep. Retry semantics
are stage-specific. The product cannot claim Kindle receipt without separate user
confirmation.

## Rejected alternatives

- **In-memory queue:** loses work and lockouts on restart.
- **Automatic whole-job retry:** may duplicate mail and repeat unsafe acquisition.
- **SMTP 250 means delivered:** overstates evidence outside the application's control.
- **Redis/BullMQ:** a second stateful service is unnecessary while PostgreSQL can
  provide leases and `SKIP LOCKED` claims.
