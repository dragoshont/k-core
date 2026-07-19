import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { AppConfig } from "../config";
import type { Database } from "../db/database";
import { withTransaction } from "../db/database";
import { ProblemError } from "../http/problems";
import type { ActiveSession } from "../identity/types";
import type { PluginCatalogService } from "../plugins/catalog";
import { hmacSha256Hex } from "../common/crypto";
import { pluginDigestIsCurrent, pluginDigestMatchesSnapshot } from "../plugins/manifests";
import { authorizeCatalogEffect, catalogEffectSnapshotsMatch, catalogRightsPolicy } from "../plugins/rights-policy";
import { addMinutes } from "../time";
import type { MailSender } from "./mail";
import { createMailSender } from "./mail";
import { createOperationFromPreflight, insertPreflight, listOperations, readDeliveryProfile, readOperation, updateDeliveryProfile } from "./store";

const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;

function maskAddress(value: string | null) {
	if (!value) return null;
	const [local, domain] = value.split("@");
	if (!local || !domain) return null;
	return `${local[0]}${"•".repeat(Math.min(6, Math.max(1, local.length - 1)))}@${domain}`;
}

function validKindleAddress(value: string) {
	return /^[^\s@]{1,64}@(kindle\.com|free\.kindle\.com)$/i.test(value) && value.length <= 254;
}

export class DeliveryService {
	readonly mail: MailSender;

	constructor(private readonly database: Database, private readonly config: AppConfig, private readonly catalog: PluginCatalogService, mail?: MailSender) {
		this.mail = mail ?? createMailSender(config);
	}

	async readSettings(profileId: string) {
		const profile = await readDeliveryProfile(this.database, profileId);
		if (!profile) throw new ProblemError(404, "not_found", "Not found");
		return {
			destinationStatus: profile.kindle_address ? "ready" as const : "not-configured" as const,
			maskedAddress: maskAddress(profile.kindle_address),
			revision: profile.destination_revision,
			sender: { checkedAt: new Date().toISOString(), reason: this.mail.ready() ? null : "Configure SMTP before submitting books.", source: "Household mail relay", status: this.mail.ready() ? "ready" as const : "configuration-required" as const },
		};
	}

	async updateSettings(session: ActiveSession, kindleAddress: string | null) {
		if (kindleAddress !== null && !validKindleAddress(kindleAddress)) throw new ProblemError(422, "validation_failed", "Validation failed", "Use a Kindle email address.");
		const profile = await updateDeliveryProfile(this.database, session.profile.profileId, kindleAddress?.toLowerCase() ?? null);
		if (!profile) throw new ProblemError(404, "not_found", "Not found");
		return this.readSettings(session.profile.profileId);
	}

