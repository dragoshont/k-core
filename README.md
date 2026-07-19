# k

`k` is a self-hosted, server-rendered book discovery and lawful acquisition service.
It searches reviewed source plugins, keeps discovery separate from permission to
acquire, validates downloaded EPUB files in quarantine, and records delivery as a
durable operation. Mail-provider acceptance is reported as submitted, not as proof
that an e-reader received a book.

## Security boundary

The four-digit PIN is a convenience credential for a trusted household. It is not
internet-grade authentication. Run `k` only behind HTTPS on a private LAN or VPN,
with a correctly configured trusted proxy and private-client CIDR boundary. `k` does
not require Authentik or another external identity provider.

The application always has exactly three profile slots. Their immutable UUIDs own
sessions, credentials, destinations, accounts, and operations. Operators may change
only the three slugs and display names through a non-secret `PROFILE_CONFIG_FILE`:

| Slot | UUID | Default slug | Default name |
|---:|---|---|---|
| 1 | `00000000-0000-4000-8000-000000000001` | `member-1` | Member 1 |
| 2 | `00000000-0000-4000-8000-000000000002` | `member-2` | Member 2 |
| 3 | `00000000-0000-4000-8000-000000000003` | `member-3` | Member 3 |

Profile setup starts with a one-use credential code issued by the operator. After
building and migrating, issue one without putting the code in command arguments:

```sh
npm run admin -- admin credential-code --profile member-1 --purpose setup
```

The command prints the code once. The member redeems it in the browser and chooses a
four-digit PIN. Recovery uses the same command with `--purpose recovery` and revokes
the profile's existing sessions.

## Provenance and plugins

Search results are not authority to download a file. Sources with unknown provenance
are metadata-only: they may contribute search and detail records, but `k` strips or
rejects acquisition options. In the distributed core, acquisition is available only
for reviewed public-domain capabilities in `plugins/public-inventory.json`; core
revalidates that evidence before preflight, queueing, acquisition, and delivery.

The image contains the shared plugin library and six reviewed plugins only:

- Project Gutenberg
- Standard Ebooks
- Internet Archive
- Google Books metadata
- Google Gmail integration
- Login with Amazon identity

`PUBLIC_PLUGIN_DIR` identifies that immutable public root. `PRIVATE_PLUGIN_DIR` is
reserved for a separate, read-only runtime mount at a distinct path. No private plugin
payload, installer, registry pull, or private distribution mechanism is implemented or
distributed by this repository.

## Local setup

Prerequisites are Node.js 24, npm, PostgreSQL 16, and Docker for the image gate.

```sh
npm ci
cp .env.example .env
# Replace every placeholder and export the variables through your preferred local tool.
npm run build:server
npm run migrate
npm run start:web
```

`PUBLIC_ORIGIN` must be an HTTPS origin even when a local reverse proxy terminates TLS.
Keep secrets in an ignored environment file or deployment secret store. The optional
profile document is non-secret and must conform to
`contracts/profile-config.schema.json`.

## Verification

```sh
npm run test:oss-core
npm run typecheck
npm test
./gates/checks.sh
./gates/backend-checks.sh
./gates/reconcile.sh
./scripts/phase6-image-gate.sh k:phase6
```

The image gate builds and inspects a local `linux/amd64` image, checks every final
layer and the final plugin filesystem, then runs neutral and custom-profile smoke
tests. It does not log in to a registry or push an image.

## Architecture and contracts

- [Architecture](docs/architecture.md)
- [Decisions](docs/adr/)
- [HTTP contract](contracts/http.capabilities.phase-3.openapi.yaml)
- [Plugin protocol](contracts/plugin-protocol.v2.schema.json)
- [Provider policy](docs/providers/policy.md)
- [Threat model](docs/security/threat-model.md)
- [Browser-only deployment plan](docs/deployment-browser-only.md)

`k` is licensed under the [Apache License 2.0](LICENSE). Security-sensitive reports
should avoid real credentials, account data, or private topology and use the project's
issue tracker only when public disclosure is appropriate.
