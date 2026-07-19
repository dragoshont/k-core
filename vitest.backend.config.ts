import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		fileParallelism: false,
		hookTimeout: 60000,
		include: ["tests/backend/**/*.test.ts"],
		maxWorkers: 1,
		passWithNoTests: false,
		testTimeout: 60000,
	},
});