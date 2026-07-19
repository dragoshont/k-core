import { formatEvidenceTime } from "./format";

export interface PreflightIssue {
  code: string;
  reason: string;
  remediation?: string;
}

export interface DeliveryPreflightProps {
  blockers?: PreflightIssue[];
  checkedAt: string;
  csrfToken?: string;
  destination: string | null;
  estimatedBytes?: number | null;
  expiresAt: string;
  format: "epub";
  maximumFileBytes: number;
  metadataSource: string;
  outputFormat: "epub";
  previousSubmissions: number;
	preflightId?: string;
  profileName: string;
  provider: string;
  recentAuthenticationRequired?: boolean;
  rightsBasis: "public-domain" | "user-owned" | "licensed-private";
  state: "checking" | "ready" | "warning" | "blocked" | "expired" | "configuration-required" | "recent-authentication-required" | "stale-at-submit";
  title: string;
  warnings?: PreflightIssue[];
}

function bytes(value: number | null | undefined) {
  if (value == null) return "Not reported";
  return new Intl.NumberFormat("en", { style: "unit", unit: "megabyte", maximumFractionDigits: 1 }).format(value / 1_000_000);
}

export function DeliveryPreflight({
  blockers = [], checkedAt, csrfToken = "storybook-csrf-token-not-a-secret", destination, estimatedBytes, expiresAt, format,
  maximumFileBytes, metadataSource, outputFormat, previousSubmissions, profileName,
  provider, recentAuthenticationRequired = false, rightsBasis, state, title, warnings = [],
	preflightId = "storybook-preflight",
}: DeliveryPreflightProps) {
  if (state === "checking") return <p className="status-line" role="status">Checking source, file limits, sender, and destination...</p>;

  const actionable = (state === "ready" || state === "warning") && blockers.length === 0 && !recentAuthenticationRequired;
  return (
    <article aria-labelledby="preflight-title">
      <header className="page-heading">
        <p className="eyebrow">Review before sending</p>
        <h1 id="preflight-title">{title}</h1>
        <p>This check does not download or send anything. Review the exact source and plan first.</p>
      </header>

      {state === "expired" || state === "stale-at-submit" ? (
        <section className="notice notice--warning"><h2>Check expired</h2><p>Availability or settings changed. Return to the book and check again.</p></section>
      ) : null}
      {state === "configuration-required" ? (
        <section className="notice notice--warning"><h2>Kindle setup required</h2><p>Add a Kindle address and confirm the household sender before sending.</p><a href="/profile">Open Profile</a></section>
      ) : null}
      {state === "recent-authentication-required" || recentAuthenticationRequired ? (
        <section className="notice notice--warning"><h2>Confirm your PIN</h2><p>Enter your PIN again before this delivery can be queued.</p><a href="/reauthenticate">Confirm PIN</a></section>
      ) : null}

      {blockers.length > 0 && <IssueList heading="Cannot continue" issues={blockers} tone="danger" />}
      {warnings.length > 0 && <IssueList heading="Before you continue" issues={warnings} tone="warning" />}

      <section className="review-section" aria-labelledby="edition-heading">
        <h2 id="edition-heading">Edition and source</h2>
        <dl className="evidence-grid">
          <div><dt>Source</dt><dd>{provider}</dd></div>
          <div><dt>Rights basis</dt><dd>{rightsBasis.replaceAll("-", " ")}</dd></div>
          <div><dt>Source format</dt><dd>{format.toUpperCase()}</dd></div>
          <div><dt>Estimated size</dt><dd>{bytes(estimatedBytes)}</dd></div>
          <div><dt>Checked</dt><dd><time dateTime={checkedAt}>{formatEvidenceTime(checkedAt)}</time></dd></div>
        </dl>
      </section>

      <section className="review-section" aria-labelledby="plan-heading">
        <h2 id="plan-heading">Preparation plan</h2>
        <ol className="plan-list">
          <li>Acquire from the approved source</li><li>Validate file and rights evidence</li>
          <li>Apply metadata from {metadataSource}</li><li>Prepare and validate {outputFormat.toUpperCase()}</li><li>Submit by email</li>
        </ol>
        <p className="evidence">File limit {bytes(maximumFileBytes)} · {previousSubmissions} previous submissions</p>
      </section>

      <section className="review-section" aria-labelledby="destination-heading">
        <h2 id="destination-heading">Destination</h2>
        <p>{destination ?? "No Kindle address configured"}</p>
      </section>

      <form method="post" action="/operations">
        <input type="hidden" name="preflightId" value={preflightId} />
        <input type="hidden" name="csrfToken" value={csrfToken} />
        <button disabled={!actionable} type="submit">Acquire and send to {profileName}'s Kindle</button>
      </form>
      <p className="evidence">Check expires <time dateTime={expiresAt}>{formatEvidenceTime(expiresAt)}</time></p>
    </article>
  );
}

function IssueList({ heading, issues, tone }: { heading: string; issues: PreflightIssue[]; tone: "danger" | "warning" }) {
  return <section className={`notice notice--${tone}`}><h2>{heading}</h2><ul>{issues.map((issue) => <li key={issue.code}><strong>{issue.reason}</strong>{issue.remediation && <span> {issue.remediation}</span>}</li>)}</ul></section>;
}