	async preflight(session: ActiveSession, input: { itemId: string; optionId: string; pluginId: string }) {
		const plugin = this.catalog.installed.find((candidate) => candidate.manifest.pluginId === input.pluginId);
		if (!plugin) throw new ProblemError(404, "plugin_not_found", "Plugin not found");
		if (!catalogRightsPolicy(plugin, this.config.publicPluginInventory).effectAuthorized) throw new ProblemError(409, "acquisition_blocked", "Acquisition is blocked");
		const item = await this.catalog.detailForEffect(session.profile.profileId, `plugin:${input.pluginId}:${input.itemId}`);
		const authorization = authorizeCatalogEffect(plugin, this.config.publicPluginInventory, item, input);
		if (!authorization) throw new ProblemError(409, "acquisition_blocked", "Acquisition is blocked");
		const option = authorization.option;
		const profile = await readDeliveryProfile(this.database, session.profile.profileId);
		if (!profile) throw new ProblemError(404, "not_found", "Not found");
		const blockers: Array<{ checkedAt: string; code: string; reason: string; remediation: string | null; source: string }> = [];
		const checkedAt = new Date();
		if (!profile.kindle_address) blockers.push({ checkedAt: checkedAt.toISOString(), code: "destination_required", reason: "Add a Kindle destination.", remediation: "Open Profile and save a Kindle address.", source: "Profile" });
		if (!this.mail.ready()) blockers.push({ checkedAt: checkedAt.toISOString(), code: "sender_configuration_required", reason: "The household mail relay is not configured.", remediation: "Configure SMTP on the server.", source: "Household mail relay" });
		if (option.estimatedBytes !== null && option.estimatedBytes > MAX_ARTIFACT_BYTES) blockers.push({ checkedAt: checkedAt.toISOString(), code: "file_too_large", reason: "The reported EPUB exceeds the file limit.", remediation: null, source: plugin.manifest.displayName });
		const expiresAt = addMinutes(checkedAt, 5);
		const preflightId = await withTransaction(this.database.pool, (client) => insertPreflight(client, { blockers, destinationRevision: profile.destination_revision, expiresAt, item: { ...item, maskedDestination: maskAddress(profile.kindle_address) }, itemId: input.itemId, optionId: input.optionId, pluginDigest: plugin.digest, pluginId: input.pluginId, profileId: session.profile.profileId, ready: blockers.length === 0, warnings: [] }));
		return {
			blockers,
			createdAt: checkedAt.toISOString(),
			destination: { configured: Boolean(profile.kindle_address), maskedAddress: maskAddress(profile.kindle_address), revision: profile.destination_revision },
			expiresAt: expiresAt.toISOString(),
			item,
			limits: { activeOperations: 0, estimatedFileBytes: option.estimatedBytes, maximumActiveOperations: 2, maximumFileBytes: MAX_ARTIFACT_BYTES },
			outputPlan: { conversionRequired: false, metadataSource: plugin.manifest.displayName, outputFormat: "epub" },
			plannedStages: ["preflight", "acquire", "validate", "metadata", "convert", "validate-output", "deliver", "cleanup"],
			preflightId,
			previousSubmissions: 0,
			ready: blockers.length === 0,
			recentAuthenticationRequired: false,
			selectedOption: option,
			sender: (await this.readSettings(session.profile.profileId)).sender,
			warnings: [],
		};
	}

