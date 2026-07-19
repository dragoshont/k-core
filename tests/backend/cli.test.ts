import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../../src/modules/config";
import { createDatabase, type Database } from "../../src/modules/db/database";
import { migrate } from "../../src/modules/db/migrator";
import { startPostgresHarness, type PostgresHarness } from "./helpers/postgres";

const execFileAsync = promisify(execFile);

describe("operator credential CLI", () => {
	let config: AppConfig;
	let database: Database;
	let harness: PostgresHarness;
	let env: NodeJS.ProcessEnv;

	beforeEach(async () => {
		harness = await startPostgresHarness();
		config = {
			allowedPrivateClientCidrs: [], allowMigrationDown: true, databaseUrl: harness.connectionString,
			outboundContact: "test@example.invalid",
			pinPepper: "p".repeat(32), pinReuseSecret: "r".repeat(32), port: 3000,
			publicOrigin: new URL("https://k.example.invalid"), sessionSigningKey: "s".repeat(32),
			sourceHashSecret: "h".repeat(32), trustedProxyCidrs: [], userAgent: "k-test",
		};
		database = createDatabase(config);
		await migrate(database, { allowDown: true });
		env = {
			...process.env,
			ALLOWED_PRIVATE_CLIENT_CIDRS: "10.0.0.0/8",
			DATABASE_URL: harness.connectionString,
			OUTBOUND_CONTACT: config.outboundContact,
			PIN_PEPPER: config.pinPepper,
			PIN_REUSE_SECRET: config.pinReuseSecret,
			PUBLIC_ORIGIN: config.publicOrigin.origin,
			SESSION_SIGNING_KEY: config.sessionSigningKey,
			SOURCE_HASH_SECRET: config.sourceHashSecret,
			TRUSTED_PROXY_CIDRS: "10.1.0.0/16",
		};
	});

	afterEach(async () => {
		await database.close();
		await harness.stop();
	});

	function runCli(args: string[]) {
		return execFileAsync(process.execPath, [resolve("build/server/bin/k.js"), ...args], {
			env,
			timeout: 5_000,
		});
	}

	it("prints a setup code once and persists only its digest", async () => {
		const result = await runCli([
			"admin", "credential-code", "--profile", "member-1", "--purpose", "setup",
			"--ttl", "15m", "--issuer", "cli-test",
		]);
		const code = result.stdout.trim();
		expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(result.stdout).toBe(`${code}\n`);
		expect(result.stderr).toBe("");

		const persisted = await database.query<{ audit_details: string; digest: Buffer; issuer_label: string; reason: string }>(`
			select c.digest, c.issuer_label, c.reason, a.details_json::text as audit_details
			from credential_codes c
			join audit_events a on a.profile_id = c.profile_id and a.action = 'credential-code.issue.setup'
			where c.consumed_at is null
		`);
		expect(persisted.rows).toHaveLength(1);
		const expectedDigest = createHash("sha256").update(Buffer.from(code, "base64url")).digest();
		expect(persisted.rows[0]?.digest).toEqual(expectedDigest);
		expect(JSON.stringify(persisted.rows[0])).not.toContain(code);
		expect(persisted.rows[0]).toMatchObject({ issuer_label: "cli-test", reason: "Operator setup issuance" });
	});

	it("exits without printing a code for invalid state or TTL", async () => {
		await expect(runCli([
			"admin", "credential-code", "--profile", "member-3", "--purpose", "recovery",
		])).rejects.toMatchObject({
			code: 1,
			stdout: "",
			stderr: "credential_state_conflict: Recovery codes require a configured profile.\n",
		});
	}, 10_000);

	it("rejects an out-of-range TTL before writing state", async () => {
		await expect(runCli([
			"admin", "credential-code", "--profile", "member-2", "--purpose", "setup", "--ttl", "25h",
		])).rejects.toMatchObject({
			code: 2,
			stdout: "",
			stderr: "TTL must be between 1 minute and 24 hours\n",
		});
		const codes = await database.query<{ count: string }>("select count(*)::text as count from credential_codes");
		expect(codes.rows[0]?.count).toBe("0");
	});

	it("refuses credential issuance when database aliases drift from configuration", async () => {
		await database.withTransaction(async (client) => {
			await client.query("select set_config('k.profile_alias_migration', 'on', true)");
			await client.query(`
				update profiles set slug = 'drifted-member'
				where profile_id = '00000000-0000-4000-8000-000000000001'
			`);
		});
		await expect(runCli([
			"admin", "credential-code", "--profile", "member-1", "--purpose", "setup",
		])).rejects.toMatchObject({
			code: 1,
			stdout: "",
			stderr: "profile_configuration_mismatch: Service is not ready\n",
		});
		const codes = await database.query<{ count: string }>("select count(*)::text as count from credential_codes");
		expect(codes.rows[0]?.count).toBe("0");
	});
});