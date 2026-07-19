export type CredentialState = "setup-required" | "ready" | "recovery-required";

export interface HouseholdProfile {
  id: string;
  displayName: string;
  credentialState: CredentialState;
}

export interface ProfilePickerProps {
  profiles: HouseholdProfile[];
  selectedId?: string;
}

export function ProfilePicker({ profiles, selectedId }: ProfilePickerProps) {
  return (
    <form className="auth-form" method="get" action="/unlock">
      <fieldset className="profile-picker">
        <legend>Who is reading?</legend>
        <div className="profile-options">
          {profiles.map((profile) => (
            <button
              className="profile-option"
              data-selected={profile.id === selectedId || undefined}
              key={profile.id}
              name="profile"
              type="submit"
              value={profile.id}
            >
              <span>{profile.displayName}</span>
              <small>
                {profile.credentialState === "setup-required" && "PIN setup required"}
                {profile.credentialState === "recovery-required" && "Recovery code required"}
                {profile.credentialState === "ready" && "Enter PIN"}
              </small>
            </button>
          ))}
        </div>
      </fieldset>
    </form>
  );
}

export interface PinUnlockFormProps {
  csrfToken?: string;
  delayedUntil?: string;
  error?: string;
  profileId: string;
  profileName: string;
  recentAuthentication?: boolean;
  state?: "ready" | "submitting" | "invalid" | "delayed";
}

export function PinUnlockForm({
  csrfToken = "storybook-csrf-token-not-a-secret",
  delayedUntil,
  error,
  profileId,
  profileName,
  recentAuthentication = false,
  state = "ready",
}: PinUnlockFormProps) {
  const unavailable = state === "submitting" || state === "delayed";
  return (
    <form className="auth-form" method="post" action={recentAuthentication ? "/reauthenticate" : "/unlock"}>
      <input type="hidden" name="csrfToken" value={csrfToken} />
      <input type="hidden" name="profileId" value={profileId} />
      {error && (
        <div className="error-summary" role="alert" tabIndex={-1}>
          <h2>PIN not accepted</h2>
          <p>{error}</p>
          <a href="#pin">Check the PIN</a>
        </div>
      )}
      <div className="field">
        <label htmlFor="pin">{recentAuthentication ? "Enter your PIN again" : `${profileName}'s PIN`}</label>
        <p id="pin-hint">Four digits. You can paste or use password autofill.</p>
        <input
          aria-describedby="pin-hint"
          autoComplete="current-password"
          disabled={unavailable}
          id="pin"
          inputMode="numeric"
          maxLength={4}
          minLength={4}
          name="pin"
          pattern="[0-9]{4}"
          required
          type="password"
        />
      </div>
      {state === "delayed" && (
        <p className="notice notice--warning" role="status">
          Too many attempts. Try again after <time dateTime={delayedUntil}>{delayedUntil ?? "the delay ends"}</time>.
        </p>
      )}
      <button disabled={unavailable} type="submit">
        {state === "submitting" ? "Unlocking..." : recentAuthentication ? "Confirm PIN" : "Unlock"}
      </button>
      {!recentAuthentication && <a className="text-link" href="/unlock">Switch profile</a>}
    </form>
  );
}

export interface PinSetupFormProps {
	csrfToken?: string;
  error?: string;
  profileId: string;
  profileName: string;
  purpose?: "setup" | "recovery";
  state?: "ready" | "submitting" | "invalid" | "conflict" | "pin-rejected" | "throttled" | "completed";
}

export function PinSetupForm({
	csrfToken = "storybook-csrf-token-not-a-secret",
  error,
  profileId,
  profileName,
  purpose = "setup",
  state = "ready",
}: PinSetupFormProps) {
  if (state === "completed") {
    return (
      <section className="confirmation" aria-labelledby="setup-complete-title">
        <p className="confirmation__mark" aria-hidden="true">✓</p>
        <h2 id="setup-complete-title">PIN set for {profileName}</h2>
        <p>Every previous session and setup code has been revoked.</p>
        <a className="button-link" href="/unlock">Return to unlock</a>
      </section>
    );
  }

  const submitting = state === "submitting";
  return (
    <form className="auth-form" method="post" action="/setup">
      <input type="hidden" name="csrfToken" value={csrfToken} />
      <input type="hidden" name="profileId" value={profileId} />
      {error && (
        <div className="error-summary" role="alert" tabIndex={-1}>
          <h2>PIN could not be set</h2>
          <p>{error}</p>
          <a href="#credential-code">Check the form</a>
        </div>
      )}
      <div className="field">
        <label htmlFor="credential-code">One-time credential code</label>
        <p id="credential-hint">Use the code provided by the household operator. Codes expire quickly and work once.</p>
        <input aria-describedby="credential-hint" autoComplete="one-time-code" id="credential-code" name="credentialCode" required type="password" />
      </div>
      <div className="field">
        <label htmlFor="new-pin">New four-digit PIN</label>
        <input autoComplete="new-password" id="new-pin" inputMode="numeric" maxLength={4} minLength={4} name="pin" pattern="[0-9]{4}" required type="password" />
      </div>
      <div className="field">
        <label htmlFor="confirm-pin">Confirm PIN</label>
        <input autoComplete="new-password" id="confirm-pin" inputMode="numeric" maxLength={4} minLength={4} name="confirmPin" pattern="[0-9]{4}" required type="password" />
      </div>
      <button disabled={submitting} type="submit">
        {submitting ? "Saving..." : purpose === "recovery" ? "Recover PIN" : "Set PIN"}
      </button>
    </form>
  );
}