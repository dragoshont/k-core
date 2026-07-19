import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import type { AppConfig } from "../config";

export interface SqlExecutor {
	query<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<T>>;
}

export interface Database extends SqlExecutor {
	close(): Promise<void>;
	pool: Pool;
	withClient<T>(callback: (client: PoolClient) => Promise<T>): Promise<T>;
	withTransaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T>;
}

export function createDatabase(config: AppConfig): Database {
	const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });

	return {
		close() {
			return pool.end();
		},
		pool,
		query(text, values) {
			return pool.query(text, values);
		},
		async withClient<T>(callback: (client: PoolClient) => Promise<T>) {
			const client = await pool.connect();
			try {
				return await callback(client);
			} finally {
				client.release();
			}
		},
		withTransaction(callback) {
			return withTransaction(pool, callback);
		},
	};
}

export async function withTransaction<T>(executor: Pool | PoolClient, callback: (client: PoolClient) => Promise<T>) {
	const client = "release" in executor ? executor : await executor.connect();
	const ownedClient = !("release" in executor);
	try {
		await client.query("begin");
		const result = await callback(client);
		await client.query("commit");
		return result;
	} catch (error) {
		await client.query("rollback");
		throw error;
	} finally {
		if (ownedClient) {
			client.release();
		}
	}
}