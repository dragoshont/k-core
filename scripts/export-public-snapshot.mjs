#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { copyFile, lstat, mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

function fail(message) {
  throw new Error(message);
}

function normalizeRelativePath(value) {
  const normalized = value.split(path.sep).join("/").replace(/^\.\//u, "");
  if (!normalized || normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    fail("candidate path escapes the source root");
  }
  return normalized;
}

function isExcluded(relativePath, config) {
  return config.excludedPaths.includes(relativePath) || config.excludedPrefixes.some((prefix) => relativePath.startsWith(prefix));
}

function listCandidates(root) {
  return execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  })
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map(normalizeRelativePath);
}

async function main() {
  const [destinationArgument, ...rest] = process.argv.slice(2);
  if (!destinationArgument || rest.length > 0) fail("usage: export-public-snapshot.mjs <empty-destination-directory>");

  const sourceRoot = await realpath(process.cwd());
  const destination = path.resolve(destinationArgument);
  let destinationStat;
  try {
    destinationStat = await lstat(destination);
  } catch {
    await mkdir(destination, { recursive: true, mode: 0o700 });
    destinationStat = await lstat(destination);
  }
  if (!destinationStat.isDirectory() || destinationStat.isSymbolicLink()) fail("destination must be a regular directory");
  const destinationRoot = await realpath(destination);
  if (destinationRoot === sourceRoot || destinationRoot.startsWith(`${sourceRoot}${path.sep}`)) fail("destination must be outside the source tree");
  const existing = execFileSync("find", [destinationRoot, "-mindepth", "1", "-maxdepth", "1", "-print", "-quit"], { encoding: "utf8" }).trim();
  if (existing) fail("destination must be empty");

  const config = JSON.parse(await readFile(path.join(sourceRoot, ".oss-snapshot.json"), "utf8"));
  const candidates = [...new Set(listCandidates(sourceRoot))].sort().filter((relativePath) => !isExcluded(relativePath, config));

  for (const relativePath of candidates) {
    const source = path.join(sourceRoot, relativePath);
    const sourceStat = await lstat(source);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) fail(`${relativePath}: public snapshot accepts regular files only`);
    const target = path.join(destinationRoot, relativePath);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
    await copyFile(source, target);
  }

  const exportedGit = path.join(destinationRoot, ".git");
  try {
    await lstat(exportedGit);
    fail("export unexpectedly contains Git metadata");
  } catch (error) {
    if (error instanceof Error && error.message === "export unexpectedly contains Git metadata") throw error;
  }

  process.stdout.write(`PUBLIC-EXPORT: PASS (${candidates.length} files, no Git ancestry)\n`);
}

main().catch((error) => {
  process.stderr.write(`PUBLIC-EXPORT: FAIL\n${error instanceof Error ? error.message : "unexpected export failure"}\n`);
  process.exitCode = 1;
});
