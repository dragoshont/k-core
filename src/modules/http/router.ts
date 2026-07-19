import { randomUUID } from "node:crypto";
import { randomBase64Url } from "../common/crypto";
import { readinessConfigErrors, type AppConfig } from "../config";
import { assertProfileConfigurationParity } from "../config/profile-parity";
import { isProfileId, profileConfigState } from "../config/profile-config";
import type { Database } from "../db/database";
import type { AppRequest, AppResponse } from "./app-types";
import { parseCookies, response } from "./app-types";
import { buildCsrfCookie, buildIntegrationReceiptCookie, buildOAuthBindingCookie, buildSessionCookie, issueCsrf, verifySignedCookieValue } from "./cookies";
import { assertMediaType, parseJson, parseUrlEncoded } from "./form";
import { renderActivityPage, renderBookPage, renderIntegrationCompletionPage, renderOperationPage, renderPreflightPage, renderProblemPage, renderProfilePage, renderReauthPage, renderSearchPage, renderSetupPage, renderUnlockPage } from "./html";
import { problemJson, ProblemError, toProblemShape } from "./problems";
import { validatePrivateBoundary, validateSameOrigin } from "./security";
import { readUiCss } from "../platform/root";
import { IdentityService } from "../identity/service";
import { PluginCatalogService } from "../plugins/catalog";
import type { InstalledPlugin } from "../plugins/types";
import { DeliveryService } from "../delivery/service";
import { latestMigrationVersion, readCurrentSchemaVersion } from "../db/migrator";
import { ProviderAccountService } from "../provider-accounts/service";
import { ProviderExchangeAdapter } from "../provider-accounts/provider-exchange";
import { buildAccountConnectionViews, buildCapabilityViews, configuredProviderConnectorIds, type AccountConnectionView } from "../provider-accounts/http-views";
import type { ProviderConnectorId } from "../provider-accounts/types";

type RouterIdentityService = Pick<IdentityService,
	"changePin" | "listProfiles" | "login" | "logout" | "readSession" | "reauthenticate"
	| "redeemCredential" | "requiresRecentAuth" | "sessionFromToken"
>;
type RouterCatalogService = Pick<PluginCatalogService, "detail" | "listInstalledPlugins" | "search"> & { installed?: readonly InstalledPlugin[] };
type RouterProviderAccountService = Pick<ProviderAccountService,
	"consumeCompletionReceipt" | "issueCompletionReceipt" | "listAccountRows" | "startAuthorization"
>;
type RouterProviderExchangeAdapter = Pick<ProviderExchangeAdapter, "authorizationUrl" | "exchange">;

type AuthorizationPurpose = "connect" | "reconnect";
type CompletionOutcome = "connected" | "denied" | "expired" | "invalid";

const INTEGRATION_COMPLETION_PATH = "/profile/integrations/complete";

function providerConnectorId(value: string): ProviderConnectorId | null {
	if (value === "google-gmail" || value === "login-with-amazon") return value;
	return null;
	}

function validOpaqueSecret(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
	}

function mutationProfileId(value: unknown) {
	if (!isProfileId(value)) throw new ProblemError(422, "validation_failed", "Validation failed");
	return value;
}

function authorizationRequest(body: Record<string, unknown>) {
	if (Object.keys(body).sort().join(",") !== "purpose,requestedCapabilities"
		|| (body.purpose !== "connect" && body.purpose !== "reconnect")
		|| !Array.isArray(body.requestedCapabilities)
		|| body.requestedCapabilities.length !== 1
		|| body.requestedCapabilities[0] !== "identity-only") {
		throw new ProblemError(422, "validation_failed", "Validation failed");
	}
	return body.purpose as AuthorizationPurpose;
	}

function completionResult(outcome: CompletionOutcome) {
	if (outcome === "connected") {
		return { heading: "Account connected", message: "The provider identity connection was validated and stored. It did not sign you in to k.", status: "connected" as const };
	}
	if (outcome === "denied") {
		return { heading: "Account was not connected", message: "Consent was denied. No existing credential was replaced.", status: "denied" as const };
	}
	if (outcome === "expired") {
		return { heading: "Connection check expired", message: "Start a new identity connection from your profile. The previous response cannot be replayed.", status: "expired" as const };
	}
	return { heading: "Connection response was not accepted", message: "The response could not be validated. No credential was stored or replaced.", status: "invalid" as const };
	}

function toProfileAccountConnection(view: AccountConnectionView) {
	return {
		...(view.accountId ? { accountId: view.accountId } : {}),
		canConnect: view.canConnect,
		canDisconnect: view.canDisconnect,
		canReconnect: view.canReconnect,
		capabilities: [...view.capabilities],
		checkedAt: view.evidence.checkedAt,
		connectorId: view.connectorId,
		displayName: view.displayName,
		grantedScopes: [...view.grantedScopes],
		maskedAccount: view.maskedAccount,
		providerAvailability: view.providerAvailability,
		reason: view.reason,
		source: view.evidence.sourceLabel,
		state: view.state,
	};
	}

function json(body: unknown, headers?: Record<string, string | string[]>) {
	return response(200, JSON.stringify(body), { "content-type": "application/json; charset=utf-8", ...headers });
	}

