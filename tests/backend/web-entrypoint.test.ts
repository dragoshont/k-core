import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "../../src/modules/db/database";
import { migrate } from "../../src/modules/db/migrator";
import { startPostgresHarness, type PostgresHarness } from "./helpers/postgres";

async function availablePort() {
	const server = createServer();
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Could not allocate a web test port");
	await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
	return address.port;
}

async function stopProcess(child: ChildProcess | null) {
	if (!child || child.exitCode !== null) return;
	child.kill("SIGINT");
	await once(child, "close");
}

describe("built web entrypoint", () => {
	let child: ChildProcess | null = null;
	let database: Database;
	let harness: PostgresHarness;

	beforeEach(async () => {
		harness = await startPostgresHarness();
		database = createDatabase({
			allowedPrivateClientCidrs: [], allowMigrationDown: true, databaseUrl: harness.connectionString,
			outboundContact: "test@example.invalid", pinPepper: "p".repeat(32), pinReuseSecret: "r".repeat(32), port: 3000,
			publicOrigin: new URL("https://k-entrypoint.example.invalid"), sessionSigningKey: "s".repeat(32),
			sourceHashSecret: "h".repeat(32), trustedProxyCidrs: [], userAgent: "k-test",
		});
		await migrate(database, { allowDown: true });
	});

	afterEach(async () => {
		await stopProcess(child);
		await database.close();
		await harness.stop();
	});

	it("starts the production bundle with neutral profiles and fails closed on alias drift", async () => {
		const port = await availablePort();
		let stderr = "";
		child = spawn(process.execPath, [resolve("build/server/hosts/web/main.js")], {
			env: {
				...process.env,
				ALLOWED_PRIVATE_CLIENT_CIDRS: "127.0.0.0/8",
				DATABASE_URL: harness.connectionString,
				OUTBOUND_CONTACT: "test@example.invalid",
				PIN_PEPPER: "p".repeat(32),
				PIN_REUSE_SECRET: "r".repeat(32),
				PLUGIN_DIR: resolve("plugins"),
				PORT: String(port),
				PUBLIC_ORIGIN: "https://k-entrypoint.example.invalid",
				SESSION_SIGNING_KEY: "s".repeat(32),
				SOURCE_HASH_SECRET: "h".repeat(32),
				TRUSTED_PROXY_CIDRS: "127.0.0.0/8",
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
		await new Promise<void>((resolveStart, reject) => {
			const timeout = setTimeout(() => reject(new Error(`web entrypoint did not start: ${stderr}`)), 5_000);
			child?.once("exit", (code) => {
				clearTimeout(timeout);
				reject(new Error(`web entrypoint exited with ${code}: ${stderr}`));
			});
			child?.stdout?.on("data", (chunk: Buffer) => {
				if (chunk.toString("utf8").includes(`k web listening on ${port}`)) {
					clearTimeout(timeout);
					resolveStart();
				}
			});
		});

		const response = await fetch(`http://127.0.0.1:${port}/unlock`, {
			headers: {
				"x-forwarded-for": "127.0.0.1",
				"x-forwarded-host": "k-entrypoint.example.invalid",
				"x-forwarded-proto": "https",
			},
		});
		const html = await response.text();
		expect(response.status).toBe(200);
		expect(html).toContain("Member 1");
		expect(html).toContain("Member 2");
		expect(html).toContain("Member 3");

		await database.withTransaction(async (client) => {
			await client.query("select set_config('k.profile_alias_migration', 'on', true)");
			await client.query(`
				update profiles set display_name = 'Drifted Member'
				where profile_id = '00000000-0000-4000-8000-000000000001'
			`);
		});
		const [health, ready, application] = await Promise.all([
			fetch(`http://127.0.0.1:${port}/healthz`),
			fetch(`http://127.0.0.1:${port}/readyz`),
			fetch(`http://127.0.0.1:${port}/unlock`, {
				headers: {
					"x-forwarded-for": "127.0.0.1",
					"x-forwarded-host": "k-entrypoint.example.invalid",
					"x-forwarded-proto": "https",
				},
			}),
		]);
		expect(health.status).toBe(200);
		expect(await health.text()).toBe("ok");
		expect(ready.status).toBe(503);
		expect(await ready.json()).toMatchObject({ code: "profile_configuration_mismatch" });
		expect(application.status).toBe(503);
		expect(await application.text()).toContain('data-problem-code="profile_configuration_mismatch"');
		expect(stderr).toBe("");
	});
});