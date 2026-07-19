# ADR-0006: Capability plugins and provider accounts

- Status: Accepted
- Date: 2026-07-18
- Extends: ADR-0005 installed source plugins
- Preserves: ADR-0002 four-digit PIN authentication

## User-visible outcome

After this decision is implemented, a household member can connect an approved
provider account, see sourced metadata and provider limitations, and choose an
installed delivery destination without changing how they unlock `k`. An independent
developer can implement the same reviewed capability contract for another lawful
catalog, metadata/review service, mail service, or drive.

## Context

ADR-0005 introduced three operator-installed source plugins with one strict protocol
for book search, detail, and public-domain EPUB acquisition. The next concrete
providers do not all behave like book sources:

- Google Books enriches an edition with public metadata, including an average rating
  and rating count, but does not grant acquisition rights.
- Login with Amazon can resolve an Amazon profile identity, but does not expose Kindle
  purchases, library access, or Kindle Unlimited entitlement.
- Gmail can submit a MIME message using the narrow `gmail.send` scope.
- Microsoft identity can authorize a OneDrive destination using Microsoft Graph.
- Goodreads has no supported new integration path and its terms prohibit data-mining
  and scraping fallbacks.
- Amazon product availability is available only to eligible operators through the
  current Creators API. PA-API is retired and no supported API exposes a trustworthy
  Kindle Unlimited entitlement signal.

Adding a provider branch to Catalog or Delivery for every service would duplicate
OAuth, credential storage, support states, preflight revision checks, and operation
evidence. Allowing each plugin to implement OAuth and retain refresh tokens would
move the most security-sensitive state into multiple operator codebases.

The household also wants the plugin contract to be a real example for future lawful
movie catalogs/acquisition sources, review providers, mail transports, and drives.
That requirement justifies media-aware capability descriptors, but not a movie
pipeline, generic crawler, remote marketplace, or arbitrary URL execution.

## Decision

### Installation and activation

Plugin code remains an operator/deployment concern. A plugin is a reviewed directory
under `PLUGIN_DIR`; directory presence means installed and active. Household users
cannot install, enable, disable, upload, or configure plugin code. They may connect
provider accounts and select ready destinations exposed by installed capabilities.

There is no remote marketplace, package downloader, dynamic registration endpoint,
or caller-supplied executable configuration.

### Version coexistence

Schema version 1 and wire protocol version 1 remain supported exactly as ADR-0005
defines them. The three existing source manifests and requests are not rewritten.
Core normalizes each v1 plugin internally to this descriptor:

- family: `catalog-source`
- capability version: `1`
- media kinds: `book`
- commands: `catalog.search`, `catalog.detail`, `catalog.acquire`
- rights basis: `public-domain`

The compatibility adapter maps those canonical commands to the existing `search`,
`detail`, and `acquire` protocol-v1 commands.

New plugins use strict manifest schema version 2 and wire protocol version 2. A v2
manifest contains one or more typed capability descriptors. Each descriptor has a
stable `capabilityId`, family, version, declared commands, media kinds or artifact
media types, and an authorization requirement. Runtime limits and policy-review
evidence apply to the installed manifest as a whole.
Unknown fields, families, versions, commands, media kinds, authorization modes, and
host patterns fail discovery.

The initial families are concrete uses, not an open-ended type registry:

| Family | Required command | Optional commands | Current example |
|---|---|---|---|
| `catalog-source@1` | `catalog.search` | `catalog.detail`, `catalog.acquire` | Existing source-v1 adapter |
| `metadata-enricher@1` | `metadata.enrich` | none | Google Books |
| `identity-provider@1` | `identity.resolve` | none | Login with Amazon, Google, Microsoft |
| `mail-sender@1` | `mail.send` | `mail.preflight` | Gmail API |
| `delivery-destination@1` | `destination.deliver` | `destination.preflight`, `destination.reconcile` | OneDrive |