function redirect(location: string, cookies?: string[]) {
	const headers: Record<string, string | string[]> = { location };
	if (cookies && cookies.length > 0) {
		headers["set-cookie"] = cookies;
	}
	return response(303, "", headers);
	}

function noContent(cookies?: string[]) {
	const headers: Record<string, string | string[]> = {};
	if (cookies && cookies.length > 0) {
		headers["set-cookie"] = cookies;
	}
	return response(204, "", headers);
	}

async function requireSession(identity: RouterIdentityService, request: AppRequest, config: AppConfig, csrfToken?: string) {
	const cookies = parseCookies(request);
	const session = await identity.sessionFromToken(cookies["__Host-k.sid"]);
	if (!session) {
		throw new ProblemError(401, "unauthorized", "Authentication is required.");
	}
	if (csrfToken !== undefined) {
		if (!validateSameOrigin(request, config)) {
			throw new ProblemError(401, "unauthorized", "Authentication is required.");
		}
		const verified = verifySignedCookieValue(config.sessionSigningKey, cookies["__Host-k.csrf"]);
		if (!verified || !csrfToken || verified !== csrfToken) {
			throw new ProblemError(401, "unauthorized", "Authentication is required.");
		}
	}
	return { cookies, session };
	}

function currentOrFreshCsrf(request: AppRequest, config: AppConfig) {
	const signedCookie = parseCookies(request)["__Host-k.csrf"];
	const verified = verifySignedCookieValue(config.sessionSigningKey, signedCookie);
	if (verified && signedCookie) {
		return { cookieValue: signedCookie, token: verified };
	}
	return issueCsrf(config.sessionSigningKey);
	}

