import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { ApplicationShell } from "./ApplicationShell";
import { AccountDisconnectReview, ProfileSettings, type ProfileAccountConnection, type SenderState } from "./ProfileSettings";

const checkedAt = "2026-07-17T14:31:00Z";
const meta = { title: "Profile", component: ProfileSettings, decorators: [(Story) => <ApplicationShell activeRoute="profile"><Story /></ApplicationShell>], parameters: { layout: "fullscreen" } } satisfies Meta<typeof ProfileSettings>;
export default meta;
type Story = StoryObj<typeof meta>;
const sender = (status: SenderState, reason?: string) => ({ status, source: "Household mail relay", checkedAt, reason });
const account = (input: Partial<ProfileAccountConnection> & Pick<ProfileAccountConnection, "connectorId" | "displayName" | "reason" | "state">): ProfileAccountConnection => ({
	canConnect: input.state === "not-configured",
	canDisconnect: false,
	canReconnect: input.state === "expired-or-revoked" || input.state === "error",
	capabilities: [],
	checkedAt,
	grantedScopes: [],
	providerAvailability: "available",
	source: "Provider account record",
	...input,
});
export const NoKindle: Story = { args: { destinationStatus: "not-configured", maskedAddress: null, profileName: "Member 2", sender: sender("ready") } };
export const Ready: Story = {
	args: {
		destinationStatus: "ready",
		maskedAddress: "m••••••@kindle.com",
		plugins: [
			{ displayName: "Project Gutenberg", pluginId: "project-gutenberg", support: "available" },
			{ displayName: "Standard Ebooks", pluginId: "standard-ebooks", support: "available" },
			{ displayName: "Internet Archive", pluginId: "internet-archive", support: "available" },
		],
		profileName: "Member 2",
		sender: sender("ready"),
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getAllByText("Installed source")).toHaveLength(3);
		await expect(canvas.queryByRole("button", { name: /enable|disable/i })).not.toBeInTheDocument();
		await expect(canvas.getByLabelText("Current PIN")).toBeRequired();
		await expect(canvas.getByLabelText("New PIN")).toBeRequired();
		await expect(canvas.getByLabelText("Confirm new PIN")).toBeRequired();
	},
};
export const SenderConfigurationRequired: Story = { args: { destinationStatus: "ready", maskedAddress: "m••••••@kindle.com", profileName: "Member 2", sender: sender("configuration-required", "Connect the household sender before submitting books.") } };
export const SenderRevoked: Story = { args: { destinationStatus: "ready", maskedAddress: "m••••••@kindle.com", profileName: "Member 2", sender: sender("revoked", "The mail provider revoked authorization.") } };
export const SenderRejected: Story = { args: { destinationStatus: "ready", maskedAddress: "m••••••@kindle.com", profileName: "Member 2", sender: sender("rejected", "The mail provider rejected the sender configuration.") } };
export const SenderUnknown: Story = { args: { destinationStatus: "ready", maskedAddress: "m••••••@kindle.com", profileName: "Member 2", sender: sender("unknown", "Sender readiness could not be checked.") } };
export const AccountsConnected: Story = {
	args: {
		accountConnections: [
			account({ accountId: "51043da8-d5f0-43ea-b92a-9e8475b0c052", capabilities: ["identity-only"], connectorId: "google-gmail", displayName: "Google", grantedScopes: ["openid", "email"], maskedAccount: "m••••••@gmail.com", reason: "Google identity is connected to this profile. It does not enable Gmail sending.", state: "connected" }),
			account({ accountId: "f82b00ba-7898-4d4c-a93d-94619f032546", capabilities: ["identity-only"], connectorId: "login-with-amazon", displayName: "Amazon", grantedScopes: ["profile:user_id"], maskedAccount: "Amazon account ••52", reason: "Identity only. Kindle purchases, library access, and Kindle Unlimited are not exposed.", state: "connected" }),
		],
		destinationStatus: "ready",
		maskedAddress: "m••••••@kindle.com",
		profileName: "Member 2",
		sender: sender("ready"),
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByText(/Kindle purchases, library access, and Kindle Unlimited are not exposed/i)).toBeInTheDocument();
		await expect(canvas.getAllByText(/Disconnect becomes available with destination impact handling/i)).toHaveLength(2);
		await expect(canvas.queryByRole("button", { name: /enable|disable/i })).not.toBeInTheDocument();
	},
};
export const AccountNotConfigured: Story = { args: { accountConnections: [account({ connectorId: "google-gmail", displayName: "Google", reason: "Connect Google identity to this profile.", state: "not-configured" })], destinationStatus: "ready", maskedAddress: "m••••••@kindle.com", profileName: "Member 2", sender: sender("configuration-required") } };
export const AccountConnecting: Story = { args: { accountConnections: [account({ connectorId: "login-with-amazon", displayName: "Amazon", reason: "The identity authorization response has not completed.", state: "connecting" })], destinationStatus: "ready", maskedAddress: "m••••••@kindle.com", profileName: "Member 2", sender: sender("ready") } };
export const AccountExpiredOrRevoked: Story = { args: { accountConnections: [account({ accountId: "51043da8-d5f0-43ea-b92a-9e8475b0c052", connectorId: "google-gmail", displayName: "Google", maskedAccount: "m••••••@gmail.com", reason: "Google rejected refresh authorization. Reconnect before sending.", state: "expired-or-revoked" })], destinationStatus: "ready", maskedAddress: "m••••••@kindle.com", profileName: "Member 2", sender: sender("revoked") } };
export const AccountError: Story = { args: { accountConnections: [account({ accountId: "f82b00ba-7898-4d4c-a93d-94619f032546", connectorId: "login-with-amazon", displayName: "Amazon", reason: "Amazon identity readiness could not be checked. Existing credentials have not been replaced.", state: "error" })], destinationStatus: "ready", maskedAddress: "m••••••@kindle.com", profileName: "Member 2", sender: sender("ready") } };
export const AccountConfigurationRequired: Story = { args: { accountConnections: [account({ canConnect: false, connectorId: "google-gmail", displayName: "Google", providerAvailability: "configuration-required", reason: "The operator must register the exact Google callback before accounts can connect.", source: "Deployment capability inventory", state: "not-configured" })], destinationStatus: "ready", maskedAddress: "m••••••@kindle.com", profileName: "Member 2", sender: sender("configuration-required") } };
export const AccountConnectionCompleted: Story = { args: { accountConnections: [account({ accountId: "51043da8-d5f0-43ea-b92a-9e8475b0c052", capabilities: ["identity-only"], connectorId: "google-gmail", displayName: "Google", grantedScopes: ["openid", "email"], maskedAccount: "m••••••@gmail.com", reason: "Google identity is connected to this profile.", state: "connected" })], destinationStatus: "ready", integrationResult: { heading: "Google connected", message: "The authorization response was validated and stored for Member 2. It did not sign you in to k.", status: "connected" }, maskedAddress: "m••••••@kindle.com", profileName: "Member 2", sender: sender("ready") } };
export const AccountConnectionDenied: Story = { args: { accountConnections: [account({ connectorId: "google-gmail", displayName: "Google", reason: "Connect Google identity to this profile.", state: "not-configured" })], destinationStatus: "ready", integrationResult: { heading: "Google was not connected", message: "Consent was denied. No existing credential was replaced.", status: "denied" }, maskedAddress: "m••••••@kindle.com", profileName: "Member 2", sender: sender("configuration-required") } };
export const AccountConnectionExpired: Story = { args: { accountConnections: [account({ connectorId: "google-gmail", displayName: "Google", reason: "Connect Google identity to this profile.", state: "not-configured" })], destinationStatus: "ready", integrationResult: { heading: "Connection check expired", message: "Start a new Google identity connection from this profile. The previous response cannot be replayed.", status: "expired" }, maskedAddress: "m••••••@kindle.com", profileName: "Member 2", sender: sender("ready") } };
export const AccountConnectionInvalid: Story = { args: { accountConnections: [account({ connectorId: "login-with-amazon", displayName: "Amazon", reason: "Amazon remains disconnected.", state: "error" })], destinationStatus: "ready", integrationResult: { heading: "Amazon response was not accepted", message: "The response did not match the connection started in this browser. No credential was stored.", status: "invalid" }, maskedAddress: "m••••••@kindle.com", profileName: "Member 2", sender: sender("ready") } };
export const AccountDisconnectReviewStory: Story = {
	name: "AccountDisconnectReview",
	args: { destinationStatus: "ready", maskedAddress: "m••••••@kindle.com", profileName: "Member 2", sender: sender("ready") },
	render: () => <AccountDisconnectReview account={{ accountId: "51043da8-d5f0-43ea-b92a-9e8475b0c052", displayName: "Google", maskedAccount: "m••••••@gmail.com", reason: "This identity-only connection belongs to Member 2's profile." }} expiresAt="2026-07-17T14:43:00Z" preflightId="a8bd2fd5-80e0-4f92-9f31-c70f0f776d5e" />,
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByText(/informational preview does not disconnect/i)).toBeInTheDocument();
		await expect(canvas.queryByRole("button", { name: "Disconnect Google" })).not.toBeInTheDocument();
	},
};
export const RecentAuthenticationRequired: Story = { args: { destinationStatus: "ready", maskedAddress: "m••••••@kindle.com", profileName: "Member 2", recentAuthenticationRequired: true, sender: sender("ready") } };
export const PinChanged: Story = { args: { destinationStatus: "ready", maskedAddress: "m••••••@kindle.com", profileName: "Member 2", sender: sender("ready"), state: "pin-changed" } };
export const PinError: Story = { args: { destinationStatus: "ready", maskedAddress: "m••••••@kindle.com", pinError: "The current PIN was not accepted.", profileName: "Member 2", sender: sender("ready") } };