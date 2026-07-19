import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

export type AuditTargetKind =
	| "artifact"
	| "credential-code"
	| "delivery-attempt"
	| "metadata-contribution"
	| "oauth-authorization"
	| "oauth-completion"
	| "operation"
	| "plugin"
	| "preflight"
	| "profile"
	| "provider-account"
	| "provider-cache"
	| "session"
	| "throttle";

export async function appendAuditEvent(
	client: PoolClient,
	input: {
		action: string;
		actorKind: "operator-cli" | "profile" | "system";
		actorLabel: string;
		correlationId: string;
		detailsJson: Record<string, unknown>;
		outcome: "succeeded" | "failed";
		profileId: string | null;
		requestId: string | null;
		sourceHash: string | null;
		targetId: string;
		targetKind: AuditTargetKind;
	},
) {
	await client.query(
		`insert into audit_events (audit_event_id, actor_kind, profile_id, actor_label, action, target_kind, target_id, outcome, correlation_id, request_id, source_hash, details_json)
		 values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)`,
		[
			randomUUID(),
			input.actorKind,
			input.profileId,
			input.actorLabel,
			input.action,
			input.targetKind,
			input.targetId,
			input.outcome,
			input.correlationId,
			input.requestId,
			input.sourceHash,
			JSON.stringify(input.detailsJson),
		],
	);
}