import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { AppConfig } from "../config";
import { assertProfileConfigurationParity } from "../config/profile-parity";
import { profileConfigState } from "../config/profile-config";
import type { Database } from "../db/database";
import { validateEpub } from "../publication/epub";
import type { PluginCatalogService } from "../plugins/catalog";
import { PluginHost } from "../plugins/host";
import { pluginDigestIsCurrent, pluginDigestMatchesSnapshot } from "../plugins/manifests";
import { catalogEffectSnapshotsMatch, catalogRightsPolicy } from "../plugins/rights-policy";
import type { DeliveryService } from "./service";

async function setStage(database: Database, operationId: string, name: string, status: string, message?: string) {
	await database.query("update operation_stages set status = $3, message = $4, started_at = coalesce(started_at, now()), completed_at = case when $3 in ('succeeded','failed','blocked','canceled') then now() else completed_at end, updated_at = now() where operation_id = $1 and name = $2", [operationId, name, status, message ?? null]);
}

export class DeliveryWorker {
	private readonly host: PluginHost;

	constructor(private readonly database: Database, private readonly config: AppConfig, private readonly catalog: PluginCatalogService, private readonly delivery: DeliveryService, host?: PluginHost) {
		this.host = host ?? new PluginHost(config.userAgent, config.publicPluginInventory);
	}

	async runOnce(workerId = `worker-${randomUUID()}`) {
		await assertProfileConfigurationParity(this.database, profileConfigState(this.config).value);
		await this.cleanupExpiredArtifacts();
		const claimed = await this.database.withTransaction(async (client) => {
			const result = await client.query<{ operation_id: string }>(`
				select operation_id from operations
				where (status = 'queued' or (status = 'running' and lease_expires_at < now()))
				order by created_at for update skip locked limit 1
			`);
			if (!result.rows[0]) return null;
			await client.query("update operations set status = 'running', started_at = coalesce(started_at, now()), updated_at = now(), lease_owner = $2, lease_expires_at = now() + interval '2 minutes' where operation_id = $1", [result.rows[0].operation_id, workerId]);
			return result.rows[0].operation_id;
		});
		if (!claimed) return false;
		await this.process(claimed).catch(() => undefined);
		return true;
	}

