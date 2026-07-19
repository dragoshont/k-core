#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const CONFIG_KEYS = new Set([
  "version",
  "candidateSource",
  "maxFileBytes",
  "excludedPaths",
  "excludedPrefixes",
  "publicPluginEntries",
  "secretFilenamePatterns",
  "forbiddenTextPatterns",
]);

function fail(message) {
  process.stderr.write(`PUBLIC-SNAPSHOT: FAIL\n${message}\n`);
  process.exitCode = 1;
}

function parseArguments(argv) {
  const options = { root: process.cwd(), exportDirectory: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--root" || argument === "--export-dir") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`${argument} requires a value`);
      }
      if (argument === "--root") {
        options.root = value;
      } else {
        options.exportDirectory = value;
      }
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

function normalizeRelativePath(value) {
  const normalized = value.split(path.sep).join("/").replace(/^\.\//, "");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    throw new Error("candidate path escapes the snapshot root");
  }
  return normalized;
}

function validateStringArray(config, key) {
  if (!Array.isArray(config[key]) || config[key].some((value) => typeof value !== "string" || value.length === 0)) {
    throw new Error(`${key} must be a non-empty-string array`);
  }
}

function validateConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("snapshot config must be an object");
  }
  const unknownKeys = Object.keys(config).filter((key) => !CONFIG_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(`snapshot config has unknown keys: ${unknownKeys.join(", ")}`);
  }
  if (config.version !== 1 || config.candidateSource !== "git-tracked-and-untracked-nonignored") {
    throw new Error("snapshot config version or candidate source is unsupported");
  }
  if (!Number.isSafeInteger(config.maxFileBytes) || config.maxFileBytes < 1) {
    throw new Error("maxFileBytes must be a positive integer");
  }
  for (const key of ["excludedPaths", "excludedPrefixes", "publicPluginEntries", "secretFilenamePatterns"]) {
    validateStringArray(config, key);
  }
  if (!Array.isArray(config.forbiddenTextPatterns) || config.forbiddenTextPatterns.length === 0) {
    throw new Error("forbiddenTextPatterns must be a non-empty array");
  }
  for (const entry of config.forbiddenTextPatterns) {
    if (
      !entry ||
      typeof entry !== "object" ||
      Object.keys(entry).sort().join(",") !== "pattern,rule" ||
      typeof entry.rule !== "string" ||
      !/^[a-z0-9-]+$/.test(entry.rule) ||
      typeof entry.pattern !== "string" ||
      entry.pattern.length === 0
    ) {
      throw new Error("each forbidden text pattern must have only a generic rule and pattern");
    }
    new RegExp(entry.pattern, "gmu");
  }
  const sortedPlugins = [...config.publicPluginEntries].sort();
  if (new Set(sortedPlugins).size !== sortedPlugins.length || sortedPlugins.join("\n") !== config.publicPluginEntries.join("\n")) {
    throw new Error("publicPluginEntries must be unique and sorted");
  }
}

function isExcluded(relativePath, config) {
  return config.excludedPaths.includes(relativePath) || config.excludedPrefixes.some((prefix) => relativePath.startsWith(prefix));
}

