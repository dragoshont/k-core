import { formatEvidenceTime } from "./format";

export type SenderState = "ready" | "configuration-required" | "revoked" | "rejected" | "unknown";
export type ProviderAvailability = "available" | "configuration-required" | "eligibility-required" | "unsupported" | "not-exposed";
export type AccountConnectionState = "not-configured" | "connecting" | "connected" | "expired-or-revoked" | "error";

export interface ProfileAccountConnection {
  accountId?: string;
  canConnect: boolean;
  canDisconnect: false;
  canReconnect: boolean;
  capabilities: Array<"identity-only">;
  checkedAt: string;
  connectorId: "google-gmail" | "login-with-amazon";
  displayName: string;
  grantedScopes: string[];
  maskedAccount?: string | null;
  providerAvailability: ProviderAvailability;
  reason: string;
  source: string;
  state: AccountConnectionState;
}

export interface ProfilePluginSetting {
  displayName: string;
  pluginId: string;
  reason?: string | null;
  support: "available" | "blocked" | "unavailable";
}

export interface ProfileSettingsProps {
  accountConnections?: ProfileAccountConnection[];
	csrfToken?: string;
  completionOnly?: boolean;
  destinationStatus: "not-configured" | "ready";
  deliverySettingsVisible?: boolean;
  maskedAddress: string | null;
	pinError?: string;
  plugins?: ProfilePluginSetting[];
  profileName: string;
  recentAuthenticationRequired?: boolean;
  sender: { status: SenderState; source: string; checkedAt: string; reason?: string | null };
	integrationResult?: { heading: string; message: string; status: "connected" | "denied" | "expired" | "invalid" };
  state?: "default" | "pin-changed";
}

export interface AccountDisconnectReviewProps {
  account: Pick<ProfileAccountConnection, "accountId" | "displayName" | "maskedAccount" | "reason">;
  expiresAt: string;
  preflightId: string;
}

const senderLabels: Record<SenderState, string> = {
  ready: "Sender ready", "configuration-required": "Sender setup required", revoked: "Sender revoked",
  rejected: "Sender rejected", unknown: "Sender status unknown",
};

const accountStateLabels: Record<AccountConnectionState, string> = {
  "not-configured": "Not connected",
  connecting: "Connection pending",
  connected: "Connected",
  "expired-or-revoked": "Reconnect required",
  error: "Connection error",
};

function accountTone(connection: ProfileAccountConnection) {
  if (connection.state === "connected") return "success";
  if (connection.state === "expired-or-revoked" || connection.state === "error") return "danger";
  return "warning";
}

function capabilityLabel(value: string) {
  return value.replaceAll("-", " ").replace(/^./, (first) => first.toUpperCase());
}

function IntegrationResultNotice({ result }: { result: NonNullable<ProfileSettingsProps["integrationResult"]> }) {
  return (
    <section className={`notice notice--${result.status === "connected" ? "success" : result.status === "invalid" ? "danger" : "warning"}`} role={result.status === "invalid" ? "alert" : "status"}>
      <h2>{result.heading}</h2>
      <p>{result.message}</p>
    </section>
  );
}

