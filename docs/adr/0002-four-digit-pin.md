# ADR-0002: Four-digit PIN within a private-network boundary

- Status: Accepted risk
- Date: 2026-07-17

## Context

The household requires profile selection plus exactly four decimal digits to replace
normal login. The credential has only $10^4$ values, about $13.3$ bits of entropy,
and cannot safely authenticate a public internet service by itself.

## Decision

Use the PIN only over private LAN/VPN HTTPS. Store a unique-salt Argon2id verifier
plus an independently stored pepper. Persist profile- and source-scoped throttles and
lock escalation across restarts. Use short opaque server sessions and require a fresh
PIN before destination or delivery mutations.

Production readiness fails closed if trusted-proxy/private-network configuration,
the PIN pepper, or TLS routing is absent. The application must never describe this
mechanism as NIST AAL1-compliant.

Profiles have no default credential. An operator-only CLI generates a 256-bit,
single-use setup or recovery code, stores only its digest, and prints the value once.
The code expires after 15 minutes by default and is bound to profile, purpose, and
credential revision. Redeeming it atomically sets the PIN, consumes outstanding
codes, increments the revision, revokes sessions, resets throttles, and writes a
redacted audit event. There is no unauthenticated first-user claim or remote
forgot-PIN flow.

Issuing a recovery code first increments the credential revision, marks the profile
`recovery-required`, revokes every session, disables ordinary PIN login, consumes any
older code, and writes an audit event. Expiry remains fail-closed; only a replacement
operator-issued code can complete recovery.

## Controls

- PIN input is a string matching `^[0-9]{4}$`; leading zeroes are retained.
- Setup rejects common PINs and duplicate PINs across household profiles.
- Progressive delay starts after three failures; five failures in 15 minutes lock
  the profile for 15 minutes, then one hour and 24 hours on repeated windows.
- Ten failures per source in one hour block that source independently.
- Sessions store only a SHA-256 token digest, use a `__Host-` Secure/HttpOnly/
  SameSite=Strict cookie, expire after 30 idle minutes or 12 absolute hours, and
  rotate on login and reauthentication.
- All mutations require CSRF and same-origin validation.
- PIN setup and change reject a maintained weak-PIN deny list and a PIN already used
  by another household profile.
- The exact HTTPS origin, trusted proxy ranges, and private client ranges are required
  configuration. Requests outside that boundary are rejected before authentication,
  and readiness fails if the boundary cannot be configured safely.

## Rejected alternatives

- **Public PIN endpoint:** brute-force risk is intrinsic and cannot be hashed away.
- **OIDC for household login:** conflicts with the selected low-friction interaction.
- **PIN in Authentik:** adds a second session system without improving PIN entropy.
- **Device-local PIN only:** cannot support multiple browsers or server-side jobs.
- **Default or first-visitor PIN setup:** permits profile takeover before the intended
  household member arrives.
- **Email/SMS reset:** adds another identity and delivery system solely for recovery;
  the private operator CLI is smaller and keeps recovery out of the public surface.
