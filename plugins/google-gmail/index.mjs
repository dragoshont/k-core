import { readFile } from "node:fs/promises";
import { isPluginMain, runCapabilityPlugin } from "../lib/runtime.mjs";

export const manifest = JSON.parse(await readFile(new URL("./plugin.json", import.meta.url), "utf8"));

if (isPluginMain(import.meta.url)) {
	// Core validates Google OIDC and UserInfo once; plugin normalization is intentionally deferred.
	await runCapabilityPlugin(manifest, {});
}