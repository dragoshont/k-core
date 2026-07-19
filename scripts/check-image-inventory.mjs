#!/usr/bin/env node

import { createReadStream, createWriteStream } from "node:fs";
import { open, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

const EXPECTED_ENTRIES = new Map([
  ["google-books", "5"],
  ["google-gmail", "5"],
  ["internet-archive", "5"],
  ["lib", "5"],
  ["login-with-amazon", "5"],
  ["project-gutenberg", "5"],
  ["public-inventory.json", "0"],
  ["standard-ebooks", "5"],
]);

function fail(message) {
  throw new Error(message);
}

function fieldString(header, offset, length) {
  const field = header.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return field.subarray(0, end < 0 ? field.length : end).toString("utf8").trim();
}

function tarNumber(header, offset, length) {
  const field = header.subarray(offset, offset + length);
  if ((field[0] & 0x80) !== 0) {
    let value = BigInt(field[0] & 0x7f);
    for (const byte of field.subarray(1)) value = (value << 8n) | BigInt(byte);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail("tar numeric field is too large");
    return Number(value);
  }
  const text = field.toString("ascii").replace(/\0.*$/u, "").trim();
  if (!text) return 0;
  if (!/^[0-7]+$/u.test(text)) fail("tar numeric field is invalid");
  return Number.parseInt(text, 8);
}

function verifyChecksum(header) {
  const expected = tarNumber(header, 148, 8);
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 32 : header[index];
  }
  if (actual !== expected) fail("tar header checksum is invalid");
}

function parsePax(payload) {
  const values = {};
  let offset = 0;
  while (offset < payload.length) {
    const space = payload.indexOf(32, offset);
    if (space < 0) fail("PAX record length is invalid");
    const lengthText = payload.subarray(offset, space).toString("ascii");
    if (!/^[1-9][0-9]*$/u.test(lengthText)) fail("PAX record length is invalid");
    const length = Number.parseInt(lengthText, 10);
    const end = offset + length;
    if (!Number.isSafeInteger(length) || end > payload.length || payload[end - 1] !== 10) fail("PAX record is truncated");
    const record = payload.subarray(space + 1, end - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals <= 0) fail("PAX record is invalid");
    values[record.slice(0, equals)] = record.slice(equals + 1);
    offset = end;
  }
  return values;
}

async function readAt(handle, length, position) {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
    if (bytesRead === 0) fail("tar archive is truncated");
    offset += bytesRead;
  }
  return buffer;
}

function normalizedTarPath(rawPath) {
  if (typeof rawPath !== "string" || rawPath.includes("\\") || rawPath.includes("\0")) fail("tar path is invalid");
  let value = rawPath.replace(/^\/+|\/+$/gu, "");
  while (value.startsWith("./")) value = value.slice(2);
  if (!value || value === ".") return "";
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) fail("tar path escapes or is ambiguous");
  return parts.join("/");
}

async function readPlainTarEntries(filePath) {
  const handle = await open(filePath, "r");
  try {
    const stat = await handle.stat();
    const entries = [];
    let position = 0;
    let globalPax = {};
    let nextPax = {};
    let longPath;
    let longLink;
    while (position + 512 <= stat.size) {
      const header = await readAt(handle, 512, position);
      if (header.every((byte) => byte === 0)) break;
      verifyChecksum(header);
      const size = tarNumber(header, 124, 12);
      const type = String.fromCharCode(header[156] || 48);
      const name = fieldString(header, 0, 100);
      const prefix = fieldString(header, 345, 155);
      const headerPath = prefix ? `${prefix}/${name}` : name;
      const linkName = fieldString(header, 157, 100);
      const payloadPosition = position + 512;
      if (payloadPosition + size > stat.size) fail("tar entry payload is truncated");

      if (type === "x" || type === "g" || type === "L" || type === "K") {
        if (size > 1024 * 1024) fail("tar extension record is too large");
        const payload = await readAt(handle, size, payloadPosition);
        if (type === "x") nextPax = { ...nextPax, ...parsePax(payload) };
        if (type === "g") globalPax = { ...globalPax, ...parsePax(payload) };
        if (type === "L") longPath = payload.toString("utf8").replace(/[\0\n]+$/gu, "");
        if (type === "K") longLink = payload.toString("utf8").replace(/[\0\n]+$/gu, "");
      } else {
        const attributes = { ...globalPax, ...nextPax };
        const entryPath = normalizedTarPath(attributes.path ?? longPath ?? headerPath);
        const entryLink = attributes.linkpath ?? longLink ?? linkName;
        entries.push({
          link: entryLink,
          path: entryPath,
          type,
        });
        nextPax = {};
        longPath = undefined;
        longLink = undefined;
      }
      position = payloadPosition + Math.ceil(size / 512) * 512;
    }
    return entries;
  } finally {
    await handle.close();
  }
}

