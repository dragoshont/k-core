import { build } from "esbuild";

await build({
	banner: {
		js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
	},
	bundle: true,
	entryPoints: [
		"src/bin/k.ts",
		"src/bin/migrate.ts",
		"src/hosts/web/main.ts",
		"src/hosts/worker/main.ts",
	],
	external: ["argon2", "ipaddr.js", "pg"],
	format: "esm",
	logLevel: "info",
	outbase: "src",
	outdir: "build/server",
	platform: "node",
	sourcemap: true,
	target: "node24",
});