import { formatEvidenceTime } from "./format";

export type OperationStatus = "queued" | "waiting" | "running" | "blocked" | "canceling" | "canceled" | "succeeded" | "failed" | "partial" | "expired" | "unknown";
export type StageStatus = "not-started" | "queued" | "waiting" | "running" | "blocked" | "canceled" | "succeeded" | "failed" | "unknown";
export type DeliveryEvidenceState = "not-submitted" | "mail-server-accepted" | "bounced" | "rejected" | "unknown" | "user-confirmed-received";

export interface OperationStage {
  name: string;
  status: StageStatus;
  source: string;
  updatedAt: string;
  message?: string;
  error?: { reason: string; remediation?: string; requestId: string };
}

export interface OperationTimelineProps {
  cancelable?: boolean;
  correlationId: string;
  csrfToken?: string;
  deliveryEvidence?: { state: DeliveryEvidenceState; source: string; recordedAt: string; confirmedBy?: string | null };
  operationId: string;
  stages: OperationStage[];
  status: OperationStatus;
  target: { title: string; authors: string[]; provider: string; maskedDestination: string; destinationLabel?: string };
  updatedAt: string;
}

export interface OperationListItem {
  operationId: string;
  title: string;
  status: OperationStatus;
  deliveryEvidence: DeliveryEvidenceState;
  destinationLabel?: string;
  updatedAt: string;
}

const kindleEvidenceLabels: Record<DeliveryEvidenceState, string> = {
  "not-submitted": "Not submitted", "mail-server-accepted": "Submitted", bounced: "Bounced",
  rejected: "Rejected", unknown: "Delivery unknown", "user-confirmed-received": "Received",
};

function tone(status: OperationStatus | StageStatus | DeliveryEvidenceState) {
  if (["succeeded", "running", "mail-server-accepted", "user-confirmed-received"].includes(status)) return "success";
  if (["failed", "bounced", "rejected"].includes(status)) return "danger";
  if (["queued", "waiting", "blocked", "canceling", "expired"].includes(status)) return "warning";
  return "neutral";
}

export function OperationTimeline({ cancelable = false, correlationId, csrfToken = "storybook-csrf-token-not-a-secret", deliveryEvidence, operationId, stages, status, target, updatedAt }: OperationTimelineProps) {
  const evidence = deliveryEvidence ?? { state: "not-submitted" as const, source: "k operation record", recordedAt: new Date(0).toISOString() };
  const evidenceLabel = kindleEvidenceLabels[evidence.state];
  return (
    <article aria-labelledby="operation-title">
      <header className="page-heading">
        <p className="eyebrow">Operation {operationId.slice(0, 8)}</p>
        <h1 id="operation-title">{target.title}</h1>
        <p>{target.authors.join(", ")} · {target.provider} · to {target.destinationLabel ?? target.maskedDestination}</p>
      </header>
      <div className="operation-summary">
        <p><span className={`status-badge status-badge--${tone(status)}`}>{status.replaceAll("-", " ")}</span></p>
        <p>Updated <time dateTime={updatedAt}>{formatEvidenceTime(updatedAt)}</time></p>
      </div>
      <section aria-labelledby="stages-title">
        <h2 id="stages-title">Preparation stages</h2>
        <ol className="timeline">
          {stages.map((stage, index) => (
            <li className={`timeline__stage timeline__stage--${tone(stage.status)}`} key={stage.name}>
              <div className="timeline__marker" aria-hidden="true">{index + 1}</div>
              <div>
                <h3>{stage.name.replaceAll("-", " ")}</h3>
                <p><strong>{stage.status.replaceAll("-", " ")}</strong>{stage.message ? ` · ${stage.message}` : ""}</p>
                <p className="evidence">{stage.source} · <time dateTime={stage.updatedAt}>{formatEvidenceTime(stage.updatedAt)}</time></p>
                {stage.error && <div className="stage-error"><p>{stage.error.reason}</p>{stage.error.remediation && <p>{stage.error.remediation}</p>}<p className="evidence">Request {stage.error.requestId}</p></div>}
              </div>
            </li>
          ))}
        </ol>
      </section>
      <section className="delivery-evidence" aria-labelledby="delivery-evidence-title">
        <h2 id="delivery-evidence-title">Kindle delivery evidence</h2>
        <p><span className={`status-badge status-badge--${tone(evidence.state)}`}>{evidenceLabel}</span></p>
        <p>Submitted by household mail relay</p>
        <p>{evidence.source} · <time dateTime={evidence.recordedAt}>{formatEvidenceTime(evidence.recordedAt)}</time></p>
        {evidence.confirmedBy && <p>Confirmed by {evidence.confirmedBy}</p>}
      </section>
      <div className="operation-actions">
        <a className="button-link button-link--secondary" href={`/activity/${operationId}`}>Refresh</a>
        {cancelable && <form method="post" action={`/activity/${operationId}/cancel`}><input type="hidden" name="csrfToken" value={csrfToken} /><button className="button--secondary" type="submit">Request cancellation</button></form>}
        {evidence.state === "mail-server-accepted" && <form method="post" action={`/activity/${operationId}/confirm-received`}><input type="hidden" name="csrfToken" value={csrfToken} /><button type="submit">Confirm received on Kindle</button></form>}
      </div>
      <p className="evidence">Correlation {correlationId}</p>
    </article>
  );
}

export function ActivityList({ operations }: { operations: OperationListItem[] }) {
  return (
    <section aria-labelledby="activity-title">
      <header className="page-heading">
        <p className="eyebrow">Your operations</p>
        <h1 id="activity-title">Activity</h1>
        <p>Acquisition, preparation, and submission evidence for this profile.</p>
      </header>
      {operations.length === 0 ? (
        <div className="empty-state"><h2>No activity yet</h2><p>Books you choose to prepare will appear here.</p><a href="/search">Search for a book</a></div>
      ) : (
        <ol className="activity-list">
          {operations.map((operation) => (
            <li key={operation.operationId}>
              <a href={`/activity/${operation.operationId}`}>
                <span><strong>{operation.title}</strong>{operation.destinationLabel && <small>{operation.destinationLabel}</small>}<small>Updated <time dateTime={operation.updatedAt}>{formatEvidenceTime(operation.updatedAt)}</time></small></span>
                <span className={`status-badge status-badge--${tone(operation.status)}`}>{operation.deliveryEvidence === "mail-server-accepted" ? "Submitted" : operation.deliveryEvidence === "user-confirmed-received" ? "Received" : operation.status}</span>
              </a>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}