`book` and `movie` are valid catalog/metadata media kinds because both are current
requirements. Host capability remains separate from plugin declaration: this release
supports book metadata and EPUB acquisition/delivery. A movie capability can be
validated and listed, but reports `unsupported` until a signed-off movie artifact and
rights pipeline exists. It never silently enters the EPUB worker.

### Process contract

Core starts one short-lived child process per invocation with a clean environment and
one JSON request on stdin. Protocol v2 adds an invocation ID, selected capability ID,
and command to the envelope. The request contains no caller-controlled network URL,
OAuth endpoint, redirect URI, request header, cookie, selector, destination path, or
remote storage path.

Only a command declared by the selected capability may run. Core supplies any random
quarantine path, deterministic operation key, bounded artifact path, and fixed
provider registration. A credentialed invocation receives only the short-lived access
or API token needed for that command through stdin. It never receives a refresh token,
OAuth client secret, token-encryption key, `k` session token, another capability's
credential, or the parent process environment.

Plugin stdout is one bounded protocol response. Stderr is bounded, treated as
untrusted diagnostics, and never returned verbatim to a client. Core redacts known
credential values before writing diagnostics. Result schemas contain no token,
credential, secret, cookie, or arbitrary executable URL fields.

Operator-installed plugins are trusted code, not a hostile-code sandbox. Process
separation bounds protocol input/output and accidental secret exposure; deployment
review and container isolation remain the trust controls for code execution.

### Identity remains PIN-only

External provider identities are account connections only. They do not unlock `k`,
create or claim a household profile, recover a PIN, mint a `k` session, satisfy recent
PIN authentication, or confer Amazon/Google/Microsoft entitlement.

Every connection belongs to the already authenticated fixed profile that started the
flow. Starting, reconnecting, or disconnecting an account requires a current `k`
session, exact Origin and CSRF validation, and recent PIN authentication. Provider
email or display name is never used as a stable identity. Where OIDC applies, the
stable external key is the exact `(issuer, subject)` pair.

This preserves ADR-0002. A future decision to use external login would require a new
threat model and a superseding ADR; it is not part of this capability platform.

### Server-rendered OAuth flow

OAuth uses a maintained OAuth/OIDC library and the authorization-code flow in the web
host. No browser JavaScript, popup, implicit flow, token fragment, or provider SDK is
required.

1. A same-origin POST form starts a connection after session, recent-PIN, Origin, and
   CSRF checks.
2. Core creates a ten-minute, one-use authorization transaction bound to profile,
   current session, connector, exact issuer, exact callback URI, requested scopes,
   plugin digest, and a random browser binding.
3. Core creates a transaction-specific PKCE verifier with at least 256 bits of entropy,
   sends only its `S256` challenge, and creates a transaction-specific OIDC nonce when
   the connector uses OIDC.
4. State is a random opaque value. Only its digest is stored. An HttpOnly, Secure,
   SameSite=Lax `__Host-k.oauth` cookie contains a separate random browser value whose
   digest is stored with the transaction. The ordinary `__Host-k.sid` cookie remains
   SameSite=Strict and is not expected on the cross-site callback.
5. Core returns `303 See Other` to the deployment-registered authorization endpoint.
6. Each connector has a distinct, exact HTTPS callback path. The callback validates
   state, browser binding, expiry, unused status, connector/issuer, stored session
   validity, and fixed redirect URI before exchanging the code with the stored PKCE
   verifier. There is no `next` or caller-controlled redirect parameter.
7. OIDC responses validate signature, issuer, audience, expiry, issued-at time, nonce,
   and authorized party where present. UserInfo `sub` must exactly match the ID token.
   Non-OIDC identity resolution uses only the fixed reviewed connector endpoint.
8. The transaction is consumed once whether the provider approves or denies access.
   A failed exchange requires a new transaction rather than replay.
9. The callback stores the account grant, clears the OAuth cookie, and immediately
   redirects with `303` to a fixed local completion route that contains no code, state,
   token, provider error text, or external target. Callback and completion responses
   use `Cache-Control: no-store` and `Referrer-Policy: no-referrer`; the callback renders
   no third-party resources.

