# Threat Model

## Scope and assets

The model covers profile identity, PIN verifiers and pepper, sessions, optional
Kindle addresses, sender authorization, provider credentials, acquired files,
operation/audit history, PostgreSQL, worker egress, and the Calibre/browser toolchain.

The service handles household personal data and externally sourced untrusted files.
It does not hold DRM keys or authorization for unlicensed acquisition.

## Trust boundaries

1. iPhone/e-reader to Traefik over private HTTPS.
2. Traefik to the web pod; forwarded headers are trusted only from configured proxy
   networks.
3. Web and worker processes to PostgreSQL under separate least-privilege roles.
4. Worker to approved metadata, acquisition, and mail origins through constrained
   egress.
5. Worker to untrusted file parsers, Calibre, and EPUBCheck in a restricted process
   boundary.
6. Kubernetes External Secrets to secret environment/files; secret values never enter
   Git, logs, artifacts, or command-line arguments.
7. Web host to fixed OAuth/OIDC authorization, token, identity, Gmail, and Microsoft
   Graph endpoints; issuer, callback, scopes, and resource hosts are deployment-owned.
8. Core to an installed capability child process; only one invocation-scoped access
   token may cross stdin and no durable credential may cross stdout/stderr.

## Threats and controls

| Threat | Control | Verification |
|---|---|---|
| Four-digit PIN brute force | Private network, persistent profile/source throttles, Argon2id plus pepper, generic errors | Lock survives restart; source and profile limits tested |
| PIN setup or recovery takeover | Operator-issued 256-bit, profile/purpose/revision-bound, one-use code; digest only; short expiry; atomic session/code revocation and audit | Wrong profile/purpose/revision, replay, expiry, concurrent redemption, and session revocation tests |
| Session theft/fixation | Random opaque token, digest at rest, `__Host-` cookie, rotation, idle/absolute expiry | Cookie and rotation integration tests |
| CSRF/cross-origin mutation | SameSite=Strict, CSRF token, Origin validation, no CORS | Missing/wrong token and Origin tests |
| Cross-profile IDOR | Profile ownership checked in every command/query | Attempt to read/cancel another profile's operation |
| SSRF/DNS rebinding | Registry-minted targets, exact origin, resolved-IP guard, redirect revalidation, NetworkPolicy/proxy | Private IP, rebind, off-list redirect tests |
| Malicious file/zip bomb | Streaming limits, magic/MIME agreement, archive path/count/ratio limits, encryption rejection | Hostile fixture suite |
| Parser/Calibre compromise | Non-root, no network, read-only root, dropped capabilities, seccomp, bounded resources/time, no plug-ins | Container policy and timeout tests |
| Command injection | Fixed executable and argument arrays; no shell; normalized random paths | Metacharacter filename test |
| Duplicate email | Idempotency key, deterministic Message-ID, persisted `sending`, ambiguity blocks auto-retry | Crash/timeout-at-each-boundary tests |
| OAuth code injection, CSRF, replay, or mix-up | Authorization code only, PKCE S256, one-use state and browser binding, OIDC nonce, exact distinct callback per issuer, issuer/audience validation, no open redirect | Replay, wrong browser/session/issuer/callback/nonce/verifier and consumed-flow tests |
| Refresh-token theft or race | AES-256-GCM with account-bound AAD/key ID, core-only decryption, row-locked refresh/rotation, minimal scopes, no token in plugin response/log/argv | Ciphertext swap, missing key, concurrent refresh, rotated-token, scope downgrade, and redaction tests |
| Provider identity bypasses PIN | Provider accounts can only be connected after session plus recent PIN and cannot create sessions/profiles or satisfy reauthentication | No external-login route; connection start without session/recent PIN fails |
| Account disconnect loses evidence or repeats effects | Revision-bound disconnect preflight and durable operation; block new use, cancel only pre-effect work, retain redacted audit/operation evidence | Stale preflight, running work, partial upstream revocation, and reconnect tests |
| Plugin credential exfiltration | Fixed connector registrations; short-lived scoped token only on stdin; recursive response field denial/redaction; clean environment; reviewed deployment code | Secret-field response, stderr, environment, cross-capability token, and changed-digest tests |
| Duplicate OneDrive file | Operation-owned deterministic `/Apps/k` name, resumable status/fixed-path reconcile, ambiguous commit blocks automatic second name | Lost fragment/final response, name conflict, size mismatch, and reconciliation tests |
| Secret disclosure | AKV/ESO references, redaction, no argv, secret scan | Git/log/process inspection |
| Misleading availability/delivery | Capability class and source timestamp; SMTP acceptance shown as Submitted | Contract and copy tests |
| Storage exhaustion | Per-file and per-profile limits, quarantine cleanup, retention job, readiness check | Oversize and quota tests |

## PIN risk acceptance

Exactly four digits cannot be made equivalent to a full password. The accepted use is
a convenience activation secret inside a private household network. Public ingress,
Cloudflare Tunnel exposure, permissive source ranges, or operation without TLS is a
deployment blocker. A future public-access requirement must replace this ADR with a
phishing-resistant identity mechanism; adding more hashing is not sufficient.

The private boundary is enforced twice: Traefik source-range controls plus
NetworkPolicy, and application middleware that trusts forwarding metadata only from
configured proxy CIDRs and verifies the canonical HTTPS origin and private client
address. `/readyz` fails when this configuration or the PIN pepper is missing. The
deployment gate separately checks public DNS/WAN topology, which the application
cannot infer reliably from inside the cluster.

## Data retention

- Quarantine files are deleted immediately on validation failure.
- Terminal source/output artifacts default to 24-hour retention for safe retry and
  diagnostics, then are deleted.
- Redacted operation and audit evidence is retained for 90 days by default.
- PIN verifiers, sessions, sender tokens, and destination data are never written to
  diagnostic artifacts.

Retention values are deployment configuration with conservative maximums. Deleting
an artifact does not delete immutable redacted audit evidence.

## Residual risks

- A trusted-network attacker can still attempt PIN guessing within throttling bounds.
- The unauthenticated fixed-profile list reveals display names and whether setup is
   required. Lock timing is returned only after an unlock attempt, but that response
   still reveals a bounded delay to a private-network caller.
- Calibre and browser engines process complex untrusted formats; sandboxing reduces
  but does not eliminate parser risk.
- SMTP acceptance cannot prove Amazon/device delivery.
- Gmail acceptance cannot prove Amazon/device delivery; OneDrive storage cannot prove
   synchronization to any reader.
- OAuth refresh tokens grant offline provider access; encryption and least privilege
   reduce but do not eliminate harm if both the database and active keyring are stolen.
- Operator-installed plugins are trusted code. Process isolation prevents accidental
   protocol/secret spread but does not sandbox a malicious deployment review bypass.
- Public-domain status varies by jurisdiction; each acquisition provider requires an
  operator review appropriate to the deployment jurisdiction.
