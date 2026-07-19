# UI Design Specification

## Product language

The interface is a quiet household utility, not a library dashboard or storefront.
Book title, author, edition, source, capability, and operation evidence are primary.
Decorative metrics, charts, nested cards, promotional copy, and invented availability
are excluded.

The visual direction is **paper, ink, moss, and brass**: warm near-white reading
surface, black-green text, restrained green actions, brass focus/accent, and red only
for destructive or failed states. Georgia gives book titles a literary voice; Verdana
keeps compact controls highly legible without a web-font request. Corners stay at 6px
or below. Lists use rules and whitespace rather than floating card sections.

## Supported surfaces

- iPhone Safari is primary at 320-430 CSS pixels.
- Modern desktop browsers receive the same narrow reading column plus more whitespace.
- Constrained e-reader browsers receive server-rendered semantic HTML with no required
  JavaScript, no animation, no web fonts, and manual-refresh operation status.
- If a client cannot negotiate current TLS, the service does not downgrade security.

## Information architecture

Authenticated navigation contains three destinations:

1. **Search**: query, partial-source notice, book results, and edition details.
2. **Activity**: current and recent operations with source/timestamp evidence.
3. **Profile**: masked delivery destinations, provider account connections, read-only
   installed capability inventory, session, and PIN changes.

Unauthenticated users see a profile picker followed by a single four-digit PIN field.
No account-creation, email-login, or password-reset surface exists.

Initial setup and recovery are not first-visitor claims. An operator gives the
intended household member a short-lived, high-entropy credential code out of band.
The Setup page accepts that code, a new four-digit PIN, and confirmation; it never
places either value in a URL. Generic errors cover wrong, expired, replayed, or
profile-mismatched codes. Successful setup returns to Unlock and invalidates any
existing session for that profile.

Every route has a page-level Storybook composition in addition to isolated component
stories: Unlock, Setup, Search, Book Detail, Delivery Preflight, Recent
Authentication, Activity Empty/List, Operation Detail, and Profile. Each composition
has one `<main>`, one `<h1>`, a descriptive document title, a skip link, and the same
semantic navigation used by the server-rendered route.

`Pages/SearchEReader` and `Pages/OperationDetailEReader` are representative full-page
constrained-browser compositions. They reuse the same content components and contract
fixtures while rendering stacked controls, manual Refresh, and no sticky positioning,
polling, animation, or JavaScript-only action. Other route compositions follow the
same named `eReader` variant rules in the design map.

## Core flow

1. Select Member 1, Member 2, or Member 3.
2. Enter the four-digit PIN and choose **Unlock**.
3. Search by title, author, or ISBN.
4. Inspect normalized installed-plugin results. Candidate results show **Check
   availability** and name the public-domain source and evidence time.
5. Review preflight: exact edition/language, source and checked time, rights basis,
   format/conversion plan, masked destination, sender readiness, prior submissions,
   blockers, warnings, and planned stages.
6. Re-enter the PIN if the session is not recently authenticated, then choose a
   specific action such as **Acquire and send to Member 2's Kindle**.
7. Land on Activity with an operation receipt and stage timeline.

Provider account connection does not add a login route. A profile first unlocks with
its PIN, confirms the PIN again, and submits an ordinary Profile form. The server uses
an authorization-code redirect and returns to a fixed Profile completion route. The
flow requires no `k` JavaScript and never creates a profile, unlocks `k`, or satisfies
recent authentication. Provider consent pages may impose their own browser support.

## Components and states

### ApplicationShell

Compact wordmark `k`, profile name, semantic navigation, and main content. On narrow
screens and e-readers, navigation is a stable three-item row in normal document flow
below the header. It never overlays content or focus targets. No hamburger is required
for three destinations.

### ProfilePicker, PinUnlockForm, and PinSetupForm

Three full-width profile buttons, then one labeled `inputmode="numeric"` PIN field
with paste/autofill support. Do not split digits or auto-submit. States: ready,
submitting, invalid, delayed with `retryAt`, and recent authentication. A profile
whose credential is setup-required or recovery-required remains a ProfilePicker state
rather than entering PinUnlockForm. Errors are generic and preserve the selected
profile. PinSetupForm uses ordinary labeled fields for the one-time credential code,
new PIN, and confirmation; it never offers an unauthenticated first-user claim.

### SearchForm and SearchResult

One labeled search input and Search button. Results are unframed list rows with a
stable cover placeholder, title, author, edition summary, source/freshness, and a
textual capability badge. States: idle, loading, results, partial, no results, all
sources failed.