Distinct callback paths plus exact stored issuer checks provide OAuth mix-up defense.
The flow follows RFC 9700 Sections 2.1, 2.3, 4.2, 4.4, 4.5, 4.7, and 4.14; RFC 7636
Sections 4.1-4.6; and OpenID Connect Core Sections 2, 3.1, 5.3.2, 5.7, 11, and 12.

### Token custody and rotation

OAuth client IDs, client secrets, connector endpoints, redirect URIs, and allowed
scopes are deployment registrations selected by a fixed `registrationId`. A manifest
cannot supply or override them. Secret values come from the deployment secret store
and never enter Git, logs, run artifacts, URLs, or command arguments.

Access and refresh tokens are encrypted independently using AES-256-GCM. Each value
has a random nonce, authentication tag, and key ID. Additional authenticated data
binds ciphertext to profile ID, account ID, connector ID, token kind, and grant
revision. The keyring is supplied by secret file or environment reference and has one
active encryption key plus optional decrypt-only previous keys.

Rotation first adds a new active key, then re-encrypts rows under account row locks,
then verifies no row references the old key. Removing a referenced key is a readiness
failure and is prohibited. Token plaintext is held only for the provider request or
single plugin invocation and is not cached in application DTOs.

One core refresh path owns refresh-token use. It locks the account row, rechecks grant
revision and scopes, refreshes, and atomically replaces access and rotated refresh
tokens. Transparent access-token refresh does not change grant revision. Reconnect,
reauthorization, subject change, granted-scope change, or disconnect increments the
grant revision and invalidates dependent preflights and queued external effects.

Missing required scopes produces `expired-or-revoked` or `account-required`; it never
falls back to a broader scope or another account.
Per RFC 6749 Section 5.1, an omitted token-response `scope` means the granted scope is
identical to the requested scope. When `scope` is present, its set must equal the
approved request exactly; missing, additional, or duplicate values fail the exchange.

Connector registrations are deployment-owned JSON loaded from the file named by
`PROVIDER_REGISTRATIONS_FILE`. The strict versioned document records connector ID,
registration ID, exact issuer, authorization/token/identity/revocation endpoints,
fixed JWKS endpoint for OIDC connectors,
client ID, an explicit `client_secret_post` or `client_secret_basic` token endpoint
authentication method, a client-secret environment reference, one exact callback path, installed
plugin/capability IDs, whether OIDC applies, and a fixed requested-capability-to-scope
map. Every endpoint host must appear in the reviewed plugin manifest. Phase 3 may
request `identity-only` for Google and Login with Amazon; Gmail send and OneDrive
scopes remain unavailable until Phase 4.

The token keyring is deployment-owned JSON loaded from
`PROVIDER_TOKEN_KEYRING_FILE`. It is strict and versioned, names exactly one active
key ID plus optional decrypt-only key IDs, and obtains each 32-byte key from a named
environment reference. The provider-subject HMAC key is read as exactly 32 raw bytes
from `PROVIDER_SUBJECT_HASH_KEY_FILE`. Key bytes and client secrets never appear in
the JSON documents, Git, logs, URLs, arguments, DTOs, or run artifacts.

Each profile has at most one account per connector. A stable subject HMAC is unique
within a connector across profiles, so one external identity cannot silently attach
to two household profiles. At most one open authorization transaction exists per
profile and connector; starting another atomically consumes the prior transaction as
`superseded`. Consumed transactions retain only digests, connector/session references,
outcome, and timestamps for seven days. PKCE verifiers and OIDC nonces are cleared at
consumption, after which retention cleanup deletes the row.

