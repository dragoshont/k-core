# Browser-only deployment plan

## Status and outcome

This is a generic operator how-to for the later GitOps deployment phase. Phase 8 is
plan-only: no cluster, DNS, certificate, secret, database, or workload change has been
applied, and this document does not claim that a deployment exists.

After a separately approved deployment, a member on the private LAN or VPN can open
`${PUBLIC_ORIGIN}` and use the server-rendered profile, search, metadata, and reviewed
account-connection surfaces. Delivery and provider effects remain unavailable until
their configuration and authorization gates pass.

## Intended deployment contract

- DNS maps the host in `${PUBLIC_ORIGIN}` to `<cluster-ip>` without exposing it through
  a public proxy or WAN port forward.
- The ingress accepts only the intended LAN/VPN path, terminates HTTPS, and forwards
  through CIDRs listed in `TRUSTED_PROXY_CIDRS`.
- The workload runs one non-root web replica from `<immutable-image-digest>`.
- PostgreSQL 16 uses persistent storage and credentials from `<database-secret-ref>`.
- A one-shot, pre-deploy migration Job runs `node build/server/bin/migrate.js` from the
  same immutable image. The web Deployment starts only after that Job succeeds.
- Application keys come from `<application-secret-ref>` through the deployment's
  secret controller. Values never enter Git, image layers, manifests, or command
  arguments.
- The public plugin root is the reviewed content bundled at `/app/plugins`.
- Optional provider registration and keyring documents are projected read-only from
  generic configuration and secret references. Missing integrations report
  configuration required.

The migration Job is preferred over an init container because it runs once per image
rollout and gives the deployment controller an explicit success/failure gate. It must
use the same `PROFILE_CONFIG_FILE` projection as the web process whenever aliases are
not the neutral defaults.

## Required configuration

Provide these values through the approved configuration and secret mechanisms:

- `DATABASE_URL`
- `PUBLIC_ORIGIN=${PUBLIC_ORIGIN}`
- `TRUSTED_PROXY_CIDRS=<trusted-proxy-cidrs>`
- `ALLOWED_PRIVATE_CLIENT_CIDRS=<lan-or-vpn-cidrs>`
- `OUTBOUND_CONTACT=<operator-contact>`
- `PIN_PEPPER`
- `PIN_REUSE_SECRET`
- `SESSION_SIGNING_KEY`
- `SOURCE_HASH_SECRET`
- `PUBLIC_PLUGIN_DIR=/app/plugins`
- optional `PROFILE_CONFIG_FILE=<profile-config-path>`

Generate each application security key independently with at least 32 random bytes.
Do not reuse the database password for an application key. Keep the profile document
non-secret and validate it against `contracts/profile-config.schema.json` before the
migration Job starts.

## Plan verification

Before requesting approval for any live reconcile:

1. Pin `<immutable-image-digest>`; do not use a mutable tag.
2. Run `./scripts/phase6-image-gate.sh k:phase6` against the candidate source.
3. Render the proposed GitOps manifests without applying them.
4. Validate the rendered manifests with the repository's schema and policy tools.
5. Confirm the migration Job and web Deployment use the same profile configuration.
6. Confirm ingress and network policy restrict clients to the intended LAN/VPN path.
7. Confirm all secret values are references, not manifest literals.

After a future human-approved reconcile, an operator would verify the database,
migration Job, web readiness, `${PUBLIC_ORIGIN}/unlock`, and the absence of an
unapproved public route. Those are future runtime checks, not current evidence.

## Rollback plan

- Application: restore the prior immutable image digest and reconcile.
- Database: use a verified backup/restore procedure before any schema rollback.
  Migration 0007 has an approved guarded down path for alias reconciliation, but an
  operator must not improvise a destructive rollback after durable writes.
- Exposure: remove the ingress route before removing DNS.
- Secrets: restore prior secret versions, wait for the secret controller to report
  ready, then restart only through the approved GitOps operation.

STOP: Phase 8 remains plan-only. A human must separately approve the exact DNS,
secret, database, and cluster mutations before any live apply or reconcile.
