export type CredentialState = "setup-required" | "ready" | "recovery-required";

export interface ProfileSummary {
	checkedAt: string;
	credentialState: CredentialState;
	displayName: string;
	profileId: string;
	slug: string;
}

export interface SessionView {
	absoluteExpiresAt: string;
	createdAt: string;
	csrfToken: string;
	idleExpiresAt: string;
	profile: ProfileSummary;
	recentAuthenticationAt: string;
}

export interface AuthAttemptResult {
	retryAt?: string;
	status: "allowed" | "delayed";
	throttleScope: "credential" | "pin";
}

export interface ActiveSession {
	absoluteExpiresAt: Date;
	createdAt: Date;
	idleExpiresAt: Date;
	lastSeenAt: Date;
	profile: ProfileSummary;
	recentAuthAt: Date;
	sessionId: string;
	tokenDigest: Buffer;
	revokedAt: Date | null;
	revocationReason: string | null;
}