`provider_accounts` stores access and refresh ciphertext in separate bytea columns,
with separate 12-byte nonces, 16-byte tags, and key IDs. Token expiry is a timestamp;
no ID token is persisted. The row also stores connector ID, exact issuer, subject HMAC,
masked label, granted scopes/capabilities JSON arrays, state, grant revision,
connection/validation timestamps, and block-new-use time. AAD is the UTF-8 sequence
`k-provider-token-v1\0<profileId>\0<accountId>\0<connectorId>\0<kind>\0<revision>`.
Before an account exists, the PKCE verifier uses the separate authorization-bound AAD
`k-provider-authorization-v1\0<profileId>\0<authorizationId>\0<connectorId>\0pkce`.
The OIDC nonce is encrypted independently with the same authorization-bound sequence
ending in `oidc-nonce`; its retained digest is verified when claimed. Neither value is
stored in plaintext, and both are cleared when the transaction is consumed. The flow
never invents or persists a provisional provider account.

### Account and capability states

Provider deployment support and profile connection state are separate:

- provider availability: `available`, `configuration-required`,
  `eligibility-required`, `unavailable`, `unsupported`, or `not-exposed`;
- account state: `not-configured`, `connecting`, `connected`,
  `expired-or-revoked`, or `error`;
- destination state: `not-configured`, `ready`, `blocked`, or `error`.

Every state includes source, checked-at time, scope, reason code, and human reason.
`unsupported` and `not-exposed` are static policy evidence and do not make an
otherwise successful catalog search partial. `unavailable` is reserved for an
expected live provider that failed during the current request.

A connected account records only a masked account label, provider namespace, an HMAC
of the stable provider subject for uniqueness, granted scopes, capabilities,
grant revision, state, and timestamps. Raw provider subjects and tokens are not public
DTO fields. ID tokens are validated and discarded.

`authorizationPending` is independent from account state. A first connection has
state `connecting`, no account ID, and `authorizationPending=true`. Reconnect keeps
the existing account `connected` and usable at its current account ID and revision
while `authorizationPending=true`; replacement credentials become visible only after
a completely successful callback.

### Disconnect semantics

Disconnect is a preflighted durable operation, not a delete button.

The disconnect preflight reports the connector and masked account, destinations that
will be blocked, queued/running operations bound to the grant, whether upstream
revocation affects other scopes for the provider project, blockers, warnings,
recovery instructions, and expiry. Submission requires recent PIN and the unexpired
single-use preflight.

The durable `disconnect-account` operation:

1. blocks new preflights for the grant;
2. requests upstream revocation when the provider supports it;
3. increments grant revision and removes local encrypted credentials;
4. blocks dependent destinations;
5. cancels queued/waiting operations that have not begun an external effect and lets
   running work recheck the revision before any effect; and
6. appends a redacted audit receipt.

Local credential removal completes even if upstream revocation is rejected or cannot
be confirmed. That outcome is `partial`, with a provider-settings remediation link
label but no caller-supplied URL. Audit evidence distinguishes `revoked`,
`revocation-not-supported`, and `revocation-unknown`. Reconnect writes new credentials
only after a completely successful callback, so an existing valid connection remains
usable while a replacement transaction is pending.

### Metadata and availability evidence

Metadata enrichment is additive. A contribution identifies provider, provider record,
media kind, matched identifier or normalized title/creator strategy, match quality,
contributed fields, checked-at time, and provider information link. Core permits the
information link only after HTTPS host validation against the reviewed manifest. It is
never an acquisition URL.

Google Books may contribute bibliographic fields, `averageRating`, and
`ratingsCount`. Ratings retain their provider label and 1-5 scale. A weak match is not
attached to a source item. Metadata never changes source rights, acquisition options,
or deliverability.

Core attaches metadata only after an exact identifier match or an exact normalized
title-and-primary-creator match. Identifier lookup must return exactly one record with
the requested identifier. Title/creator lookup must return exactly one record whose
Unicode-normalized, case-folded, whitespace-collapsed title and primary creator equal
the source values. Zero exact candidates returns `NO_EXACT_MATCH`; multiple exact
candidates return `AMBIGUOUS_MATCH`. Fuzzy or probabilistic matches are never attached
in this phase.

Goodreads is `unsupported`; there is no Goodreads command or scraping fallback.
Amazon product availability is `eligibility-required` until the operator has current
Creators API access and reviewed response fixtures. Login with Amazon is
`identity-provider` only. Kindle Unlimited is `not-exposed`, never `false` or
`unavailable`.