	async queue(session: ActiveSession, input: { idempotencyKey: string; preflightId: string }) {
		if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.idempotencyKey)) throw new ProblemError(422, "validation_failed", "Validation failed", "Idempotency key must be a UUID.");
		const existing = await this.database.query<{ created_at: Date; operation_id: string }>("select operation_id, created_at from operations where profile_id = $1 and idempotency_key = $2", [session.profile.profileId, input.idempotencyKey]);
		if (existing.rows[0]) return { createdAt: existing.rows[0].created_at.toISOString(), operationId: existing.rows[0].operation_id, status: "queued" as const, statusUrl: `/api/v1/operations/${existing.rows[0].operation_id}` };
		const snapshot = await this.database.query<{ item_id: string; item_json: unknown; option_id: string; plugin_digest: string; plugin_id: string }>("select plugin_id, item_id, option_id, plugin_digest, item_json from delivery_preflights where preflight_id = $1 and profile_id = $2", [input.preflightId, session.profile.profileId]);
		const plugin = snapshot.rows[0] ? this.catalog.installed.find((candidate) => candidate.manifest.pluginId === snapshot.rows[0]!.plugin_id) : null;
		if (!plugin || !pluginDigestMatchesSnapshot(plugin, snapshot.rows[0]!.plugin_digest)) throw new ProblemError(409, "stale_preflight", "Preflight is stale");
		let currentItem: Awaited<ReturnType<PluginCatalogService["detailForEffect"]>>;
		try {
			currentItem = await this.catalog.detailForEffect(session.profile.profileId, `plugin:${snapshot.rows[0]!.plugin_id}:${snapshot.rows[0]!.item_id}`);
			if (!catalogEffectSnapshotsMatch(plugin, this.config.publicPluginInventory, snapshot.rows[0]!.item_json, currentItem, { itemId: snapshot.rows[0]!.item_id, optionId: snapshot.rows[0]!.option_id })) {
				throw new Error("preflight policy snapshot changed");
			}
		} catch {
			throw new ProblemError(409, "stale_preflight", "Preflight is stale");
		}
		const profile = await readDeliveryProfile(this.database, session.profile.profileId);
		if (!profile) throw new ProblemError(409, "stale_preflight", "Preflight is stale");
		const result = await withTransaction(this.database.pool, (client) => createOperationFromPreflight(client, {
			idempotencyKey: input.idempotencyKey,
			item: snapshot.rows[0]!.item_json,
			itemId: snapshot.rows[0]!.item_id,
			operationTarget: { ...currentItem, maskedDestination: maskAddress(profile.kindle_address) },
			optionId: snapshot.rows[0]!.option_id,
			pluginDigest: snapshot.rows[0]!.plugin_digest,
			pluginId: snapshot.rows[0]!.plugin_id,
			preflightId: input.preflightId,
			profileId: session.profile.profileId,
		}));
		if (!result) throw new ProblemError(409, "stale_preflight", "Preflight is stale");
		return { createdAt: new Date().toISOString(), operationId: result.operationId, status: "queued" as const, statusUrl: `/api/v1/operations/${result.operationId}` };
	}

	async list(profileId: string) {
		const rows = await listOperations(this.database, profileId);
		return rows.map((row: any) => this.mapOperation(row, []));
	}

	async read(profileId: string, operationId: string) {
		const operation = await readOperation(this.database, profileId, operationId);
		if (!operation) throw new ProblemError(404, "not_found", "Not found");
		return this.mapOperation(operation as any, (operation as any).stages);
	}

	async cancel(profileId: string, operationId: string) {
		const result = await this.database.query("update operations set status = 'canceling', cancel_requested_at = now(), updated_at = now() where operation_id = $1 and profile_id = $2 and status in ('queued','waiting')", [operationId, profileId]);
		if (result.rowCount !== 1) throw new ProblemError(409, "operation_not_cancelable", "Operation cannot be canceled");
		return { createdAt: new Date().toISOString(), operationId, status: "canceling" as const, statusUrl: `/api/v1/operations/${operationId}` };
	}

	async confirmReceived(profileId: string, operationId: string, confirmedBy: string) {
		const result = await this.database.query("update operations set delivery_evidence = 'user-confirmed-received', updated_at = now() where operation_id = $1 and profile_id = $2 and delivery_evidence = 'mail-server-accepted'", [operationId, profileId]);
		if (result.rowCount !== 1) throw new ProblemError(409, "operation_not_confirmable", "Operation cannot be confirmed");
		await this.database.query("update operations set target_json = jsonb_set(target_json, '{confirmedBy}', to_jsonb($2::text), true) where operation_id = $1", [operationId, confirmedBy]);
	}

	messageId(operationId: string) {
		const domain = this.config.smtpFrom?.split("@")[1] ?? "k.invalid";
		return `<${operationId}@${domain}>`;
	}

	destinationHash(destination: string) {
		return hmacSha256Hex(this.config.sourceHashSecret, destination);
	}

	private mapOperation(row: any, stages: any[]) {
		return {
			artifact: null,
			attempt: row.attempt,
			cancelable: ["queued", "waiting"].includes(row.status),
			completedAt: row.completed_at?.toISOString?.() ?? null,
			correlationId: row.correlation_id,
			createdAt: row.created_at.toISOString(),
			deliveryEvidence: { confirmedBy: row.target_json.confirmedBy ?? null, recordedAt: row.updated_at.toISOString(), source: row.delivery_evidence === "user-confirmed-received" ? row.target_json.confirmedBy ?? "profile" : "Household mail relay", state: row.delivery_evidence },
			operationId: row.operation_id,
			retryAfter: ["queued", "waiting", "running"].includes(row.status) ? 2 : null,
			stages: stages.map((stage) => ({ completedAt: stage.completed_at?.toISOString?.() ?? null, error: stage.error_json, message: stage.message, name: stage.name, source: "k worker", startedAt: stage.started_at?.toISOString?.() ?? null, status: stage.status, updatedAt: stage.updated_at.toISOString() })),
			startedAt: row.started_at?.toISOString?.() ?? null,
			status: row.status,
			target: { authors: row.target_json.creators ?? row.target_json.authors ?? [], capability: row.target_json.capability ?? "candidate", edition: null, maskedDestination: row.target_json.maskedDestination ?? "Not configured", provider: row.target_json.source, title: row.target_json.title },
			type: "acquire-deliver",
			updatedAt: row.updated_at.toISOString(),
		};
	}
}