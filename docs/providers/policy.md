# Source Plugin Policy

## Purpose

Source plugin code must preserve a clear distinction between finding information about a
book and acquiring a file. `k` may acquire only public-domain, user-owned, or otherwise
licensed files from sources the operator has explicitly approved.

## Capability classes

| Class | Meaning | UI action |
|---|---|---|
| `candidate` | Provider reports a potentially acquirable edition, not yet verified | Allow preflight; do not promise success |
| `deliverable` | A local artifact has passed policy, rights, file, and output validation | Allow a revision-bound delivery preflight |

## Capability families and provider honesty

Installed capabilities are `catalog-source`, `metadata-enricher`,
`identity-provider`, `mail-sender`, or `delivery-destination`. Deployment presence
activates code; profile connection state never activates or installs code.

| Provider | Family | Honest support state | Constraint |
|---|---|---|---|
| Google Books | Metadata enricher | Configuration required until an API key exists | Ratings and metadata only; never acquisition rights |
| Goodreads | Provider policy | Unsupported | No supported new API integration; no scraping/data mining fallback |
| Amazon Creators | Metadata/product availability | Eligibility required | Current official API only; PA-API is retired |
| Login with Amazon | Identity provider | Configuration required until registered | Identity-only account connection; no Kindle purchase/library/KU authority |
| Kindle Unlimited | Provider policy | Not exposed | No trustworthy supported entitlement signal; never report false/unavailable |
| Gmail | Mail sender | Account required after deployment registration | Narrow `gmail.send`; acceptance is not Kindle receipt |
| Microsoft OneDrive | Delivery destination | Account required after deployment registration | GA `Files.ReadWrite`, constrained by core/plugin to `/Apps/k`; storage is not device sync |

Future movie catalog/acquisition plugins must provide the same source provenance,
rights basis, fixed origins, bounded bytes, and quarantine validation. Declaring
`mediaKind: movie` does not make the current EPUB worker capable of processing it;
host support remains `unsupported` until a separate signed-off rights/file pipeline
exists.

## Initial installed plugins

| Plugin | Capability | Rights basis | Transport | Limits |
|---|---|---|---|---|
| Project Gutenberg | Candidate EPUB acquisition | Public domain in the USA; deployment review required | OPDS 1.2 and official EPUB | Identified client, low-volume cache, fixed origin, bounded bytes |
| Standard Ebooks | Candidate EPUB acquisition | CC0/public-domain dedication; deployment review required | Semantic public catalog plus same-origin EPUB | Cached human-triggered scrape, selector fail-closed, no cross-origin redirect |
| Internet Archive | Candidate EPUB acquisition | Exact Public Domain Mark or CC0 record only | Advanced Search, Metadata API, metadata-listed EPUB | Max 3 HTTPS archive.org redirects, public IP each hop, bounded bytes |

Phase 3 catalog traffic is plugin-only. Open Library's Phase 2 in-core metadata
adapter is retired from the Phase 3 executable surface.

## Required descriptor

Every installed plugin declares a stable ID, display name, capability set, authentication
mode, exact approved origins, rights basis, supported formats, freshness source,
rate limit, acquisition transport, maximum bytes, and operator review date.

Search responses contain normalized fields and provenance only. Acquisition uses
opaque `pluginId`, `itemId`, and `optionId` values. A client cannot supply a URL, request
headers, cookies, selectors, or browser script.

Credentialed capability invocations may receive one short-lived core-supplied API or
access token. Manifests cannot declare OAuth endpoints or client credentials, and
plugins never receive refresh tokens, client secrets, encryption keys, or `k`
sessions. Result and diagnostic contracts prohibit credential-bearing fields.

## Explicit exclusions

The installed plugin folder must not contain:

- Anna's Archive acquisition;
- VK or search-engine-driven unlicensed downloads;
- torrent, Usenet, or arbitrary direct-download plugins;
- ACSM redemption, DRM removal, DeDRM plug-ins, or lending circumvention;
- generic URL fetching, generic Playwright recipes, or caller-supplied cookies.

These are denied product capabilities, not configuration toggles. Negative tests must
prove unknown plugin IDs, unregistered origins, off-list redirects, private/link-
local/loopback addresses, and unsupported rights bases fail closed.

## Browser acquisition gate

A plugin-specific Playwright adapter may be enabled only when all of these are
demonstrated by executable tests:

1. Fresh non-persistent context with service workers blocked.
2. Exact destination-origin and safe-port allow-list.
3. DNS resolution with private, loopback, multicast, and link-local rejection at
   connect time; no DNS rebinding gap.
4. Redirect and popup targets revalidated against the same policy.
5. Page, request, navigation, download-count, byte, CPU, memory, and time bounds.
6. Downloads streamed into quarantine without exposing browser cookies.
7. Source terms and rights basis recorded in the manifest review.
