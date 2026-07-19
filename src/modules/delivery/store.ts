import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { SqlExecutor } from "../db/database";

export const STAGES = ["preflight", "acquire", "validate", "metadata", "convert", "validate-output", "deliver", "cleanup"] as const;

export async function readDeliveryProfile(executor: SqlExecutor, profileId: string) {
	const result = await executor.query<{ destination_revision: number; kindle_address: string | null; slug: string }>(
		"select slug, kindle_address, destination_revision from profiles where profile_id = $1",
		[profileId],
	);
	return result.rows[0] ?? null;
}

export async function updateDeliveryProfile(executor: SqlExecutor, profileId: string, kindleAddress: string | null) {
	const result = await executor.query<{ destination_revision: number; kindle_address: string | null; slug: string }>(`
		update profiles set kindle_address = $2, destination_revision = destination_revision + 1, updated_at = now()
		where profile_id = $1 returning slug, kindle_address, destination_revision
	`, [profileId, kindleAddress]);
	return result.rows[0] ?? null;
}

export async function insertPreflight(client: PoolClient, input: {
	blockers: unknown[]; destinationRevision: number; expiresAt: Date; item: unknown; itemId: string; optionId: string; pluginDigest: string; pluginId: string; profileId: string; ready: boolean; warnings: unknown[];
}) {
	const preflightId = randomUUID();
	await client.query(`
		insert into delivery_preflights (preflight_id, profile_id, plugin_id, item_id, option_id, plugin_digest, destination_revision, item_json, ready, blockers_json, warnings_json, expires_at)
		values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb,$11::jsonb,$12)
	`, [preflightId, input.profileId, input.pluginId, input.itemId, input.optionId, input.pluginDigest, input.destinationRevision, JSON.stringify(input.item), input.ready, JSON.stringify(input.blockers), JSON.stringify(input.warnings), input.expiresAt]);
	return preflightId;
}

export async function createOperationFromPreflight(client: PoolClient, input: { idempotencyKey: string; item: unknown; itemId: string; operationTarget: unknown; optionId: string; pluginDigest: string; pluginId: string; preflightId: string; profileId: string }) {
	const existing = await client.query<{ operation_id: string }>("select operation_id from operations where profile_id = $1 and idempotency_key = $2", [input.profileId, input.idempotencyKey]);
	if (existing.rows[0]) return { created: false, operationId: existing.rows[0].operation_id };
	const preflight = await client.query<{ item_json: unknown; preflight_id: string }>(`
		select p.preflight_id, p.item_json from delivery_preflights p
		join profiles profile on profile.profile_id = p.profile_id
		where p.preflight_id = $1 and p.profile_id = $2 and p.ready = true and p.consumed_at is null and p.expires_at > now()
		  and profile.destination_revision = p.destination_revision and p.plugin_digest = $3
		  and p.plugin_id = $4 and p.item_id = $5 and p.option_id = $6 and p.item_json = $7::jsonb
		for update
	`, [input.preflightId, input.profileId, input.pluginDigest, input.pluginId, input.itemId, input.optionId, JSON.stringify(input.item)]);
	if (!preflight.rows[0]) return null;
	const operationId = randomUUID();
	const correlationId = randomUUID();
	await client.query(`
		insert into operations (operation_id, profile_id, preflight_id, idempotency_key, status, target_json, correlation_id)
		values ($1,$2,$3,$4,'queued',$5::jsonb,$6)
	`, [operationId, input.profileId, input.preflightId, input.idempotencyKey, JSON.stringify(input.operationTarget), correlationId]);
	for (const [index, name] of STAGES.entries()) {
		await client.query("insert into operation_stages (operation_id, stage_index, name, status) values ($1,$2,$3,$4)", [operationId, index, name, index === 0 ? "succeeded" : "not-started"]);
	}
	await client.query("update delivery_preflights set consumed_at = now() where preflight_id = $1", [input.preflightId]);
	return { created: true, operationId };
}

export async function readOperation(executor: SqlExecutor, profileId: string, operationId: string) {
	const operation = await executor.query("select * from operations where operation_id = $1 and profile_id = $2", [operationId, profileId]);
	if (!operation.rows[0]) return null;
	const stages = await executor.query("select * from operation_stages where operation_id = $1 order by stage_index", [operationId]);
	return { ...operation.rows[0], stages: stages.rows } as Record<string, unknown> & { stages: Record<string, unknown>[] };
}

export async function listOperations(executor: SqlExecutor, profileId: string) {
	const result = await executor.query("select * from operations where profile_id = $1 order by updated_at desc limit 50", [profileId]);
	return result.rows;
}