Book detail may show additive metadata and ratings with provider, match basis,
checked time, contributed fields, and provider information link. Ratings never change
rights or acquisition capability. Static provider limitations are visible without
turning a successful search into a partial failure: Goodreads is **Unsupported**,
Amazon product availability may be **Operator eligibility required**, and Kindle
Unlimited is **Not exposed by provider** rather than unavailable.

### DeliveryPreflight

An unframed review page with definition lists for edition, source, destination,
rights, planned stages, limits, and previous sends. Blockers precede warnings. The
primary action names the profile and consequence. No delivery action appears without
a current backend preflight. In Phase 3 the only active destination is the existing
Kindle address through the household SMTP sender.

**Phase 4 target, not active in Phase 3:** when more than one destination exists, Book Detail uses a radio fieldset. Blocked
destinations remain visible and disabled with a reason. Preflight names the selected
destination and exact external effect: **Acquire and send to Member 2's Kindle** or
**Acquire and save to Member 2's OneDrive**. Destination and account revision changes
expire the check before any effect.

### OperationTimeline

Ordered stages show queued/running/blocked/succeeded/failed with source and timestamp.
Percent is shown only for measurable byte transfer; otherwise use stage position.
Failed or blocked stages expose a human reason, remediation, correlation ID, and safe
cancel behavior. Operation status, stage status, and destination evidence remain three
independent axes. **Submitted** derives only from SMTP or Gmail provider acceptance;
**Received** derives only from explicit `user-confirmed-received` evidence. Retry and
rerun controls remain absent until their mutation endpoints exist.

In Phase 3, **Submitted** derives only from SMTP acceptance. **Phase 4 target, not
active in Phase 3:** Gmail acceptance is labeled **Submitted by Gmail**, not received by Amazon. A Graph
drive-item response is **Saved to OneDrive**, not synchronized to a device. Gmail or
OneDrive ambiguity is **Unknown** and blocked from automatic repetition.

### ProfileSettings

Kindle address is optional. Empty state says search remains available. Address changes
require recent PIN entry and increment the destination revision, invalidating stale
preflights. Sender status distinguishes ready, configuration required, revoked,
rejected, and unknown. The UI does not claim an address was tested or preserve a
parallel pending destination until the backend implements such a state.

PIN change requires current PIN, new PIN, and confirmation. Success signs out every
session for that profile and returns to Unlock; failure preserves no PIN field value.
Installed source plugins appear as read-only deployment evidence. Profile has no
enable, disable, install, or configuration control for plugin code.

Account connections appear in a separate unframed ruled list. Each row shows
deployment availability, connection state, masked account, exact granted scopes,
capabilities, source, checked time, and reason. Phase 3 exposes only Google and Amazon
identity connections with Connect or Reconnect; `canDisconnect` is false. Amazon
always says **Identity only** and explicitly says
that Kindle purchases, library access, and Kindle Unlimited are not exposed.

OAuth completion, denial, expiry, and invalid-response states render as ordinary
Profile notices after a fixed redirect. The callback URL and provider parameters are
never rendered. Phase 3 disconnect preview is informational and has no submit action.
**Phase 4 target, not active in Phase 3:** disconnect opens an impact review showing affected destinations,
queued/running operations, upstream revocation scope, recovery, retained evidence,
and review expiry before queuing a durable operation.

## Accessibility

Meet WCAG 2.2 AA: semantic landmarks/headings/forms, logical focus order, visible
focus, keyboard completion, 320px reflow, 200% text resize, 4.5:1 text contrast, 3:1
control contrast, and at least 44px touch targets for primary controls. Meaning never
depends on color. Status changes use a polite live region when enhanced and remain
visible in ordinary HTML. Reduced-motion mode removes nonessential transitions.

## Performance budget

- Core unauthenticated and search HTML must function with JavaScript disabled.
- Initial compressed HTML plus critical CSS target: 40 KiB or less.
- Enhanced route JavaScript target: 120 KiB or less compressed; the no-JS core remains
   complete if that bundle is unavailable.
- Critical CSS is local and cacheable; no third-party fonts, trackers, or analytics.
- Search returns at most 24 items per page, submits immediately, and uses a bounded
   provider deadline so partial results do not wait indefinitely.
- Budgets are measured on gzip-compressed production artifacts. Storybook, fixtures,
   and accessibility tooling are development-only and excluded from app bundles.