Static support records use stable policy capability IDs and codes:

- `provider-policy/goodreads-reviews`: `policy-only`, `unsupported`,
  `GOODREADS_API_UNAVAILABLE`;
- `provider-policy/amazon-product-availability`: `policy-only`,
  `eligibility-required`, `AMAZON_CREATORS_ELIGIBILITY_REQUIRED`;
- `provider-policy/kindle-unlimited`: `policy-only`, `not-exposed`,
  `KINDLE_UNLIMITED_NOT_EXPOSED`.

Installed and callable capabilities use maturity `stable`; an installed capability
whose fixed deployment registration is absent uses `configuration-required` with
`CONNECTOR_CONFIGURATION_REQUIRED`. A configured provider that fails during the
current request uses `unavailable` with `PROVIDER_REQUEST_FAILED`; this live state may
make catalog results partial, while static policy records never do.

### Mail and destination effects

A delivery destination owns `preflight`, `deliver`, and optional `reconcile` behavior.
Core supplies a validated local artifact and plugin-owned fixed destination context.
No caller may choose a remote path. Existing Kindle email remains a destination that
uses either the deployment SMTP sender or a connected Gmail mail sender. OneDrive
uses delegated, generally available `Files.ReadWrite`; core and the plugin restrict
writes to the fixed user-visible `/Apps/k` folder. The preview
`Files.ReadWrite.AppFolder` permission is not used.

A delivery preflight snapshots source plugin digest, selected destination ID and
revision, sender or provider account ID and grant revision, readiness, artifact limit,
and planned stages. The worker rechecks every snapshot before the first external
effect.

Gmail uses only `gmail.send` plus the minimum identity/offline scopes required to hold
the connection. Core creates the MIME message and deterministic RFC Message-ID. A
successful `users.messages.send` response means `provider-accepted`, not Amazon or
device receipt. A timeout, connection loss, or process crash after the request body may
have reached Google but before a valid message ID is persisted becomes
`blocked/delivery-unknown`. The narrow send-only grant cannot query Sent mail, so this
state is never automatically resent or falsely reconciled.

OneDrive uses an operation-owned deterministic filename under `/Apps/k`. Uploads at or
below 10 MiB may use one fixed-path PUT; larger files use an upload session with
sequential 320 KiB-aligned fragments. Lost fragment responses are reconciled through
the upload-session status. After a lost final response, the destination plugin reads
the deterministic path and accepts success only when the operation-owned name and
expected size match. A confirmed Graph `driveItem` means `provider-stored`, not synced
to an e-reader or other device. If reconciliation cannot distinguish committed from
uncommitted, the operation becomes `blocked/delivery-unknown` and creates no second
filename automatically.

Destination evidence is a tagged union:

- Kindle email: transport, `not-submitted`, `provider-accepted`, `bounced`,
  `rejected`, `unknown`, or `user-confirmed-received`, provider message ID, source,
  and recorded time;
- OneDrive: `not-uploaded`, `uploading`, `provider-stored`, or `unknown`, drive item
  ID, operation-owned name, size, eTag, provider request ID, source, and recorded time.

Receipt confirmation remains available only for Kindle email after provider
acceptance. Retry/rerun controls remain absent unless a later contract proves the
specific external effect safe.

### Data evolution and rollback

Migrations use expand, migrate, contract:

1. add capability/account/authorization-transaction/destination tables and nullable
   revision snapshots;
2. backfill each existing Kindle address and SMTP sender as destination/sender records
   while dual-reading the existing columns for one release;
3. add tagged destination evidence and disconnect operation stages;
4. contract legacy columns only in a later separately approved release.

Migration down paths are allowed only while no provider account, authorization
transaction, non-legacy destination, or typed operation evidence exists. After durable
writes, down migration raises SQLSTATE `55000`. Rollback is the prior compatible
binary or a forward fix, with a verified PostgreSQL backup restore for schema/data
rollback. No rollback silently deletes grants, operations, destinations, or evidence.