	private async process(operationId: string) {
		const result = await this.database.query<{ destination_revision: number; item_json: any; item_id: string; option_id: string; plugin_digest: string; plugin_id: string; profile_id: string }>(`
			select o.profile_id, p.plugin_id, p.item_id, p.option_id, p.plugin_digest, p.destination_revision, p.item_json
			from operations o join delivery_preflights p on p.preflight_id = o.preflight_id
			where o.operation_id = $1
		`, [operationId]);
		const record = result.rows[0];
		if (!record) return;
		const previousAttempt = await this.database.query<{ status: string }>("select status from delivery_attempts where operation_id = $1", [operationId]);
		if (previousAttempt.rows[0]) {
			if (previousAttempt.rows[0].status === "sending") {
				await this.database.query("update delivery_attempts set status = 'unknown', updated_at = now() where operation_id = $1", [operationId]);
				return this.block(operationId, "deliver", "Delivery outcome is unknown after worker recovery; automatic resend is blocked.", "unknown");
			}
			if (previousAttempt.rows[0].status === "accepted") {
				await setStage(this.database, operationId, "deliver", "succeeded", "Mail server accepted the submission before worker recovery.");
				await this.database.query("update operations set status = 'succeeded', delivery_evidence = 'mail-server-accepted', completed_at = now(), updated_at = now(), lease_owner = null, lease_expires_at = null where operation_id = $1", [operationId]);
				return;
			}
			return this.block(operationId, "deliver", "Mail relay rejected the submission before worker recovery.", "rejected", "failed");
		}
		const plugin = this.catalog.installed.find((candidate) => candidate.manifest.pluginId === record.plugin_id);
		if (!plugin || !pluginDigestMatchesSnapshot(plugin, record.plugin_digest) || !catalogRightsPolicy(plugin, this.config.publicPluginInventory).effectAuthorized) return this.block(operationId, "acquire", "Plugin was removed, changed, or is not authorized for acquisition.");
		const profileResult = await this.database.query<{ destination_revision: number; kindle_address: string | null }>("select destination_revision, kindle_address from profiles where profile_id = $1", [record.profile_id]);
		const destination = profileResult.rows[0]?.kindle_address;
		if (profileResult.rows[0]?.destination_revision !== record.destination_revision) return this.block(operationId, "deliver", "Destination changed after preflight; create a new delivery request.");
		if (!destination || !this.delivery.mail.ready()) return this.block(operationId, "deliver", "Destination or SMTP configuration is unavailable.");
		if (!await this.effectAuthorized(record, plugin)) return this.block(operationId, "acquire", "Current catalog rights evidence does not authorize acquisition.");
		const quarantine = this.config.quarantineDirectory ?? resolve(process.cwd(), "data/quarantine");
		await mkdir(quarantine, { recursive: true });
		let artifactPath: string | null = null;
		try {
			await setStage(this.database, operationId, "acquire", "running");
			if (!await this.effectAuthorized(record, plugin)) return this.block(operationId, "acquire", "Current catalog rights evidence does not authorize acquisition.");
			const artifact = await this.host.acquire(plugin, { itemId: record.item_id, optionId: record.option_id }, quarantine);
			artifactPath = artifact.path;
			await setStage(this.database, operationId, "acquire", "succeeded");
			await setStage(this.database, operationId, "validate", "running");
			await validateEpub(artifact.path);
			await setStage(this.database, operationId, "validate", "succeeded");
			for (const name of ["metadata", "convert", "validate-output"]) await setStage(this.database, operationId, name, "succeeded", name === "convert" ? "Source is already EPUB; conversion skipped." : undefined);
			const artifactId = randomUUID();
			await this.database.query("insert into artifacts (artifact_id, operation_id, storage_path, media_type, size_bytes, sha256, validated_at) values ($1,$2,$3,$4,$5,$6,now())", [artifactId, operationId, artifact.path, artifact.mediaType, artifact.sizeBytes, artifact.sha256]);
			await setStage(this.database, operationId, "deliver", "running");
			const deliveryItem = await this.effectAuthorized(record, plugin);
			if (!deliveryItem) return this.block(operationId, "deliver", "Current catalog rights evidence does not authorize delivery.");
			const messageId = this.delivery.messageId(operationId);
			const attemptId = randomUUID();
			await this.database.query("insert into delivery_attempts (delivery_attempt_id, operation_id, message_id, destination_hash, status) values ($1,$2,$3,$4,'sending')", [attemptId, operationId, messageId, this.delivery.destinationHash(destination)]);
			try {
				const mail = await this.delivery.mail.send({ attachmentPath: artifact.path, destination, messageId, title: deliveryItem.title });
				if (!mail.accepted) {
					await this.database.query("update delivery_attempts set status = 'rejected', smtp_response = $2, updated_at = now() where delivery_attempt_id = $1", [attemptId, mail.response.slice(0, 500)]);
					throw new Error("mail relay rejected the submission");
				}
				await this.database.query("update delivery_attempts set status = 'accepted', smtp_response = $2, updated_at = now() where delivery_attempt_id = $1", [attemptId, mail.response.slice(0, 500)]);
				await setStage(this.database, operationId, "deliver", "succeeded", "Mail server accepted the submission.");
				await setStage(this.database, operationId, "cleanup", "succeeded");
				await this.database.query("update operations set status = 'succeeded', delivery_evidence = 'mail-server-accepted', completed_at = now(), updated_at = now(), lease_owner = null, lease_expires_at = null where operation_id = $1", [operationId]);
			} catch (error) {
				const attempt = await this.database.query<{ status: string }>("select status from delivery_attempts where delivery_attempt_id = $1", [attemptId]);
				const unknown = attempt.rows[0]?.status === "sending";
				if (unknown) await this.database.query("update delivery_attempts set status = 'unknown', updated_at = now() where delivery_attempt_id = $1", [attemptId]);
				await setStage(this.database, operationId, "deliver", unknown ? "blocked" : "failed", unknown ? "Delivery outcome is unknown; automatic resend is blocked." : "Mail relay rejected the submission.");
				await this.database.query("update operations set status = $2, delivery_evidence = $3, completed_at = now(), updated_at = now(), lease_owner = null, lease_expires_at = null where operation_id = $1", [operationId, unknown ? "blocked" : "failed", unknown ? "unknown" : "rejected"]);
			}
		} catch (error) {
			if (!catalogRightsPolicy(plugin, this.config.publicPluginInventory).effectAuthorized) {
				await this.block(operationId, "acquire", "Plugin rights evidence changed during acquisition.");
			} else {
				await setStage(this.database, operationId, "validate", "failed", error instanceof Error ? error.message.slice(0, 300) : "Pipeline failed").catch(() => undefined);
				await this.database.query("update operations set status = 'failed', completed_at = now(), updated_at = now(), lease_owner = null, lease_expires_at = null where operation_id = $1", [operationId]);
			}
		} finally {
			const operation = await this.database.query<{ status: string }>("select status from operations where operation_id = $1", [operationId]);
			if (artifactPath && operation.rows[0]?.status !== "succeeded") {
				await rm(artifactPath, { force: true });
				await this.database.query("update artifacts set deleted_at = coalesce(deleted_at, now()) where operation_id = $1", [operationId]);
			}
		}
	}

	private async effectAuthorized(record: { item_id: string; item_json: unknown; option_id: string; plugin_id: string; plugin_digest: string; profile_id: string }, plugin: import("../plugins/types").InstalledPlugin) {
		if (!pluginDigestMatchesSnapshot(plugin, record.plugin_digest)) return null;
		try {
			const currentItem = await this.catalog.detailForEffect(record.profile_id, `plugin:${record.plugin_id}:${record.item_id}`);
			return catalogEffectSnapshotsMatch(plugin, this.config.publicPluginInventory, record.item_json, currentItem, { itemId: record.item_id, optionId: record.option_id }) ? currentItem : null;
		} catch {
			return null;
		}
	}

	private async block(operationId: string, stage: string, message: string, evidence = "not-submitted", operationStatus = "blocked") {
		await setStage(this.database, operationId, stage, "blocked", message);
		await this.database.query("update operations set status = $2, delivery_evidence = $3, updated_at = now(), lease_owner = null, lease_expires_at = null where operation_id = $1", [operationId, operationStatus, evidence]);
	}

	private async cleanupExpiredArtifacts() {
		const result = await this.database.query<{ artifact_id: string; storage_path: string }>("select artifact_id, storage_path from artifacts where deleted_at is null and retain_until <= now() limit 20");
		for (const artifact of result.rows) {
			await rm(artifact.storage_path, { force: true });
			await this.database.query("update artifacts set deleted_at = now() where artifact_id = $1", [artifact.artifact_id]);
		}
	}
}