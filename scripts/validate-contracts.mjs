import { execFileSync } from "node:child_process";
import { readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const parse = async (path) => JSON.parse(await readFile(path, "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);

const manifestSchema = await parse("contracts/plugin-manifest.schema.json");
const protocolSchema = await parse("contracts/plugin-protocol.v2.schema.json");
const profileConfigSchema = await parse("contracts/profile-config.schema.json");
const validateManifest = ajv.compile(manifestSchema);
const validateProtocol = ajv.compile(protocolSchema);
const validateProfileConfig = ajv.compile(profileConfigSchema);

const openApiBundlePath = resolve(tmpdir(), `k-capability-contract-${process.pid}.json`);
execFileSync(resolve("node_modules/.bin/redocly"), ["bundle", "contracts/http.capabilities.phase-3.openapi.yaml", "--ext", "json", "--output", openApiBundlePath], { stdio: "pipe" });
const openApiBundle = await parse(openApiBundlePath);
await rm(openApiBundlePath, { force: true });
const openApiSchemasForAjv = JSON.parse(
  JSON.stringify(openApiBundle.components.schemas).replaceAll("#/components/schemas/", "#/$defs/"),
);
const validateAccountView = ajv.compile({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $defs: openApiSchemasForAjv,
  $ref: "#/$defs/AccountConnectionView",
});
const activePaths = openApiBundle.paths;
if (activePaths["/oauth/callback/microsoft-onedrive"]) throw new Error("Phase 3 contract exposes Microsoft/OneDrive");
const activeSource = JSON.stringify(openApiBundle);
for (const forbidden of ["save-to-onedrive", "send-mail", "disconnect-account", "probable"]) {
  if (activeSource.includes(`\"${forbidden}\"`)) throw new Error(`Phase 3 contract exposes future value ${forbidden}`);
}

function assertValid(validate, value, label) {
  if (!validate(value)) {
    throw new Error(`${label} was invalid:\n${ajv.errorsText(validate.errors, { separator: "\n" })}`);
  }
}

function assertInvalid(validate, value, label) {
  if (validate(value)) throw new Error(`${label} unexpectedly validated`);
}

function assertManifestSemantics(manifest, label) {
  if (manifest.schemaVersion !== 2) return;
  const ids = manifest.capabilities.map((capability) => capability.capabilityId);
  if (new Set(ids).size !== ids.length) throw new Error(`${label} repeats a capabilityId`);
  for (const capability of manifest.capabilities) {
    if (!capability.capabilityId.startsWith(`${manifest.pluginId}/`)) {
      throw new Error(`${label} capabilityId must use its pluginId namespace`);
    }
  }
}

const v1Paths = [
  "plugins/project-gutenberg/plugin.json",
  "plugins/standard-ebooks/plugin.json",
  "plugins/internet-archive/plugin.json",
];
const fixtureDirectory = "tests/fixtures/plugins";
const v2Paths = (await readdir(fixtureDirectory))
  .filter((name) => name.endsWith(".v2.json"))
  .sort()
  .map((name) => resolve(fixtureDirectory, name));

for (const path of [...v1Paths, ...v2Paths]) {
  const manifest = await parse(path);
  assertValid(validateManifest, manifest, path);
  assertManifestSemantics(manifest, path);
}

function assertProfileConfigSemantics(value, label) {
  assertValid(validateProfileConfig, value, label);
  const slugs = value.profiles.map((profile) => profile.slug);
  const displayNames = value.profiles.map((profile) => profile.displayName);
  if (new Set(slugs).size !== slugs.length) throw new Error(`${label} repeats a slug`);
  if (displayNames.some((value) => value !== value.normalize("NFKC") || value !== value.trim())) {
    throw new Error(`${label} contains a non-normalized display name`);
  }
  const normalizedNames = displayNames.map((value) => value.normalize("NFKC").toLocaleLowerCase("und"));
  if (new Set(normalizedNames).size !== normalizedNames.length) throw new Error(`${label} repeats a normalized display name`);
}

const profileConfig = await parse("config/profiles.example.json");
assertProfileConfigSemantics(profileConfig, "neutral profile config");

const wrongProfileSlot = structuredClone(profileConfig);
wrongProfileSlot.profiles[0].profileId = wrongProfileSlot.profiles[1].profileId;
assertInvalid(validateProfileConfig, wrongProfileSlot, "profile config with wrong slot UUID");

for (const [label, mutate] of [
  ["duplicate slug", (value) => { value.profiles[1].slug = value.profiles[0].slug; }],
  ["reserved slug", (value) => { value.profiles[0].slug = "admin"; }],
  ["UUID-shaped slug", (value) => { value.profiles[0].slug = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; }],
  ["whitespace-padded display name", (value) => { value.profiles[0].displayName = " Member 1"; }],
  ["invisible-format display name", (value) => { value.profiles[0].displayName = "Mem\u200ber 1"; }],
  ["non-normalized display name", (value) => { value.profiles[0].displayName = "Ｍember 1"; }],
  ["normalized display-name collision", (value) => { value.profiles[1].displayName = "member 1"; }],
]) {
  const invalid = structuredClone(profileConfig);
  mutate(invalid);
  let rejected = false;
  try {
    assertProfileConfigSemantics(invalid, `profile config with ${label}`);
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error(`profile config with ${label} unexpectedly passed`);
}

const unverifiedSource = await parse("tests/fixtures/plugins/unverified-book-source.v2.json");
assertValid(validateManifest, unverifiedSource, "metadata-only unverified source");
const forgedUnverifiedRights = structuredClone(unverifiedSource);
forgedUnverifiedRights.capabilities[0].rightsBases = ["public-domain"];
assertInvalid(validateManifest, forgedUnverifiedRights, "metadata-only source with rights basis");
const forgedUnverifiedAcquire = structuredClone(unverifiedSource);
forgedUnverifiedAcquire.capabilities[0].commands.push("catalog.acquire");
assertInvalid(validateManifest, forgedUnverifiedAcquire, "acquire source without rights basis");

const unverifiedCatalogItem = {
  acquisitionOptions: [],
  authors: ["Fixture Author"],
  capability: "deliverable",
  capabilityReason: "Plugin claim that core must replace",
  checkedAt: "2026-07-19T00:00:00Z",
  itemId: "fixture-book",
  language: "en",
  pluginId: "unverified-book-source",
  publishedYear: 1900,
  source: "Unverified Book Source",
  title: "Fixture Book",
};
const unverifiedCatalogSearch = {
  protocolVersion: 2,
  invocationId: "550e8400-e29b-41d4-a716-446655440003",
  capabilityId: "unverified-book-source/books",
  command: "catalog.search",
  ok: true,
  result: { items: [unverifiedCatalogItem], query: "fixture", searchedAt: "2026-07-19T00:00:00Z" },
};
assertValid(validateProtocol, unverifiedCatalogSearch, "metadata-only catalog response");
const pluginOwnedProvenance = structuredClone(unverifiedCatalogSearch);
pluginOwnedProvenance.result.items[0].provenance = "verified-public-domain";
assertInvalid(validateProtocol, pluginOwnedProvenance, "plugin-owned provenance claim");

const googleGmail = await parse("tests/fixtures/plugins/google-gmail.v2.json");
const mailCapability = googleGmail.capabilities.find((capability) => capability.family === "mail-sender");
const mailRequest = {
  protocolVersion: 2,
  invocationId: "550e8400-e29b-41d4-a716-446655440000",
  capabilityId: mailCapability.capabilityId,
  command: "mail.send",
  authorization: {
    kind: "bearer",
    value: "fixture-access-token-value-that-is-never-logged",
    expiresAt: "2026-07-18T16:00:00Z",
  },
  input: {
    messagePath: "/quarantine/operation/message.eml",
    messageId: "<operation-fixture@k.example.invalid>",
    recipient: "fixture@kindle.com",
  },
};
assertValid(validateProtocol, mailRequest, "mail.send request");
if (!mailCapability.commands.includes(mailRequest.command)) {
  throw new Error("declared mail capability did not authorize mail.send");
}

const success = {
  protocolVersion: 2,
  invocationId: mailRequest.invocationId,
  capabilityId: mailRequest.capabilityId,
  command: mailRequest.command,
  ok: true,
  result: {
    state: "provider-accepted",
    providerMessageId: "gmail-fixture-message",
  },
};
assertValid(validateProtocol, success, "success response");

const wrongFamilyCommand = structuredClone(mailRequest);
wrongFamilyCommand.command = "destination.deliver";
wrongFamilyCommand.input = {
  artifact: {
    mediaType: "application/epub+zip",
    sizeBytes: 840000,
    sha256: "a".repeat(64),
  },
  artifactPath: "/quarantine/operation/book.epub",
  fileName: "The Time Machine.epub",
  operationKey: "operation-fixture",
};
assertValid(validateProtocol, wrongFamilyCommand, "syntactically valid undeclared request");
if (mailCapability.commands.includes(wrongFamilyCommand.command)) {
  throw new Error("family command fixture did not exercise undeclared-command rejection");
}

const secretResponse = structuredClone(success);
secretResponse.result.accessToken = "must-never-leave-plugin";
assertInvalid(validateProtocol, secretResponse, "secret-bearing response");

const metadataMatched = {
  protocolVersion: 2,
  invocationId: "550e8400-e29b-41d4-a716-446655440001",
  capabilityId: "google-books/metadata",
  command: "metadata.enrich",
  ok: true,
  result: {
    state: "matched",
    providerId: "google-books",
    providerLabel: "Google Books",
    recordId: "fixture-volume",
    mediaKind: "book",
    matchedBy: "isbn-13",
    matchQuality: "exact-identifier",
    fields: { averageRating: 4.5, ratingsCount: 42 },
    checkedAt: "2026-07-18T16:00:00Z",
    informationLink: "https://books.google.com/books?id=fixture-volume",
  },
};
assertValid(validateProtocol, metadataMatched, "metadata matched response");
const metadataNoMatch = structuredClone(metadataMatched);
metadataNoMatch.result = {
  state: "no-match",
  providerId: "google-books",
  providerLabel: "Google Books",
  mediaKind: "book",
  reasonCode: "NO_EXACT_MATCH",
  checkedAt: "2026-07-18T16:00:00Z",
};
assertValid(validateProtocol, metadataNoMatch, "metadata no-match response");
const probableMetadata = structuredClone(metadataMatched);
probableMetadata.result.matchQuality = "probable";
assertInvalid(validateProtocol, probableMetadata, "probable metadata attachment");

const identityResolved = {
  protocolVersion: 2,
  invocationId: "550e8400-e29b-41d4-a716-446655440002",
  capabilityId: "login-with-amazon/identity",
  command: "identity.resolve",
  ok: true,
  result: {
    providerId: "login-with-amazon",
    subject: "amzn1.account.fixture",
    maskedAccount: "d•••••@example.invalid",
    checkedAt: "2026-07-18T16:00:00Z",
  },
};
assertValid(validateProtocol, identityResolved, "identity resolved response");

const unknownManifestField = structuredClone(googleGmail);
unknownManifestField.remoteInstallerUrl = "https://example.invalid/plugin";
assertInvalid(validateManifest, unknownManifestField, "manifest with unknown installation field");

const mismatchedFamily = structuredClone(googleGmail);
mismatchedFamily.capabilities[0].commands = ["mail.send"];
assertInvalid(validateManifest, mismatchedFamily, "identity capability with mail command");

const duplicateCapability = structuredClone(googleGmail);
duplicateCapability.capabilities[1].capabilityId = duplicateCapability.capabilities[0].capabilityId;
let duplicateRejected = false;
try {
  assertManifestSemantics(duplicateCapability, "duplicate capability fixture");
} catch {
  duplicateRejected = true;
}
if (!duplicateRejected) throw new Error("duplicate capabilityId unexpectedly passed semantic validation");

const accountViewBase = {
  connectorId: "google-gmail",
  displayName: "Google",
  providerAvailability: "available",
  authorizationPending: false,
  maskedAccount: null,
  grantedScopes: [],
  capabilities: [],
  revision: 0,
  connectedAt: null,
  lastValidatedAt: null,
  canConnect: true,
  canReconnect: false,
  canDisconnect: false,
  reasonCode: "ACCOUNT_NOT_CONNECTED",
  reason: "Connect Google to submit Kindle mail through Gmail.",
  evidence: {
    sourceId: "provider-account-record",
    sourceLabel: "Provider account record",
    sourceKind: "profile-record",
    checkedAt: "2026-07-18T16:00:00Z",
    scope: { kind: "profile", id: "00000000-0000-4000-8000-000000000002" },
    freshness: "fresh",
  },
};
assertValid(validateAccountView, { ...accountViewBase, accountId: null, state: "not-configured" }, "not-configured connector view");
assertValid(validateAccountView, { ...accountViewBase, accountId: null, state: "connecting", authorizationPending: true }, "connecting connector view");
assertInvalid(validateAccountView, { ...accountViewBase, state: "connected" }, "connected account without accountId");
assertValid(validateAccountView, {
  ...accountViewBase,
  accountId: "550e8400-e29b-41d4-a716-446655440000",
  state: "connected",
  authorizationPending: true,
  maskedAccount: "m••••••@gmail.com",
  grantedScopes: ["openid", "email", "gmail.send"],
  capabilities: ["identity-only"],
  revision: 1,
  connectedAt: "2026-07-18T16:00:00Z",
  lastValidatedAt: "2026-07-18T16:00:00Z",
  canConnect: false,
  canDisconnect: false,
}, "connected account view");

console.log(`CONTRACTS: PASS (${v1Paths.length} unchanged v1 manifests, ${v2Paths.length} v2 fixtures, profile config, protocol, account-state, and adversarial checks)`);
