import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function findUp(start: string, fileName: string) {
	let current = start;
	for (;;) {
		if (existsSync(resolve(current, fileName))) {
			return current;
		}

		const parent = dirname(current);
		if (parent === current) {
			throw new Error(`Could not find ${fileName} from ${start}`);
		}
		current = parent;
	}
}

export function findRepoRoot(fromUrl = import.meta.url) {
	return findUp(dirname(fileURLToPath(fromUrl)), "architrave.config.json");
}

export function readUiCss(root = findRepoRoot()) {
	return {
		tokens: readFileSync(resolve(root, "src/ui/tokens.css"), "utf8"),
		styles: readFileSync(resolve(root, "src/ui/styles.css"), "utf8"),
	};
}

export function readMigrationDirectory(root = findRepoRoot()) {
	const path = resolve(root, "migrations");
	return {
		path,
		files: readdirSync(path).filter((fileName) => fileName.endsWith(".sql")).sort(),
	};
}