import { assertConfig, readConfig } from "../../modules/config";
import { createDatabase } from "../../modules/db/database";
import { PluginCatalogService } from "../../modules/plugins/catalog";
import { DeliveryService } from "../../modules/delivery/service";
import { DeliveryWorker } from "../../modules/delivery/worker";

const config = assertConfig(readConfig());
const database = createDatabase(config);
const catalog = new PluginCatalogService(database, config);
const delivery = new DeliveryService(database, config, catalog);
const worker = new DeliveryWorker(database, config, catalog, delivery);

const processed = await worker.runOnce();
process.stdout.write(processed ? "processed\n" : "idle\n");
await database.close();