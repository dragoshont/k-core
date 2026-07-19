import { renderToStaticMarkup } from "react-dom/server";
import { ApplicationShell, type NavigationRoute } from "../../ui/ApplicationShell";
import { PinSetupForm, PinUnlockForm, ProfilePicker, type HouseholdProfile } from "../../ui/Authentication";
import { BookDetail, BookSearch, type BookResult, type ProviderEvidence } from "../../ui/BookSearch";
import { ProfileSettings, type ProfileAccountConnection, type ProfileSettingsProps } from "../../ui/ProfileSettings";
import { DeliveryPreflight } from "../../ui/DeliveryPreflight";
import { ActivityList, OperationTimeline, type OperationListItem, type OperationTimelineProps } from "../../ui/OperationTimeline";
import type { ProfilePluginView } from "../plugins/catalog";

const phase3Routes: NavigationRoute[] = [
	{ href: "/search", id: "search", label: "Search" },
	{ href: "/activity", id: "activity", label: "Activity" },
	{ href: "/profile", id: "profile", label: "Profile" },
];

function document(title: string, body: string, css: { styles: string; tokens: string }) {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>${css.tokens}\n${css.styles}</style></head><body>${body}</body></html>`;
}

function escapeHtml(value: string) {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function renderProblemPage(input: { code: string; css: { styles: string; tokens: string }; requestId: string; returnHref: string; status: number; title: string }) {
	const content = `<section class="notice notice--danger" data-problem-code="${escapeHtml(input.code)}"><h1>${escapeHtml(input.title)}</h1><p>The request could not be completed. No PIN or credential value was retained.</p><p class="evidence">Request ${escapeHtml(input.requestId)}</p><a class="button-link button-link--secondary" href="${escapeHtml(input.returnHref)}">Return</a></section>`;
	return document(`Error: ${input.title}`, authPage("Something went wrong", "Review the error and try again safely.", content), input.css);
}

function authPage(title: string, description: string, content: string) {
	return `<main id="main" class="app-shell"><a class="skip-link" href="#main">Skip to content</a><div class="auth-page"><header class="auth-header"><a class="wordmark" href="/" aria-label="k home">k</a><h1>${escapeHtml(title)}</h1><p>${escapeHtml(description)}</p></header>${content}</div></main>`;
}

export function renderUnlockPage(input: { css: { styles: string; tokens: string }; csrfToken: string; profiles: HouseholdProfile[]; selectedProfile?: HouseholdProfile; error?: string; delayedUntil?: string }) {
	const content = input.selectedProfile
		? renderToStaticMarkup(<PinUnlockForm csrfToken={input.csrfToken} delayedUntil={input.delayedUntil} error={input.error} profileId={input.selectedProfile.id} profileName={input.selectedProfile.displayName} state={input.delayedUntil ? "delayed" : input.error ? "invalid" : "ready"} />)
		: renderToStaticMarkup(<ProfilePicker profiles={input.profiles} />);
	return document("Unlock k", authPage(input.selectedProfile ? `Hi, ${input.selectedProfile.displayName}` : "Welcome back", input.selectedProfile ? "Enter your four-digit PIN." : "Choose your household profile.", content), input.css);
	}

export function renderSetupPage(input: { css: { styles: string; tokens: string }; csrfToken: string; profile: HouseholdProfile; error?: string; purpose?: "setup" | "recovery" }) {
	const content = renderToStaticMarkup(
		<PinSetupForm csrfToken={input.csrfToken} error={input.error} profileId={input.profile.id} profileName={input.profile.displayName} purpose={input.purpose ?? "setup"} state={input.error ? "invalid" : "ready"} />,
	);
	return document("Set PIN", authPage(`Set ${input.profile.displayName}'s PIN`, "Use the one-time code provided by the household operator.", content), input.css);
	}

export function renderSearchPage(input: { css: { styles: string; tokens: string }; profileName: string; query?: string; results?: BookResult[]; providers?: ProviderEvidence[]; state: "idle" | "failed" | "no-results" | "partial" | "results" }) {
	const body = renderToStaticMarkup(
		<ApplicationShell activeRoute="search" navigationRoutes={phase3Routes} profileName={input.profileName}>
			<BookSearch providers={input.providers} query={input.query} results={input.results} state={input.state} />
		</ApplicationShell>,
	);
	return document(input.query ? `Search ${input.query}` : "Search", body, input.css);
	}

export function renderBookPage(input: { book?: BookResult; csrfToken: string; css: { styles: string; tokens: string }; profileName: string; state: "item-detail" | "item-not-found" }) {
	const body = renderToStaticMarkup(
		<ApplicationShell activeRoute="search" navigationRoutes={phase3Routes} profileName={input.profileName}>
			<BookDetail book={input.book} csrfToken={input.csrfToken} state={input.state} />
		</ApplicationShell>,
	);
	return document(input.book?.title ?? "Book information", body, input.css);
	}

