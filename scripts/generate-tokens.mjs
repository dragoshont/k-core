import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const sourcePath = resolve("tokens/tokens.json");
const outputPath = resolve("src/ui/tokens.css");
const source = JSON.parse(await readFile(sourcePath, "utf8"));

function getPath(path) {
  return path.split(".").reduce((value, segment) => value?.[segment], source);
}

function resolveValue(value, seen = new Set()) {
  if (typeof value === "string") {
    const match = value.match(/^\{(.+)}$/);
    if (!match) return value;
    if (seen.has(match[1])) throw new Error(`Circular token reference: ${match[1]}`);
    const target = getPath(match[1]);
    if (!target || !("$value" in target)) throw new Error(`Unknown token reference: ${match[1]}`);
    return resolveValue(target.$value, new Set([...seen, match[1]]));
  }
  return value;
}

function cssValue(value) {
  const resolved = resolveValue(value);
  if (typeof resolved === "number") return String(resolved);
  if (typeof resolved === "string") return resolved;
  if (Array.isArray(resolved)) {
    if (resolved.length === 4 && resolved.every((item) => typeof item === "number")) {
      return `cubic-bezier(${resolved.join(", ")})`;
    }
    return resolved.map((item) => JSON.stringify(item)).join(", ");
  }
  if (resolved && typeof resolved === "object") {
    if (typeof resolved.hex === "string") return resolved.hex;
    if ("value" in resolved && "unit" in resolved) return `${resolved.value}${resolved.unit}`;
  }
  throw new Error(`Unsupported token value: ${JSON.stringify(resolved)}`);
}

function collect(node, path = [], output = []) {
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("$")) continue;
    if (value && typeof value === "object" && "$value" in value) {
      output.push([`--${[...path, key].join("-")}`, cssValue(value.$value)]);
      continue;
    }
    if (value && typeof value === "object") collect(value, [...path, key], output);
  }
  return output;
}

const declarations = collect(source)
  .map(([name, value]) => `  ${name}: ${value};`)
  .join("\n");
const css = `/* Generated from tokens/tokens.json. */\n:root {\n${declarations}\n}\n`;

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, css, "utf8");
console.log(`Generated ${outputPath}`);