function listGitCandidates(root) {
  const staged = execFileSync("git", ["ls-files", "--stage", "-z"], {
    cwd: root,
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  for (const record of staged.toString("utf8").split("\0").filter(Boolean)) {
    const tab = record.indexOf("\t");
    const mode = record.slice(0, tab).split(" ", 1)[0];
    if (tab < 0 || (mode !== "100644" && mode !== "100755")) {
      throw new Error("tracked candidate has a non-regular Git file mode");
    }
  }
  const output = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  return output
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map(normalizeRelativePath);
}

async function walkExport(directory, relativeDirectory = "") {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(path.join(directory, relativeDirectory), { withFileTypes: true });
  const paths = [];
  for (const entry of entries) {
    const relativePath = normalizeRelativePath(path.posix.join(relativeDirectory, entry.name));
    paths.push(relativePath);
    if (entry.isDirectory()) {
      paths.push(...(await walkExport(directory, relativePath)));
    }
  }
  return paths;
}

async function readPrivateDenylist(root) {
  const denylistPath = process.env.PUBLIC_SNAPSHOT_PRIVATE_DENYLIST_FILE;
  if (!denylistPath) {
    return [];
  }
  const resolvedRoot = await realpath(root);
  const resolvedDenylist = await realpath(denylistPath);
  if (resolvedDenylist === resolvedRoot || resolvedDenylist.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("private denylist must be outside the snapshot root");
  }
  const values = (await readFile(resolvedDenylist, "utf8"))
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && !value.startsWith("#"));
  if (values.some((value) => value.length < 3 || /[\r\n\0]/u.test(value))) {
    throw new Error("private denylist contains an invalid entry");
  }
  return values;
}

function pluginEntry(relativePath) {
  if (!relativePath.startsWith("plugins/")) {
    return undefined;
  }
  return relativePath.slice("plugins/".length).split("/", 1)[0];
}

function containsDeniedValue(value, denylist) {
  const folded = value.toLocaleLowerCase("en-US");
  return denylist.some((denied) => {
    const needle = denied.toLocaleLowerCase("en-US");
    let offset = folded.indexOf(needle);
    while (offset >= 0) {
      const before = offset > 0 ? folded[offset - 1] : undefined;
      const after = folded[offset + needle.length];
      const startsAtBoundary = !/[a-z0-9]/u.test(needle[0]) || !before || !/[a-z0-9]/u.test(before);
      const endsAtBoundary = !/[a-z0-9]/u.test(needle[needle.length - 1]) || !after || !/[a-z0-9]/u.test(after);
      if (startsAtBoundary && endsAtBoundary) {
        return true;
      }
      offset = folded.indexOf(needle, offset + 1);
    }
    return false;
  });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const root = path.resolve(options.exportDirectory ?? options.root);
  const configRoot = path.resolve(options.root);
  const config = JSON.parse(await readFile(path.join(configRoot, ".oss-snapshot.json"), "utf8"));
  validateConfig(config);

  const denylist = await readPrivateDenylist(root);
  const listedPaths = options.exportDirectory ? await walkExport(root) : listGitCandidates(root);
  const candidates = [...new Set(listedPaths)].sort().filter((relativePath) => !isExcluded(relativePath, config));
  const findings = [];
  const filenamePatterns = config.secretFilenamePatterns.map((pattern) => new RegExp(pattern, "iu"));
  const textPatterns = config.forbiddenTextPatterns.map(({ rule, pattern }) => ({ rule, expression: new RegExp(pattern, "gmu") }));

  for (const relativePath of candidates) {
    const absolutePath = path.join(root, relativePath);
    let metadata;
    try {
      metadata = await lstat(absolutePath);
    } catch {
      findings.push(`${relativePath}: candidate-missing`);
      continue;
    }
    if (metadata.isSymbolicLink()) {
      findings.push(`${relativePath}: symlink`);
      continue;
    }
    if (metadata.isDirectory()) {
      continue;
    }
    if (!metadata.isFile()) {
      findings.push(`${relativePath}: special-file`);
      continue;
    }
    const entry = pluginEntry(relativePath);
    if (entry && !config.publicPluginEntries.includes(entry)) {
      findings.push(`${relativePath}: unexpected-plugin-entry`);
    }
    if (filenamePatterns.some((expression) => expression.test(relativePath))) {
      findings.push(`${relativePath}: secret-filename`);
    }
    if (containsDeniedValue(relativePath, denylist)) {
      findings.push(`${relativePath}: private-denylist-path`);
    }
    if (metadata.size > config.maxFileBytes) {
      findings.push(`${relativePath}: file-too-large`);
      continue;
    }
    const content = await readFile(absolutePath);
    if (content.some((byte) => (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0c && byte !== 0x0d) || byte === 0x7f)) {
      findings.push(`${relativePath}: binary-file`);
      continue;
    }
    const text = content.toString("utf8");
    if (Buffer.byteLength(text, "utf8") !== content.length) {
      findings.push(`${relativePath}: invalid-utf8`);
      continue;
    }
    if (relativePath !== ".oss-snapshot.json") {
      for (const { rule, expression } of textPatterns) {
        expression.lastIndex = 0;
        if (expression.test(text)) {
          findings.push(`${relativePath}: ${rule}`);
        }
      }
    }
    if (containsDeniedValue(text, denylist)) {
      findings.push(`${relativePath}: private-denylist-content`);
    }
  }

  if (findings.length > 0) {
    fail(findings.join("\n"));
    return;
  }
  process.stdout.write(`PUBLIC-SNAPSHOT: PASS (${candidates.length} candidate paths, ${denylist.length > 0 ? "private denylist applied" : "generic rules"})\n`);
}

main().catch((error) => fail(error instanceof Error ? error.message : "unexpected scanner failure"));