Phase 3 expands only authorization transactions, provider accounts, metadata cache,
and audit target kinds. Durable account-disconnect operations remain Phase 4 together
with generalized destinations and operation evidence. Phase 3 exposes disconnect
impact as a non-mutating preview and keeps `canDisconnect=false`; it does not coerce
account effects into current delivery-only operation tables. Down migration is allowed
only while no authorization transaction, provider account, or metadata contribution
has been written; otherwise it raises SQLSTATE `55000`.

Optional provider absence does not fail global readiness. Readiness fails when stored
grants cannot be decrypted, a referenced key is missing, schema prerequisites are
invalid, or a configured mandatory connector violates its fixed registration.

### SSR and no-JavaScript behavior

The three-route authenticated information architecture remains Search, Activity, and
Profile. The existing BookSearch, ProfileSettings, DeliveryPreflight, and
OperationTimeline components are extended rather than replaced.

Connect, reconnect, disconnect preflight, destination choice, operation submission,
and callback completion all work with ordinary forms and Post/Redirect/Get. Provider
consent pages may require capabilities imposed by that provider, but `k` itself does
not require JavaScript. Unsupported, configuration-required, eligibility-required,
expired/revoked, partial, blocked, and unknown states remain visible in semantic HTML
with source, time, scope, reason, and remediation.

### Developer kit

The developer kit is extracted only after the internal providers exercise every
family. It contains the exact production JSON Schemas, TypeScript contracts, runtime
helper, validator CLI, fixtures, conformance tests, and Diataxis tutorial/how-to/
reference/explanation. Templates invoke the production validator and fake host. It
contains no installer, marketplace, remote activation, credential store, or bypass for
operator review.

## Standards and adoption

- OAuth follows RFC 9700, RFC 7636, RFC 8414, RFC 9207 where supported, and OpenID
  Connect Core rather than a custom protocol.
- `openid-client` is selected for the server-side authorization-code/OIDC client. It
  directly supports issuer metadata, PKCE, ID-token validation, and refresh handling.
  `oauth4webapi` is a lower-level viable alternative but would require more protocol
  assembly in application code. Passport strategies were rejected because provider-
  specific login middleware does not fit account-connection-only flows or core-owned
  grants.
- Gmail uses RFC 5322/MIME through the documented Gmail API.
- Existing source plugins continue to use OPDS and official provider APIs where
  available.
- A small capability process protocol remains local because no adopted library
  combines deployment-controlled activation, opaque IDs, quarantine paths, profile-
  owned grants, and this application's rights boundary.

## Consequences

Adding a provider requires both a reviewed installed plugin and, when applicable, a
fixed deployment registration. Removing a plugin removes its capability after restart;
disconnecting an account removes only the profile grant and blocks dependents.

Core gains security-sensitive token custody and migration responsibilities, but those
controls exist once instead of being reimplemented by each plugin. The child-process
boundary limits accidental credential spread but does not make unreviewed code safe.

The schema is media-aware, while runtime support remains honest and book-focused.
Future movie work must add a signed-off rights/file pipeline and tests before changing
host support from `unsupported`.

## Rejected alternatives

- Provider-specific branches in Catalog and Delivery: quick initially, but duplicate
  account, state, revision, and evidence behavior.
- Plugin-owned OAuth and refresh tokens: duplicates security protocol and exposes
  durable credentials to every provider implementation.
- External provider login for `k`: contradicts PIN-only household identity and widens
  the authentication threat model without a current requirement.
- One generic `provider` capability: hides materially different trust and effect
  semantics and cannot enforce command-specific contracts.
- Preview OneDrive app-folder permission: narrower, but its preview stability is not
  acceptable for the reference integration; GA `Files.ReadWrite` is constrained by a
  fixed application path.
- Remote plugin marketplace or user activation: violates deployment-controlled review.
- Generic crawler/browser or arbitrary URL recipes: unbounded policy and SSRF surface.
- Waiting for live credentials: registrations are needed for activation, not for
  contract design or deterministic fake-provider implementation.
