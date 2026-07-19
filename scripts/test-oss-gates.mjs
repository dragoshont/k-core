#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.dirname(scriptsDirectory);
const snapshotChecker = path.join(scriptsDirectory, "check-public-snapshot.mjs");
const licenseChecker = path.join(scriptsDirectory, "check-dependency-licenses.mjs");
const temporaryRoot = await mkdtemp(path.join(tmpdir(), "k-oss-gates-"));

function run(script, args, environment = {}) {
  const env = { ...process.env, ...environment };
  delete env.PUBLIC_SNAPSHOT_PRIVATE_DENYLIST_FILE;
  if (environment.PUBLIC_SNAPSHOT_PRIVATE_DENYLIST_FILE) {
    env.PUBLIC_SNAPSHOT_PRIVATE_DENYLIST_FILE = environment.PUBLIC_SNAPSHOT_PRIVATE_DENYLIST_FILE;
  }
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env });
}

function assertResult(result, expectedStatus, expectedRule) {
  if (result.status !== expectedStatus || (expectedRule && !result.stderr.includes(expectedRule))) {
    throw new Error(`OSS gate self-test failed: expected status ${expectedStatus}${expectedRule ? ` and ${expectedRule}` : ""}`);
  }
}

async function createExport(name, files) {
  const directory = path.join(temporaryRoot, name);
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(directory, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
  }
  return directory;
}

function scanExport(directory, environment) {
  return run(snapshotChecker, ["--root", repositoryRoot, "--export-dir", directory], environment);
}

function lockfile(packages) {
  return JSON.stringify({
    name: "license-fixture",
    version: "1.0.0",
    lockfileVersion: 3,
    packages,
  });
}

try {
  const clean = await createExport("clean", {
    ".architrave/runs/private-evidence.md": ["LicenseRef", "Proprietary"].join("-"),
    "plugins/project-gutenberg/manifest.json": "{}\n",
    "src/index.mjs": "export const value = 1;\n",
  });
  assertResult(scanExport(clean), 0);

  const deniedPhrase = "Example Family";
  const denylist = path.join(temporaryRoot, "private-denylist.txt");
  await writeFile(denylist, `${deniedPhrase}\n`);
  const denied = await createExport("private-denied", { "src/profile.txt": deniedPhrase });
  const deniedResult = scanExport(denied, { PUBLIC_SNAPSHOT_PRIVATE_DENYLIST_FILE: denylist });
  assertResult(deniedResult, 1, "private-denylist-content");
  if (deniedResult.stderr.includes(deniedPhrase)) throw new Error("private denylist value was disclosed");

  const unexpectedPlugin = await createExport("unexpected-plugin", { "plugins/operator-only/manifest.json": "{}\n" });
  assertResult(scanExport(unexpectedPlugin), 1, "unexpected-plugin-entry");

  const symlinkExport = await createExport("symlink", { "src/target.txt": "target\n" });
  await symlink("target.txt", path.join(symlinkExport, "src", "link.txt"));
  assertResult(scanExport(symlinkExport), 1, "symlink");

  const proprietary = await createExport("proprietary", { "src/license.txt": ["LicenseRef", "Proprietary"].join("-") });
  assertResult(scanExport(proprietary), 1, "proprietary-license-marker");

  const absolutePath = ["", "Users", "example", "private.txt"].join("/");
  const absolute = await createExport("absolute", { "src/path.txt": `path=${absolutePath}\n` });
  assertResult(scanExport(absolute), 1, "absolute-local-user-path");

  const secretFilename = await createExport("secret-filename", { ".env.local": "PLACEHOLDER=true\n" });
  assertResult(scanExport(secretFilename), 1, "secret-filename");

  const token = ["ghp", "A".repeat(36)].join("_");
  const tokenExport = await createExport("token", { "src/token.txt": token });
  const tokenResult = scanExport(tokenExport);
  assertResult(tokenResult, 1, "high-confidence-access-token");
  if (tokenResult.stderr.includes(token)) throw new Error("token-like fixture was disclosed");

  const goodLicenses = path.join(temporaryRoot, "licenses-good");
  await mkdir(path.join(goodLicenses, "node_modules", "alpha"), { recursive: true });
  await writeFile(path.join(goodLicenses, "node_modules", "alpha", "package.json"), JSON.stringify({ name: "alpha", license: "MIT" }));
  await writeFile(path.join(goodLicenses, "package-lock.json"), lockfile({
    "": { dependencies: { alpha: "1.0.0", beta: "1.0.0" } },
    "node_modules/alpha": { version: "1.0.0" },
    "node_modules/beta": { version: "1.0.0", license: "BSD-3-Clause" },
  }));
  assertResult(run(licenseChecker, ["--root", goodLicenses]), 0);

  for (const [name, entry, expectedRule] of [
    ["missing", { version: "1.0.0" }, "missing-license-evidence"],
    ["restricted", { version: "1.0.0", license: "AGPL-3.0-only" }, "restricted-license"],
    ["unknown", { version: "1.0.0", license: "Made-Up-1.0" }, "unknown-license"],
  ]) {
    const directory = path.join(temporaryRoot, `licenses-${name}`);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "package-lock.json"), lockfile({
      "": { dependencies: { fixture: "1.0.0" } },
      "node_modules/fixture": entry,
    }));
    assertResult(run(licenseChecker, ["--root", directory]), 1, expectedRule);
  }

  process.stdout.write("OSS-GATE-SELF-TESTS: PASS (snapshot and dependency-license adversarial fixtures)\n");
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}