export function createRouter(input: {
	catalogService?: RouterCatalogService;
	config: AppConfig;
	database: Database;
	deliveryService?: DeliveryService;
	identityService?: RouterIdentityService;
	installedPlugins?: readonly InstalledPlugin[];
	providerAccountService?: RouterProviderAccountService;
	providerExchangeAdapter?: RouterProviderExchangeAdapter;
}) {
	const css = readUiCss();
	const identity = input.identityService ?? new IdentityService(input.database, input.config);
	const catalog = input.catalogService ?? new PluginCatalogService(input.database, input.config);
	const delivery = input.deliveryService ?? new DeliveryService(input.database, input.config, catalog as PluginCatalogService);
	const installedPlugins = input.installedPlugins ?? catalog.installed ?? [];
	const providerRuntimeConfig = input.config.providerRuntimeConfig;
	const providerAccounts = input.providerAccountService ?? (providerRuntimeConfig?.configured
		? new ProviderAccountService(input.database, providerRuntimeConfig)
		: undefined);
	const providerExchange = input.providerExchangeAdapter ?? (providerRuntimeConfig?.configured && providerAccounts instanceof ProviderAccountService
		? new ProviderExchangeAdapter({ config: providerRuntimeConfig, installedPlugins, service: providerAccounts, userAgent: input.config.userAgent })
		: undefined);
	const configuredConnectorIds = configuredProviderConnectorIds(providerRuntimeConfig);

	async function accountConnectionViews(profileId: string) {
		const accountRows = providerAccounts && configuredConnectorIds.length > 0
			? await providerAccounts.listAccountRows(profileId)
			: [];
		return buildAccountConnectionViews({
			accountRows,
			authorizationAvailable: Boolean(providerAccounts && providerExchange),
			configuredConnectorIds,
			profileId,
		});
	}

	async function startProviderAuthorization(session: NonNullable<Awaited<ReturnType<RouterIdentityService["sessionFromToken"]>>>, connectorId: ProviderConnectorId, purpose: AuthorizationPurpose) {
		const registration = providerRuntimeConfig?.configured ? providerRuntimeConfig.connector(connectorId)?.registration : undefined;
		if (!registration || !providerAccounts || !providerExchange) {
			throw new ProblemError(409, "integration_not_ready", "Integration is not ready");
		}
		const started = await providerAccounts.startAuthorization(session, connectorId, purpose);
		const location = providerExchange.authorizationUrl(started, connectorId);
		const authorizationEndpoint = new URL(registration.authorizationEndpoint);
		if (!(location instanceof URL)
			|| location.protocol !== "https:"
			|| location.username
			|| location.password
			|| location.hash
			|| location.origin !== authorizationEndpoint.origin
			|| location.pathname !== authorizationEndpoint.pathname
			|| !validOpaqueSecret(started.browserBinding)) {
			throw new ProblemError(409, "integration_not_ready", "Integration is not ready");
		}
		return redirect(location.href, [buildOAuthBindingCookie(started.browserBinding)]);
	}

	async function invalidCompletionReceipt() {
		if (providerAccounts) {
			try {
				const receipt = await providerAccounts.issueCompletionReceipt({ authorizationId: null, connectorId: null, outcome: "invalid", profileId: null });
				if (validOpaqueSecret(receipt)) return receipt;
			} catch {
				// Callback responses remain deliberately indistinguishable.
			}
		}
		return randomBase64Url(32);
	}

	return async function route(request: AppRequest): Promise<AppResponse> {
		const requestId = randomUUID();
		let sourceAddress = request.remoteAddress ?? "unknown";
		try {
			if (request.method === "GET" && request.url.pathname === "/healthz") {
				return response(200, "ok", { "content-type": "text/plain; charset=utf-8" });
			}

			if (request.url.pathname !== "/healthz" && request.url.pathname !== "/readyz") {
				const boundary = validatePrivateBoundary(request, input.config);
				if (!boundary.ok) {
					throw new ProblemError(401, "unauthorized", "Authentication is required.");
				}
				sourceAddress = boundary.clientAddress!;
			}

			if (request.method === "GET" && request.url.pathname === "/readyz") {
				const configErrors = readinessConfigErrors(input.config);
				if (configErrors.length > 0) {
					throw new ProblemError(503, "configuration_required", "Service is not ready", configErrors.join("; "));
				}
				let schemaVersion: number;
				try {
					schemaVersion = await readCurrentSchemaVersion(input.database);
				} catch {
					throw new ProblemError(503, "database_not_ready", "Service is not ready", "Database is unavailable.");
				}
				if (schemaVersion !== latestMigrationVersion()) {
					throw new ProblemError(503, "schema_not_ready", "Service is not ready", "Database schema is not at the expected version.");
				}
				try {
					await assertProfileConfigurationParity(input.database, profileConfigState(input.config).value);
				} catch (error) {
					if (error instanceof ProblemError && error.code === "profile_configuration_mismatch") throw error;
					throw new ProblemError(503, "database_not_ready", "Service is not ready", "Database is unavailable.");
				}
				return response(200, "ready", { "content-type": "text/plain; charset=utf-8" });
			}

			await assertProfileConfigurationParity(input.database, profileConfigState(input.config).value);

			const callbackConnectorId = request.url.pathname === "/oauth/callback/google-gmail"
				? "google-gmail" as const
				: request.url.pathname === "/oauth/callback/login-with-amazon"
					? "login-with-amazon" as const
					: null;
			if (request.method === "GET" && callbackConnectorId) {
				let browserBinding = "";
				try {
					browserBinding = parseCookies(request)["__Host-k.oauth"] ?? "";
				} catch {
					// A malformed cookie is an invalid callback, not a response oracle.
				}
				let receipt: string | null = null;
				if (providerRuntimeConfig?.configured && providerExchange) {
					try {
						const completion = await providerExchange.exchange({
							browserBinding,
							callbackUrl: request.url,
							connectorId: callbackConnectorId,
							state: request.url.searchParams.get("state") ?? "",
						});
						if (completion.completionPath === INTEGRATION_COMPLETION_PATH && validOpaqueSecret(completion.receipt)) {
							receipt = completion.receipt;
						}
					} catch {
						// Provider and validation failures all receive the fixed completion redirect.
					}
				}
				receipt ??= await invalidCompletionReceipt();
				return redirect(INTEGRATION_COMPLETION_PATH, [
					buildOAuthBindingCookie(null),
					buildIntegrationReceiptCookie(receipt),
				]);
			}

			if (request.method === "GET" && request.url.pathname === INTEGRATION_COMPLETION_PATH) {
				let receipt = "";
				try {
					receipt = parseCookies(request)["__Host-k.integration"] ?? "";
				} catch {
					// A malformed cookie renders the same generic invalid completion.
				}
				let outcome: CompletionOutcome = "invalid";
				if (providerAccounts) {
					try {
						const consumed = await providerAccounts.consumeCompletionReceipt(receipt);
						if (consumed.valid && (consumed.outcome === "connected" || consumed.outcome === "denied" || consumed.outcome === "expired" || consumed.outcome === "invalid")) {
							outcome = consumed.outcome;
						}
					} catch {
						outcome = "invalid";
					}
				}
				return response(200, renderIntegrationCompletionPage({ css, integrationResult: completionResult(outcome) }), {
					"content-type": "text/html; charset=utf-8",
					"set-cookie": buildIntegrationReceiptCookie(null),
				});
			}

			if (request.method === "GET" && request.url.pathname === "/") {
				const cookies = parseCookies(request);
				const session = await identity.sessionFromToken(cookies["__Host-k.sid"]);
				return redirect(session ? "/search" : "/unlock");
			}

			if (request.method === "GET" && request.url.pathname === "/api/v1/auth/profiles") {
				const csrf = currentOrFreshCsrf(request, input.config);
				const profiles = await identity.listProfiles();
				return json({ csrfToken: csrf.token, profiles }, { "set-cookie": buildCsrfCookie(csrf.cookieValue) });
			}

			if (request.method === "GET" && request.url.pathname === "/unlock") {
				const csrf = currentOrFreshCsrf(request, input.config);
				const profiles = await identity.listProfiles();
				const selected = request.url.searchParams.get("profile");
				const selectedProfile = selected ? profiles.find((profile) => profile.profileId === selected) : undefined;
				if (selectedProfile && selectedProfile.credentialState !== "ready") {
					return response(200, renderSetupPage({ css, csrfToken: csrf.token, profile: { credentialState: selectedProfile.credentialState, displayName: selectedProfile.displayName, id: selectedProfile.profileId }, purpose: selectedProfile.credentialState === "recovery-required" ? "recovery" : "setup" }), { "content-type": "text/html; charset=utf-8", "set-cookie": buildCsrfCookie(csrf.cookieValue) });
				}
				return response(200, renderUnlockPage({
					css,
					csrfToken: csrf.token,
					profiles: profiles.map((profile) => ({ credentialState: profile.credentialState, displayName: profile.displayName, id: profile.profileId })),
					selectedProfile: selectedProfile ? { credentialState: selectedProfile.credentialState, displayName: selectedProfile.displayName, id: selectedProfile.profileId } : undefined,
				}), { "content-type": "text/html; charset=utf-8", "set-cookie": buildCsrfCookie(csrf.cookieValue) });
			}

			if (request.method === "POST" && request.url.pathname === "/api/v1/auth/login") {
				assertMediaType(request, "application/json");
				const body = parseJson(request.bodyText);
				const verified = verifySignedCookieValue(input.config.sessionSigningKey, parseCookies(request)["__Host-k.csrf"]);
				if (!verified || verified !== String(body.csrfToken ?? "") || !validateSameOrigin(request, input.config)) {
					throw new ProblemError(401, "unauthorized", "Authentication is required.");
				}
				const result = await identity.login({ pin: String(body.pin ?? ""), profileId: mutationProfileId(body.profileId), sourceAddress });
				return noContent([buildSessionCookie(result.sessionToken), buildCsrfCookie(issueCsrf(input.config.sessionSigningKey).cookieValue)]);
			}

			if (request.method === "POST" && request.url.pathname === "/unlock") {
				assertMediaType(request, "application/x-www-form-urlencoded");
				const body = parseUrlEncoded(request.bodyText);
				const verified = verifySignedCookieValue(input.config.sessionSigningKey, parseCookies(request)["__Host-k.csrf"]);
				if (!verified || verified !== String(body.csrfToken ?? "") || !validateSameOrigin(request, input.config)) {
					throw new ProblemError(401, "unauthorized", "Authentication is required.");
				}
				const result = await identity.login({ pin: String(body.pin ?? ""), profileId: mutationProfileId(body.profileId), sourceAddress });
				return redirect("/search", [buildSessionCookie(result.sessionToken), buildCsrfCookie(issueCsrf(input.config.sessionSigningKey).cookieValue)]);
			}

			if (request.method === "POST" && request.url.pathname === "/api/v1/auth/credential") {
				assertMediaType(request, "application/json");
				const body = parseJson(request.bodyText);
				const verified = verifySignedCookieValue(input.config.sessionSigningKey, parseCookies(request)["__Host-k.csrf"]);
				if (!verified || verified !== String(body.csrfToken ?? "") || !validateSameOrigin(request, input.config)) {
					throw new ProblemError(401, "unauthorized", "Authentication is required.");
				}
				await identity.redeemCredential({ credentialCode: String(body.credentialCode ?? ""), pin: String(body.pin ?? ""), profileId: mutationProfileId(body.profileId), sourceAddress });
				return noContent();
			}

			if (request.method === "GET" && request.url.pathname === "/setup") {
				const csrf = currentOrFreshCsrf(request, input.config);
				const profiles = await identity.listProfiles();
				const selected = request.url.searchParams.get("profile");
				const profile = profiles.find((candidate) => candidate.profileId === selected) ?? profiles[0];
				return response(200, renderSetupPage({ css, csrfToken: csrf.token, profile: { credentialState: profile.credentialState, displayName: profile.displayName, id: profile.profileId }, purpose: profile.credentialState === "recovery-required" ? "recovery" : "setup" }), { "content-type": "text/html; charset=utf-8", "set-cookie": buildCsrfCookie(csrf.cookieValue) });
			}

			if (request.method === "POST" && request.url.pathname === "/setup") {
				assertMediaType(request, "application/x-www-form-urlencoded");
				const body = parseUrlEncoded(request.bodyText);
				const verified = verifySignedCookieValue(input.config.sessionSigningKey, parseCookies(request)["__Host-k.csrf"]);
				if (!verified || verified !== String(body.csrfToken ?? "") || !validateSameOrigin(request, input.config)) {
					throw new ProblemError(401, "unauthorized", "Authentication is required.");
				}
				if (body.pin !== body.confirmPin) {
					throw new ProblemError(422, "validation_failed", "Validation failed", "PIN confirmation does not match.");
				}
				await identity.redeemCredential({ credentialCode: String(body.credentialCode ?? ""), pin: String(body.pin ?? ""), profileId: mutationProfileId(body.profileId), sourceAddress });
				return redirect("/unlock");
			}

			if (request.method === "GET" && request.url.pathname === "/api/v1/session") {
				const cookies = parseCookies(request);
				const csrfToken = verifySignedCookieValue(input.config.sessionSigningKey, cookies["__Host-k.csrf"]);
				const sessionView = await identity.readSession(cookies["__Host-k.sid"], csrfToken ?? undefined);
				if (!sessionView) {
					throw new ProblemError(401, "unauthorized", "Authentication is required.");
				}
				return json(sessionView);
			}

			if (request.method === "POST" && request.url.pathname === "/api/v1/auth/reauthenticate") {
				assertMediaType(request, "application/json");
				const body = parseJson(request.bodyText);
				const { cookies, session } = await requireSession(identity, request, input.config, String(body.csrfToken ?? ""));
				const result = await identity.reauthenticate({ pin: String(body.pin ?? ""), session, sourceAddress });
				const rotatedCsrf = issueCsrf(input.config.sessionSigningKey);
				return noContent([buildSessionCookie(result.sessionToken), buildCsrfCookie(rotatedCsrf.cookieValue)]);
			}

			if (request.method === "GET" && request.url.pathname === "/reauthenticate") {
				const csrf = currentOrFreshCsrf(request, input.config);
				const { session } = await requireSession(identity, request, input.config);
				return response(200, renderReauthPage({ css, csrfToken: csrf.token, profile: { credentialState: session.profile.credentialState, displayName: session.profile.displayName, id: session.profile.profileId } }), { "content-type": "text/html; charset=utf-8", "set-cookie": buildCsrfCookie(csrf.cookieValue) });
			}

			if (request.method === "POST" && request.url.pathname === "/reauthenticate") {
				assertMediaType(request, "application/x-www-form-urlencoded");
				const body = parseUrlEncoded(request.bodyText);
				const { cookies, session } = await requireSession(identity, request, input.config, String(body.csrfToken ?? ""));
				const result = await identity.reauthenticate({ pin: String(body.pin ?? ""), session, sourceAddress });
				const rotatedCsrf = issueCsrf(input.config.sessionSigningKey);
				return redirect("/profile", [buildSessionCookie(result.sessionToken), buildCsrfCookie(rotatedCsrf.cookieValue)]);
			}

			if (request.method === "POST" && request.url.pathname === "/api/v1/auth/logout") {
				const { session } = await requireSession(identity, request, input.config, String(request.headers["x-csrf-token"] ?? ""));
				await identity.logout(session);
				return noContent([buildSessionCookie(null), buildCsrfCookie(null)]);
			}

			if (request.method === "POST" && request.url.pathname === "/logout") {
				assertMediaType(request, "application/x-www-form-urlencoded");
				const body = parseUrlEncoded(request.bodyText);
				const { session } = await requireSession(identity, request, input.config, String(body.csrfToken ?? ""));
				await identity.logout(session);
				return redirect("/unlock", [buildSessionCookie(null), buildCsrfCookie(null)]);
			}

			if (request.method === "GET" && request.url.pathname === "/search") {
				const { session } = await requireSession(identity, request, input.config);
				const query = request.url.searchParams.get("q") ?? "";
				if (!query) {
					return response(200, renderSearchPage({ css, profileName: session.profile.displayName, state: "idle" }), { "content-type": "text/html; charset=utf-8" });
				}
				const result = await catalog.search(session.profile.profileId, query);
				return response(200, renderSearchPage({
					css,
					profileName: session.profile.displayName,
					providers: result.providers.map((provider) => ({ checkedAt: provider.evidence.checkedAt, name: provider.displayName, reason: provider.reason, state: provider.providerAvailability })),
					query: result.query,
					results: result.items.map((item) => ({ acquisitionOptions: item.acquisitionOptions.map((option) => ({ estimatedBytes: option.estimatedBytes ?? undefined, format: option.format, id: option.optionId, rightsBasis: option.rightsBasis })), authors: item.creators, capability: item.capability, capabilityReason: item.capabilityReason, checkedAt: item.checkedAt, id: item.catalogRef, provenance: item.provenance, publishedYear: item.publishedYear ?? undefined, source: item.source, title: item.title })),
					state: result.items.length === 0 ? "no-results" : result.partial ? "partial" : "results",
				}), { "content-type": "text/html; charset=utf-8" });
			}

			if (request.method === "GET" && request.url.pathname === "/api/v1/catalog/search") {
				const { session } = await requireSession(identity, request, input.config);
				return json(await catalog.search(session.profile.profileId, request.url.searchParams.get("q") ?? ""));
			}

			if (request.method === "GET" && request.url.pathname.startsWith("/books/")) {
				const csrf = currentOrFreshCsrf(request, input.config);
				const { session } = await requireSession(identity, request, input.config);
				const catalogRef = decodeURIComponent(request.url.pathname.slice("/books/".length));
				const item = await catalog.detail(session.profile.profileId, catalogRef);
				return response(200, renderBookPage({
					book: {
						authors: item.creators,
						capability: item.capability,
						capabilityEvidence: item.capabilityEvidence.map((evidence) => ({ capability: evidence.capability, checkedAt: evidence.evidence.checkedAt, provider: evidence.providerId === "goodreads" ? "Goodreads" : "Amazon", reason: evidence.reason, source: evidence.evidence.sourceLabel, state: evidence.state })),
						capabilityReason: item.capabilityReason,
						provenance: item.provenance,
						checkedAt: item.checkedAt,
						id: item.catalogRef,
						acquisitionOptions: item.acquisitionOptions.map((option) => ({ estimatedBytes: option.estimatedBytes ?? undefined, format: option.format, id: option.optionId, rightsBasis: option.rightsBasis })),
						metadataEvidence: item.metadataEvidence.map((evidence) => ({ averageRating: evidence.averageRating, checkedAt: evidence.checkedAt, contributedFields: evidence.contributedFields, informationLink: evidence.informationLink, matchedBy: evidence.matchedBy, provider: evidence.providerLabel, ratingsCount: evidence.ratingsCount, recordId: evidence.recordId })),
						publishedYear: item.publishedYear ?? undefined,
						source: item.source,
						title: item.title,
					},
					csrfToken: csrf.token,
					css,
					profileName: session.profile.displayName,
					state: "item-detail",
				}), { "content-type": "text/html; charset=utf-8", "set-cookie": buildCsrfCookie(csrf.cookieValue) });
			}

			if (request.method === "GET" && request.url.pathname.startsWith("/api/v1/catalog/items/")) {
				const { session } = await requireSession(identity, request, input.config);
				const catalogRef = decodeURIComponent(request.url.pathname.slice("/api/v1/catalog/items/".length));
				return json(await catalog.detail(session.profile.profileId, catalogRef));
			}

			if (request.method === "GET" && request.url.pathname === "/api/v1/me/plugins") {
				await requireSession(identity, request, input.config);
				return json({ items: await catalog.listInstalledPlugins() });
			}

			if (request.method === "GET" && request.url.pathname === "/api/v1/me/capabilities") {
				await requireSession(identity, request, input.config);
				return json(buildCapabilityViews({
					configuredConnectorIds,
					googleBooksConfigured: input.config.applicationSecrets?.hasGoogleBooksApiKey() ?? false,
					installedPlugins,
					plugins: await catalog.listInstalledPlugins(),
				}));
			}

			if (request.method === "GET" && request.url.pathname === "/api/v1/me/accounts") {
				const { session } = await requireSession(identity, request, input.config);
				return json({ items: await accountConnectionViews(session.profile.profileId) });
			}

			const disconnectPreviewMatch = request.url.pathname.match(/^\/api\/v1\/me\/accounts\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/disconnect-preflights$/i);
			if (request.method === "POST" && disconnectPreviewMatch) {
				const { session } = await requireSession(identity, request, input.config, String(request.headers["x-csrf-token"] ?? ""));
				if (identity.requiresRecentAuth(session)) throw new ProblemError(403, "recent_authentication_required", "Recent authentication required");
				const account = (await accountConnectionViews(session.profile.profileId))
					.find((candidate) => candidate.accountId === disconnectPreviewMatch[1]);
				if (!account) throw new ProblemError(404, "not_found", "Not found");
				const createdAt = new Date();
				return json({
					preflightId: randomUUID(),
					account,
					affectedDestinations: [],
					affectedOperations: { cancelableQueued: 0, running: 0 },
					canSubmit: false,
					reasonCode: "DISCONNECT_AVAILABLE_IN_PHASE_4",
					reason: "Disconnect submission becomes available after destination and operation impact handling is implemented.",
					createdAt: createdAt.toISOString(),
					expiresAt: new Date(createdAt.getTime() + 5 * 60_000).toISOString(),
				});
			}

			const apiAuthorizationMatch = request.url.pathname.match(/^\/api\/v1\/me\/accounts\/([^/]+)\/authorizations$/);
			if (request.method === "POST" && apiAuthorizationMatch) {
				assertMediaType(request, "application/json");
				const purpose = authorizationRequest(parseJson(request.bodyText));
				const connectorId = providerConnectorId(apiAuthorizationMatch[1]!);
				if (!connectorId) throw new ProblemError(404, "not_found", "Not found");
				const { session } = await requireSession(identity, request, input.config, String(request.headers["x-csrf-token"] ?? ""));
				if (identity.requiresRecentAuth(session)) throw new ProblemError(403, "recent_authentication_required", "Recent authentication required");
				return await startProviderAuthorization(session, connectorId, purpose);
			}

			const htmlAuthorizationMatch = request.url.pathname.match(/^\/profile\/integrations\/([^/]+)\/(connect|reconnect)$/);
			if (request.method === "POST" && htmlAuthorizationMatch) {
				assertMediaType(request, "application/x-www-form-urlencoded");
				const parameters = new URLSearchParams(request.bodyText);
				if (parameters.getAll("csrfToken").length !== 1 || [...parameters.keys()].some((key) => key !== "csrfToken")) {
					throw new ProblemError(422, "validation_failed", "Validation failed");
				}
				const connectorId = providerConnectorId(htmlAuthorizationMatch[1]!);
				if (!connectorId) throw new ProblemError(404, "not_found", "Not found");
				const purpose = htmlAuthorizationMatch[2] as AuthorizationPurpose;
				const { session } = await requireSession(identity, request, input.config, parameters.get("csrfToken") ?? "");
				if (identity.requiresRecentAuth(session)) throw new ProblemError(403, "recent_authentication_required", "Recent authentication required");
				return await startProviderAuthorization(session, connectorId, purpose);
			}

			if (request.method === "GET" && request.url.pathname === "/api/v1/me/delivery") {
				const { session } = await requireSession(identity, request, input.config);
				return json(await delivery.readSettings(session.profile.profileId));
			}

			if (request.method === "PATCH" && request.url.pathname === "/api/v1/me/delivery") {
				assertMediaType(request, "application/json");
				const body = parseJson(request.bodyText);
				const { session } = await requireSession(identity, request, input.config, String(request.headers["x-csrf-token"] ?? ""));
				if (identity.requiresRecentAuth(session)) throw new ProblemError(403, "recent_authentication_required", "Recent authentication required");
				return json(await delivery.updateSettings(session, body.kindleAddress === null ? null : String(body.kindleAddress ?? "")));
			}

			if (request.method === "POST" && request.url.pathname === "/profile/delivery") {
				assertMediaType(request, "application/x-www-form-urlencoded");
				const body = parseUrlEncoded(request.bodyText);
				const { session } = await requireSession(identity, request, input.config, String(body.csrfToken ?? ""));
				if (identity.requiresRecentAuth(session)) throw new ProblemError(403, "recent_authentication_required", "Recent authentication required");
				await delivery.updateSettings(session, String(body.kindleAddress ?? ""));
				return redirect("/profile");
			}

			if (request.method === "POST" && request.url.pathname === "/api/v1/preflights/acquire-deliver") {
				assertMediaType(request, "application/json");
				const body = parseJson(request.bodyText);
				const { session } = await requireSession(identity, request, input.config, String(request.headers["x-csrf-token"] ?? ""));
				return json(await delivery.preflight(session, { itemId: String(body.itemId ?? ""), optionId: String(body.optionId ?? ""), pluginId: String(body.pluginId ?? "") }));
			}

			if (request.method === "POST" && request.url.pathname === "/delivery/preflight") {
				assertMediaType(request, "application/x-www-form-urlencoded");
				const body = parseUrlEncoded(request.bodyText);
				const { session } = await requireSession(identity, request, input.config, String(body.csrfToken ?? ""));
				const catalogRef = String(body.catalogRef ?? "");
				const match = catalogRef.match(/^plugin:([^:]+):(.+)$/);
				if (!match) throw new ProblemError(404, "not_found", "Not found");
				const preflight = await delivery.preflight(session, { itemId: match[2]!, optionId: String(body.optionId ?? ""), pluginId: match[1]! });
				return response(200, renderPreflightPage({ csrfToken: String(body.csrfToken), css, preflight, profileName: session.profile.displayName }), { "content-type": "text/html; charset=utf-8" });
			}

			if (request.method === "GET" && request.url.pathname === "/api/v1/operations") {
				const { session } = await requireSession(identity, request, input.config);
				return json({ items: await delivery.list(session.profile.profileId), nextCursor: null });
			}

			if (request.method === "POST" && request.url.pathname === "/api/v1/operations") {
				assertMediaType(request, "application/json");
				const body = parseJson(request.bodyText);
				const { session } = await requireSession(identity, request, input.config, String(request.headers["x-csrf-token"] ?? ""));
				if (identity.requiresRecentAuth(session)) throw new ProblemError(403, "recent_authentication_required", "Recent authentication required");
				const receipt = await delivery.queue(session, { idempotencyKey: String(request.headers["idempotency-key"] ?? ""), preflightId: String(body.preflightId ?? "") });
				return response(202, JSON.stringify(receipt), { "content-type": "application/json; charset=utf-8", location: receipt.statusUrl, "retry-after": "2" });
			}

			if (request.method === "POST" && request.url.pathname === "/operations") {
				assertMediaType(request, "application/x-www-form-urlencoded");
				const body = parseUrlEncoded(request.bodyText);
				const { session } = await requireSession(identity, request, input.config, String(body.csrfToken ?? ""));
				if (identity.requiresRecentAuth(session)) throw new ProblemError(403, "recent_authentication_required", "Recent authentication required");
				const receipt = await delivery.queue(session, { idempotencyKey: randomUUID(), preflightId: String(body.preflightId ?? "") });
				return redirect(`/activity/${receipt.operationId}`);
			}

			if (request.method === "GET" && request.url.pathname === "/activity") {
				const { session } = await requireSession(identity, request, input.config);
				const operations = (await delivery.list(session.profile.profileId)).map((operation: any) => ({ deliveryEvidence: operation.deliveryEvidence.state, operationId: operation.operationId, status: operation.status, title: operation.target.title, updatedAt: operation.updatedAt }));
				return response(200, renderActivityPage({ css, operations, profileName: session.profile.displayName }), { "content-type": "text/html; charset=utf-8" });
			}

			if (request.method === "GET" && request.url.pathname.startsWith("/api/v1/operations/")) {
				const { session } = await requireSession(identity, request, input.config);
				return json(await delivery.read(session.profile.profileId, request.url.pathname.slice("/api/v1/operations/".length)));
			}

			if (request.method === "GET" && /^\/activity\/[0-9a-f-]+$/i.test(request.url.pathname)) {
				const csrf = currentOrFreshCsrf(request, input.config);
				const { session } = await requireSession(identity, request, input.config);
				const raw: any = await delivery.read(session.profile.profileId, request.url.pathname.slice("/activity/".length));
				const operation = { ...raw, csrfToken: csrf.token, target: { ...raw.target, maskedDestination: (await delivery.readSettings(session.profile.profileId)).maskedAddress ?? "Not configured" } };
				return response(200, renderOperationPage({ css, operation, profileName: session.profile.displayName }), { "content-type": "text/html; charset=utf-8", "set-cookie": buildCsrfCookie(csrf.cookieValue) });
			}

			const cancelMatch = request.url.pathname.match(/^\/(?:api\/v1\/operations|activity)\/([0-9a-f-]+)\/cancel$/i);
			if (request.method === "POST" && cancelMatch) {
				const body = request.bodyText ? parseUrlEncoded(request.bodyText) : {};
				const { session } = await requireSession(identity, request, input.config, request.url.pathname.startsWith("/api/") ? String(request.headers["x-csrf-token"] ?? "") : String(body.csrfToken ?? ""));
				const receipt = await delivery.cancel(session.profile.profileId, cancelMatch[1]!);
				return request.url.pathname.startsWith("/api/") ? response(202, JSON.stringify(receipt), { "content-type": "application/json; charset=utf-8" }) : redirect(`/activity/${receipt.operationId}`);
			}

			const confirmMatch = request.url.pathname.match(/^\/(?:api\/v1\/operations|activity)\/([0-9a-f-]+)\/confirm-received$/i);
			if (request.method === "POST" && confirmMatch) {
				const body = request.bodyText ? parseUrlEncoded(request.bodyText) : {};
				const { session } = await requireSession(identity, request, input.config, request.url.pathname.startsWith("/api/") ? String(request.headers["x-csrf-token"] ?? "") : String(body.csrfToken ?? ""));
				await delivery.confirmReceived(session.profile.profileId, confirmMatch[1]!, session.profile.displayName);
				return request.url.pathname.startsWith("/api/") ? noContent() : redirect(`/activity/${confirmMatch[1]}`);
			}

			if (request.method === "GET" && request.url.pathname === "/profile") {
				const csrf = currentOrFreshCsrf(request, input.config);
				const { session } = await requireSession(identity, request, input.config);
				const [accountConnections, plugins, deliverySettings] = await Promise.all([
					accountConnectionViews(session.profile.profileId),
					catalog.listInstalledPlugins(),
					delivery.readSettings(session.profile.profileId),
				]);
				return response(200, renderProfilePage({ accountConnections: accountConnections.map(toProfileAccountConnection), css, csrfToken: csrf.token, delivery: deliverySettings, plugins, profileName: session.profile.displayName, recentAuthenticationRequired: identity.requiresRecentAuth(session) }), { "content-type": "text/html; charset=utf-8", "set-cookie": buildCsrfCookie(csrf.cookieValue) });
			}

			if (request.method === "POST" && request.url.pathname === "/api/v1/me/pin") {
				assertMediaType(request, "application/json");
				const body = parseJson(request.bodyText);
				const { session } = await requireSession(identity, request, input.config, String(request.headers["x-csrf-token"] ?? ""));
				if (identity.requiresRecentAuth(session)) {
					throw new ProblemError(403, "recent_authentication_required", "Recent authentication required");
				}
				await identity.changePin({ currentPin: String(body.currentPin ?? ""), newPin: String(body.newPin ?? ""), session, sourceAddress });
				return noContent([buildSessionCookie(null), buildCsrfCookie(null)]);
			}

			if (request.method === "POST" && request.url.pathname === "/profile/pin") {
				assertMediaType(request, "application/x-www-form-urlencoded");
				const body = parseUrlEncoded(request.bodyText);
				const { session } = await requireSession(identity, request, input.config, String(body.csrfToken ?? ""));
				if (identity.requiresRecentAuth(session)) {
					throw new ProblemError(403, "recent_authentication_required", "Recent authentication required");
				}
				if (body.newPin !== body.confirmPin) {
					throw new ProblemError(422, "validation_failed", "Validation failed", "PIN confirmation does not match.");
				}
				await identity.changePin({ currentPin: String(body.currentPin ?? ""), newPin: String(body.newPin ?? ""), session, sourceAddress });
				return redirect("/unlock", [buildSessionCookie(null), buildCsrfCookie(null)]);
			}

			throw new ProblemError(404, "not_found", "Not found");
		} catch (error) {
			if (!request.url.pathname.startsWith("/api/") && request.url.pathname !== "/healthz" && request.url.pathname !== "/readyz") {
				const problem = toProblemShape(error, requestId);
				const returnHref = request.url.pathname === "/setup" ? "/setup" : request.url.pathname.startsWith("/profile") || request.url.pathname === "/reauthenticate" ? "/profile" : "/unlock";
				return response(problem.status, renderProblemPage({ code: problem.code, css, requestId, returnHref, status: problem.status, title: problem.title }), { "content-type": "text/html; charset=utf-8" });
			}
			return problemJson(error, requestId);
		}
	};
}