export function renderProfilePage(input: { accountConnections?: ProfileAccountConnection[]; css: { styles: string; tokens: string }; csrfToken: string; delivery: { destinationStatus: "not-configured" | "ready"; maskedAddress: string | null; sender: { checkedAt: string; reason: string | null; source: string; status: "ready" | "configuration-required" | "revoked" | "rejected" | "unknown" } }; pinError?: string; plugins: ProfilePluginView[]; profileName: string; recentAuthenticationRequired?: boolean; state?: "default" | "pin-changed" }) {
	const body = renderToStaticMarkup(
		<ApplicationShell activeRoute="profile" navigationRoutes={phase3Routes} profileName={input.profileName}>
			<ProfileSettings accountConnections={input.accountConnections} csrfToken={input.csrfToken} deliverySettingsVisible destinationStatus={input.delivery.destinationStatus} maskedAddress={input.delivery.maskedAddress} pinError={input.pinError} plugins={input.plugins} profileName={input.profileName} recentAuthenticationRequired={input.recentAuthenticationRequired} sender={input.delivery.sender} state={input.state} />
		</ApplicationShell>,
	);
	return document("Profile", body, input.css);
	}

export function renderIntegrationCompletionPage(input: { css: { styles: string; tokens: string }; integrationResult: NonNullable<ProfileSettingsProps["integrationResult"]> }) {
	const body = renderToStaticMarkup(
		<ApplicationShell activeRoute="profile" navigationRoutes={phase3Routes} profileName="Profile">
			<ProfileSettings completionOnly deliverySettingsVisible={false} destinationStatus="not-configured" integrationResult={input.integrationResult} maskedAddress={null} profileName="Profile" sender={{ checkedAt: new Date().toISOString(), source: "Provider account record", status: "unknown" }} />
		</ApplicationShell>,
	);
	return document("Account connection", body, input.css);
}

	export function renderPreflightPage(input: { csrfToken: string; css: { styles: string; tokens: string }; preflight: any; profileName: string }) {
		const state = input.preflight.ready ? (input.preflight.warnings.length ? "warning" : "ready") : input.preflight.blockers.some((blocker: { code: string }) => blocker.code.includes("configuration") || blocker.code === "destination_required") ? "configuration-required" : "blocked";
		const body = renderToStaticMarkup(
			<ApplicationShell activeRoute="search" navigationRoutes={phase3Routes} profileName={input.profileName}>
				<DeliveryPreflight blockers={input.preflight.blockers} checkedAt={input.preflight.createdAt} csrfToken={input.csrfToken} destination={input.preflight.destination.maskedAddress} estimatedBytes={input.preflight.selectedOption.estimatedBytes} expiresAt={input.preflight.expiresAt} format="epub" maximumFileBytes={input.preflight.limits.maximumFileBytes} metadataSource={input.preflight.outputPlan.metadataSource} outputFormat="epub" preflightId={input.preflight.preflightId} previousSubmissions={input.preflight.previousSubmissions} profileName={input.profileName} provider={input.preflight.item.source} rightsBasis="public-domain" state={state} title={input.preflight.item.title} warnings={input.preflight.warnings} />
			</ApplicationShell>,
		);
		return document(`Preflight ${input.preflight.item.title}`, body, input.css);
	}

	export function renderActivityPage(input: { css: { styles: string; tokens: string }; operations: OperationListItem[]; profileName: string }) {
		const body = renderToStaticMarkup(<ApplicationShell activeRoute="activity" navigationRoutes={phase3Routes} profileName={input.profileName}><ActivityList operations={input.operations} /></ApplicationShell>);
		return document("Activity", body, input.css);
	}

	export function renderOperationPage(input: { css: { styles: string; tokens: string }; operation: OperationTimelineProps; profileName: string }) {
		const body = renderToStaticMarkup(<ApplicationShell activeRoute="activity" navigationRoutes={phase3Routes} profileName={input.profileName}><OperationTimeline {...input.operation} /></ApplicationShell>);
		return document(input.operation.target.title, body, input.css);
	}

export function renderReauthPage(input: { css: { styles: string; tokens: string }; csrfToken: string; profile: HouseholdProfile; error?: string; delayedUntil?: string }) {
	const content = renderToStaticMarkup(
		<PinUnlockForm csrfToken={input.csrfToken} delayedUntil={input.delayedUntil} error={input.error} profileId={input.profile.id} profileName={input.profile.displayName} recentAuthentication state={input.delayedUntil ? "delayed" : input.error ? "invalid" : "ready"} />,
	);
	return document("Confirm PIN", authPage("Confirm it is you", "This protects your profile changes.", content), input.css);
	}