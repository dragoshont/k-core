import { assertConfig, profileConfigState, readConfig } from "../modules/config";
import { createDatabase } from "../modules/db/database";
import { migrate } from "../modules/db/migrator";

const config = assertConfig(readConfig());
const database = createDatabase(config);

const direction = process.argv.includes("--down") ? "down" : "up";
const targetIndex = process.argv.findIndex((arg) => arg === "--to");
const targetVersion = targetIndex > -1 ? Number.parseInt(process.argv[targetIndex + 1] ?? "0", 10) : undefined;

await migrate(database, { allowDown: config.allowMigrationDown, direction, profileConfig: profileConfigState(config), targetVersion });
await database.close();