export function ProfileSettings({
	accountConnections = [],
  csrfToken = "storybook-csrf-token-not-a-secret",
	completionOnly = false,
	destinationStatus,
	deliverySettingsVisible = true,
	maskedAddress,
  pinError,
	plugins = [],
	profileName,
	recentAuthenticationRequired = false,
	sender,
  integrationResult,
	state = "default",
}: ProfileSettingsProps) {
  if (completionOnly) {
    return (
      <div>
        <header className="page-heading"><p className="eyebrow">Account connection</p><h1>Profile</h1></header>
        {integrationResult && <IntegrationResultNotice result={integrationResult} />}
        <p><a className="button-link button-link--secondary" href="/profile">Return to profile</a></p>
      </div>
    );
  }

  return (
    <div>
      <header className="page-heading"><p className="eyebrow">{profileName}</p><h1>Profile</h1><p>{deliverySettingsVisible ? "Kindle delivery is optional. Search remains available without it." : "Search remains available even when delivery settings are unavailable."}</p></header>
      {integrationResult && <IntegrationResultNotice result={integrationResult} />}
      {state === "pin-changed" && <section className="confirmation"><h2>PIN changed</h2><p>Every session for {profileName} has been signed out.</p><a href="/unlock">Return to unlock</a></section>}
      {recentAuthenticationRequired && <section className="notice notice--warning"><h2>Confirm your PIN</h2><p>Enter your PIN again before changing delivery settings.</p><a href="/reauthenticate">Confirm PIN</a></section>}
      {deliverySettingsVisible && (
        <>
          <section className="settings-section" aria-labelledby="kindle-settings-title">
            <h2 id="kindle-settings-title">Kindle destination</h2>
            <p className="settings-status">{destinationStatus === "ready" ? `Current address ${maskedAddress}` : "No Kindle address configured"}</p>
            <form className="settings-form" method="post" action="/profile/delivery">
              <div className="field"><label htmlFor="kindle-address">Kindle email address</label><p id="kindle-hint">The full stored address is never shown. Enter a complete address to replace it.</p><input aria-describedby="kindle-hint" autoComplete="email" id="kindle-address" name="kindleAddress" type="email" /></div>
              <button disabled={recentAuthenticationRequired} type="submit">Save Kindle address</button>
            </form>
          </section>
          <section className="settings-section" aria-labelledby="sender-title">
            <h2 id="sender-title">Household sender</h2>
            <p><span className={`status-badge status-badge--${sender.status === "ready" ? "success" : sender.status === "rejected" || sender.status === "revoked" ? "danger" : "warning"}`}>{senderLabels[sender.status]}</span></p>
            {sender.reason && <p>{sender.reason}</p>}
            <p className="evidence">{sender.source} · <time dateTime={sender.checkedAt}>{formatEvidenceTime(sender.checkedAt)}</time></p>
          </section>
        </>
      )}
      {accountConnections.length > 0 && (
        <section className="settings-section" aria-labelledby="account-connections-title">
          <h2 id="account-connections-title">Account connections</h2>
          <ul className="settings-list">
            {accountConnections.map((connection) => (
              <li key={connection.connectorId}>
                <div>
                  <strong>{connection.displayName}</strong>
                  <p><span className={`status-badge status-badge--${accountTone(connection)}`}>{accountStateLabels[connection.state]}</span></p>
                  {connection.maskedAccount && <p>{connection.maskedAccount}</p>}
                  <p>{connection.reason}</p>
                  {connection.capabilities.length > 0 && <p>{connection.capabilities.map(capabilityLabel).join(" · ")}</p>}
                  {connection.grantedScopes.length > 0 && <p className="evidence">Granted access: {connection.grantedScopes.join(", ")}</p>}
                  <p className="evidence">{connection.source} · <time dateTime={connection.checkedAt}>{formatEvidenceTime(connection.checkedAt)}</time></p>
                </div>
                <div className="settings-actions">
                  {connection.canConnect && (
                    <form method="post" action={`/profile/integrations/${encodeURIComponent(connection.connectorId)}/connect`}>
                      <input type="hidden" name="csrfToken" value={csrfToken} />
                      <button disabled={recentAuthenticationRequired || connection.providerAvailability !== "available"} type="submit">Connect</button>
                    </form>
                  )}
                  {connection.canReconnect && (
                    <form method="post" action={`/profile/integrations/${encodeURIComponent(connection.connectorId)}/reconnect`}>
                      <input type="hidden" name="csrfToken" value={csrfToken} />
                      <button disabled={recentAuthenticationRequired} type="submit">Reconnect</button>
                    </form>
                  )}
                  {connection.accountId && <span className="settings-status">Disconnect becomes available with destination impact handling.</span>}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="settings-section" aria-labelledby="source-plugins-title">
        <h2 id="source-plugins-title">Book sources</h2>
        <p>Installed book sources are active by deployment. Sources without verified provenance remain information-only.</p>
        {plugins.length === 0 ? (
          <p className="settings-status">No source plugins are installed.</p>
        ) : (
          <ul className="settings-list">
            {plugins.map((plugin) => (
              <li key={plugin.pluginId}>
                <div>
                  <strong>{plugin.displayName}</strong>
                  <p>Installed source</p>
                  {plugin.reason && <p>{plugin.reason}</p>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="settings-section" aria-labelledby="pin-settings-title">
        <h2 id="pin-settings-title">Change PIN</h2>
        {pinError && <div className="error-summary" role="alert"><h3>PIN could not be changed</h3><p>{pinError}</p></div>}
        <form className="settings-form" method="post" action="/profile/pin">
          <input type="hidden" name="csrfToken" value={csrfToken} />
          <div className="field"><label htmlFor="current-pin">Current PIN</label><input autoComplete="current-password" id="current-pin" inputMode="numeric" maxLength={4} minLength={4} name="currentPin" pattern="[0-9]{4}" required type="password" /></div>
          <div className="field"><label htmlFor="profile-new-pin">New PIN</label><input autoComplete="new-password" id="profile-new-pin" inputMode="numeric" maxLength={4} minLength={4} name="newPin" pattern="[0-9]{4}" required type="password" /></div>
          <div className="field"><label htmlFor="profile-confirm-pin">Confirm new PIN</label><input autoComplete="new-password" id="profile-confirm-pin" inputMode="numeric" maxLength={4} minLength={4} name="confirmPin" pattern="[0-9]{4}" required type="password" /></div>
          <button className="button--secondary" type="submit">Change PIN and sign out</button>
        </form>
      </section>
      <section className="settings-section" aria-labelledby="session-title">
        <h2 id="session-title">Session</h2>
        <form method="post" action="/logout">
          <input type="hidden" name="csrfToken" value={csrfToken} />
          <button type="submit">Log out</button>
        </form>
      </section>
    </div>
  );
}

export function AccountDisconnectReview({ account, expiresAt, preflightId }: AccountDisconnectReviewProps) {
  return (
    <article aria-labelledby="disconnect-title">
      <a className="back-link" href="/profile">← Profile</a>
      <header className="page-heading">
        <p className="eyebrow">Review account disconnect</p>
        <h1 id="disconnect-title">Disconnect {account.displayName}</h1>
        <p>This informational preview does not disconnect the account.</p>
      </header>
      <section className="review-section" aria-labelledby="disconnect-account-title">
        <h2 id="disconnect-account-title">Account</h2>
        <p><strong>{account.maskedAccount ?? account.displayName}</strong></p>
        <p>{account.reason}</p>
      </section>
      <section className="review-section" aria-labelledby="disconnect-impact-title">
        <h2 id="disconnect-impact-title">Impact</h2>
        <p>No Phase 3 delivery destination or operation depends on this identity-only account.</p>
        <p>Disconnect submission becomes available only after destination and operation impact handling is implemented.</p>
      </section>
      <section className="notice notice--warning" aria-labelledby="disconnect-recovery-title">
        <h2 id="disconnect-recovery-title">Recovery</h2>
        <p>You can reconnect later. Existing operation and audit evidence is retained.</p>
      </section>
      <p className="settings-status">Preview only · reference {preflightId}</p>
      <p className="evidence">Review expires <time dateTime={expiresAt}>{formatEvidenceTime(expiresAt)}</time></p>
    </article>
  );
}