async function readTarEntries(filePath) {
  const handle = await open(filePath, "r");
  let magic;
  try {
    magic = await readAt(handle, 2, 0);
  } finally {
    await handle.close();
  }
  if (magic[0] !== 0x1f || magic[1] !== 0x8b) {
    return readPlainTarEntries(filePath);
  }

  const directory = await mkdtemp(path.join(tmpdir(), "k-image-layer-"));
  const tarPath = path.join(directory, "layer.tar");
  try {
    await pipeline(createReadStream(filePath), createGunzip(), createWriteStream(tarPath, { flags: "wx", mode: 0o600 }));
    const metadata = await open(tarPath, "r");
    try {
      const stat = await metadata.stat();
      if (stat.size > 2 * 1024 * 1024 * 1024) fail("decompressed image layer is too large");
    } finally {
      await metadata.close();
    }
    return await readPlainTarEntries(tarPath);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

function inspectPluginEntries(entries, mode, label) {
  const topEntries = new Map();
  let sawRoot = false;
  for (const entry of entries) {
    if (entry.path === "app/plugins") {
      sawRoot = true;
      if (entry.type !== "5") fail(`${label}: plugin root is not a directory`);
      continue;
    }
    if (!entry.path.startsWith("app/plugins/")) continue;
    const relativePath = entry.path.slice("app/plugins/".length);
    const parts = relativePath.split("/");
    const topEntry = parts[0];
    if (!EXPECTED_ENTRIES.has(topEntry)) fail(`${label}: unexpected plugin entry`);
    if (parts.some((part) => part.startsWith(".wh."))) fail(`${label}: plugin whiteout is forbidden`);
    if (entry.type !== "0" && entry.type !== "5") fail(`${label}: plugin symlink, hardlink, or special file is forbidden`);
    if (parts.length === 1) {
      const expectedType = EXPECTED_ENTRIES.get(topEntry);
      if (entry.type !== expectedType) fail(`${label}: plugin entry has the wrong file type`);
      topEntries.set(topEntry, entry.type);
    }
  }

  if (mode === "rootfs") {
    if (!sawRoot) fail(`${label}: plugin root is missing`);
    const actual = [...topEntries.keys()].sort();
    const expected = [...EXPECTED_ENTRIES.keys()].sort();
    if (actual.join("\n") !== expected.join("\n")) fail(`${label}: final plugin inventory is incomplete or unexpected`);
  }
}

function safeChild(root, relativePath) {
  if (typeof relativePath !== "string" || relativePath.startsWith("/") || relativePath.includes("\\")) fail("saved image layer path is invalid");
  const resolved = path.resolve(root, relativePath);
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) fail("saved image layer path escapes export root");
  return resolved;
}

async function checkRootfs(filePath) {
  const entries = await readTarEntries(filePath);
  inspectPluginEntries(entries, "rootfs", "final filesystem");
  process.stdout.write(`IMAGE-INVENTORY: final filesystem PASS (${EXPECTED_ENTRIES.size} exact plugin entries)\n`);
}

async function checkLayers(directory) {
  const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
  if (!Array.isArray(manifest) || manifest.length !== 1 || !Array.isArray(manifest[0]?.Layers) || manifest[0].Layers.length === 0) {
    fail("saved image manifest must describe exactly one image with layers");
  }
  let pluginLayerCount = 0;
  for (const [index, relativePath] of manifest[0].Layers.entries()) {
    const entries = await readTarEntries(safeChild(directory, relativePath));
    if (entries.some((entry) => entry.path === "app/plugins" || entry.path.startsWith("app/plugins/"))) pluginLayerCount += 1;
    inspectPluginEntries(entries, "layer", `layer ${index + 1}`);
  }
  if (pluginLayerCount === 0) fail("saved image layers contain no plugin payload");
  process.stdout.write(`IMAGE-INVENTORY: layers PASS (${manifest[0].Layers.length} layers, ${pluginLayerCount} plugin layers)\n`);
}

function writeOctal(header, offset, length, value) {
  const text = value.toString(8).padStart(length - 1, "0");
  header.write(text, offset, length - 1, "ascii");
  header[offset + length - 1] = 0;
}

function tarArchive(entries) {
  const blocks = [];
  for (const entry of entries) {
    const payload = Buffer.from(entry.content ?? "", "utf8");
    const header = Buffer.alloc(512);
    header.write(entry.path, 0, 100, "utf8");
    writeOctal(header, 100, 8, entry.type === "5" ? 0o755 : 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, payload.length);
    writeOctal(header, 136, 12, 0);
    header.fill(32, 148, 156);
    header[156] = (entry.type ?? "0").charCodeAt(0);
    if (entry.link) header.write(entry.link, 157, 100, "utf8");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    let checksum = 0;
    for (const byte of header) checksum += byte;
    const checksumText = checksum.toString(8).padStart(6, "0");
    header.write(checksumText, 148, 6, "ascii");
    header[154] = 0;
    header[155] = 32;
    blocks.push(header, payload, Buffer.alloc((512 - (payload.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

async function selfTest() {
  const root = await mkdtemp(path.join(tmpdir(), "k-image-inventory-"));
  try {
    const validEntries = [{ path: "app/plugins", type: "5" }];
    for (const [name, type] of EXPECTED_ENTRIES) {
      validEntries.push({ path: `app/plugins/${name}`, type, content: type === "0" ? "{}" : "" });
    }
    validEntries.push({ path: "app/plugins/project-gutenberg/plugin.json", type: "0", content: "{}" });
    const validPath = path.join(root, "valid.tar");
    await writeFile(validPath, tarArchive(validEntries));
    inspectPluginEntries(await readTarEntries(validPath), "rootfs", "self-test valid");

    const cases = [
      ["unexpected", { path: "app/plugins/operator-only/plugin.json", type: "0", content: "{}" }],
      ["symlink", { path: "app/plugins/project-gutenberg/link", type: "2", link: "plugin.json" }],
      ["whiteout", { path: "app/plugins/project-gutenberg/.wh.hidden", type: "0" }],
      ["escape", { path: "app/plugins/project-gutenberg/../hidden", type: "0" }],
    ];
    for (const [name, entry] of cases) {
      const filePath = path.join(root, `${name}.tar`);
      await writeFile(filePath, tarArchive([entry]));
      let rejected = false;
      try {
        inspectPluginEntries(await readTarEntries(filePath), "layer", `self-test ${name}`);
      } catch {
        rejected = true;
      }
      if (!rejected) fail(`self-test did not reject ${name}`);
    }

    const saveDirectory = path.join(root, "saved");
    await mkdir(path.join(saveDirectory, "blobs"), { recursive: true });
    await writeFile(path.join(saveDirectory, "blobs", "valid-layer.tar"), tarArchive(validEntries));
    await writeFile(path.join(saveDirectory, "manifest.json"), JSON.stringify([{ Config: "config.json", Layers: ["blobs/valid-layer.tar"], RepoTags: ["fixture:latest"] }]));
    await checkLayers(saveDirectory);
    process.stdout.write("IMAGE-INVENTORY-SELF-TESTS: PASS (tar, unexpected entry, symlink, whiteout, path escape)\n");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

async function main() {
  const [mode, value, ...rest] = process.argv.slice(2);
  if (rest.length > 0) fail("unexpected arguments");
  if (mode === "--rootfs" && value) return checkRootfs(path.resolve(value));
  if (mode === "--layers" && value) return checkLayers(path.resolve(value));
  if (mode === "--self-test" && value === undefined) return selfTest();
  fail("usage: check-image-inventory.mjs --rootfs <tar> | --layers <saved-image-directory> | --self-test");
}

main().catch((error) => {
  process.stderr.write(`IMAGE-INVENTORY: FAIL\n${error instanceof Error ? error.message : "unexpected inventory failure"}\n`);
  process.exitCode = 1;
});