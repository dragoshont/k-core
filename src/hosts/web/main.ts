import { createServer } from "node:http";
import { assertConfig, readConfig } from "../../modules/config";
import { createDatabase } from "../../modules/db/database";
import { createRouter } from "../../modules/http/router";
import { readNodeBody } from "../../modules/http/app-types";
import { problemJson } from "../../modules/http/problems";
import { randomUUID } from "node:crypto";

const config = assertConfig(readConfig());
const database = createDatabase(config);
const route = createRouter({ config, database });

const server = createServer(async (request, response) => {
	let appResponse;
	try {
		const bodyText = await readNodeBody(request);
		appResponse = await route({
			bodyText,
			headers: Object.fromEntries(Object.entries(request.headers).map(([name, value]) => [name.toLowerCase(), Array.isArray(value) ? value.join(",") : value])),
			method: request.method ?? "GET",
			remoteAddress: request.socket.remoteAddress ?? null,
			url: new URL(request.url ?? "/", config.publicOrigin),
		});
	} catch (error) {
		appResponse = problemJson(error, randomUUID());
	}
	response.statusCode = appResponse.status;
	for (const [name, value] of Object.entries(appResponse.headers ?? {})) {
		response.setHeader(name, value);
	}
	response.end(appResponse.body);
});

server.listen(config.port, () => {
	process.stdout.write(`k web listening on ${config.port}\n`);
});

process.on("SIGINT", async () => {
	await database.close();
	server.close();
	process.exit(0);
});