import { randomUUID } from "node:crypto";
import { Client } from "pg";

export interface PostgresHarness {
	containerName: string;
	connectionString: string;
	stop(): Promise<void>;
}

function databaseName() {
	return `k_${randomUUID().replaceAll("-", "")}`;
}

export async function startPostgresHarness(): Promise<PostgresHarness> {
	const adminUrl = process.env.K_TEST_POSTGRES_ADMIN_URL;
	if (!adminUrl) {
		throw new Error("K_TEST_POSTGRES_ADMIN_URL is missing. Run backend tests through scripts/run-backend-tests.mjs.");
	}

	const name = databaseName();
	const admin = new Client({ connectionString: adminUrl });
	await admin.connect();
	await admin.query(`create database "${name}"`);
	await admin.end();

	const connectionUrl = new URL(adminUrl);
	connectionUrl.pathname = `/${name}`;
	let stopped = false;
	return {
		connectionString: connectionUrl.toString(),
		containerName: `database:${name}`,
		async stop() {
			if (stopped) return;
			stopped = true;
			const cleanup = new Client({ connectionString: adminUrl });
			await cleanup.connect();
			try {
				await cleanup.query("select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()", [name]);
				await cleanup.query(`drop database if exists "${name}"`);
			} finally {
				await cleanup.end();
			}
		},
	};
}