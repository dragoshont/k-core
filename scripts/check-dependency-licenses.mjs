#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const ALLOWED_LICENSES = new Set([
  "0BSD",
  "Apache-1.1",
  "Apache-2.0",
  "Artistic-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BlueOak-1.0.0",
  "BSL-1.0",
  "CC0-1.0",
  "CC-BY-4.0",
  "EPL-1.0",
  "EPL-2.0",
  "ISC",
  "MIT",
  "MIT-0",
  "MPL-1.1",
  "MPL-2.0",
  "OFL-1.1",
  "Python-2.0",
  "Unicode-3.0",
  "Unlicense",
  "Zlib",
]);
const ALLOWED_EXCEPTIONS = new Set(["LLVM-exception"]);
const RESTRICTED_LICENSE = /(?:\b(?:A?GPL|LGPL|SSPL)-|\bBUSL-|Commons(?:-|\s)Clause)/iu;

function fail(findings) {
  process.stderr.write(`DEPENDENCY-LICENSES: FAIL\n${findings.join("\n")}\n`);
  process.exitCode = 1;
}

function parseArguments(argv) {
  let root = process.cwd();
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--root" || !argv[index + 1]) {
      throw new Error(`unknown or incomplete argument: ${argv[index] ?? ""}`);
    }
    root = argv[index + 1];
    index += 1;
  }
  return path.resolve(root);
}

function licenseStrings(value) {
  if (typeof value === "string" && value.trim().length > 0) {
    return [value.trim()];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      if (typeof entry === "string") return licenseStrings(entry);
      if (entry && typeof entry === "object" && "type" in entry) return licenseStrings(entry.type);
      return [];
    });
  }
  return [];
}

function validateExpression(expression) {
  if (RESTRICTED_LICENSE.test(expression)) {
    return "restricted-license";
  }
  if (!/^[A-Za-z0-9.+()\s-]+$/u.test(expression)) {
    return "unknown-license";
  }
  const tokens = expression.match(/[A-Za-z0-9][A-Za-z0-9.+-]*/gu) ?? [];
  if (tokens.length === 0) {
    return "unknown-license";
  }
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "AND" || token === "OR") continue;
    if (token === "WITH") {
      const exception = tokens[index + 1];
      if (!exception || !ALLOWED_EXCEPTIONS.has(exception)) return "unknown-license";
      index += 1;
      continue;
    }
    if (!ALLOWED_LICENSES.has(token)) {
      return "unknown-license";
    }
  }
  return undefined;
}

async function readJson(filePath, required) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (!required && error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw new Error(`${path.basename(filePath)} is missing or invalid`);
  }
}

async function main() {
  const root = parseArguments(process.argv.slice(2));
  const lock = await readJson(path.join(root, "package-lock.json"), true);
  if (!lock || !Number.isInteger(lock.lockfileVersion) || lock.lockfileVersion < 2 || !lock.packages || typeof lock.packages !== "object") {
    throw new Error("package-lock.json must provide lockfile v2+ package metadata");
  }
  const rootPackage = lock.packages[""];
  if (!rootPackage || typeof rootPackage !== "object") {
    throw new Error("package-lock.json is missing the root package record");
  }

  const packageEntries = Object.entries(lock.packages)
    .filter(([packagePath, entry]) => packagePath.startsWith("node_modules/") && entry && typeof entry === "object" && entry.link !== true)
    .sort(([left], [right]) => left.localeCompare(right));
  const productionEntries = packageEntries.filter(([, entry]) => entry.dev !== true);
  const productionRoots = Object.keys(rootPackage.dependencies ?? {}).map((name) => `node_modules/${name}`);
  const productionPaths = new Set(productionEntries.map(([packagePath]) => packagePath));
  const missingRoots = productionRoots.filter((packagePath) => !productionPaths.has(packagePath));
  if (missingRoots.length > 0) {
    fail(missingRoots.map((packagePath) => `${packagePath}: missing-production-lock-entry`));
    return;
  }

  const findings = [];
  let manifestEvidence = 0;
  let lockEvidence = 0;
  for (const [packagePath, lockEntry] of packageEntries) {
    const manifest = await readJson(path.join(root, packagePath, "package.json"), false);
    const manifestLicenses = manifest ? licenseStrings(manifest.license ?? manifest.licenses) : [];
    const lockLicenses = licenseStrings(lockEntry.license ?? lockEntry.licenses);
    const licenses = manifestLicenses.length > 0 ? manifestLicenses : lockLicenses;
    if (licenses.length === 0) {
      findings.push(`${packagePath}: missing-license-evidence`);
      continue;
    }
    if (manifestLicenses.length > 0) manifestEvidence += 1;
    else lockEvidence += 1;
    const violation = licenses.map(validateExpression).find(Boolean);
    if (violation) {
      findings.push(`${packagePath}: ${violation}`);
    }
  }

  if (findings.length > 0) {
    fail(findings);
    return;
  }
  process.stdout.write(`DEPENDENCY-LICENSES: PASS (${packageEntries.length} locked packages, ${productionEntries.length} production; ${manifestEvidence} manifest, ${lockEvidence} lock fallback)\n`);
}

main().catch((error) => fail([error instanceof Error ? error.message : "unexpected checker failure"]));