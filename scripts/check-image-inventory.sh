#!/usr/bin/env bash
set -euo pipefail

image="${1:-k:phase6}"
root="$(mktemp -d)"
container="k-image-inventory-${RANDOM}"

cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  rm -rf "$root"
}
trap cleanup EXIT

node scripts/check-image-inventory.mjs --self-test

docker image inspect "$image" >"$root/config.json"
node - "$root/config.json" <<'NODE'
const fs = require("node:fs");
const images = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (!Array.isArray(images) || images.length !== 1) throw new Error("expected exactly one image config");
const config = images[0].Config ?? {};
if (config.User !== "10001:10001") throw new Error("image user must be 10001:10001");
if (!Array.isArray(config.Env) || !config.Env.includes("PUBLIC_PLUGIN_DIR=/app/plugins")) throw new Error("PUBLIC_PLUGIN_DIR is missing");
const labels = config.Labels ?? {};
for (const key of ["source", "revision", "version", "licenses"]) {
  const value = labels[`org.opencontainers.image.${key}`];
  if (typeof value !== "string" || value.length === 0) throw new Error(`OCI ${key} label is missing`);
}
if (labels["org.opencontainers.image.licenses"] !== "Apache-2.0") throw new Error("OCI license label is invalid");
const source = new URL(labels["org.opencontainers.image.source"]);
if (source.protocol !== "https:") throw new Error("OCI source label must use HTTPS");
console.log("IMAGE-INVENTORY: config PASS (uid 10001, public plugin root, OCI labels)");
NODE

docker create --platform linux/amd64 --name "$container" "$image" >/dev/null
docker export -o "$root/rootfs.tar" "$container"
node scripts/check-image-inventory.mjs --rootfs "$root/rootfs.tar"

docker save -o "$root/image.tar" "$image"
mkdir "$root/saved"
tar -xf "$root/image.tar" -C "$root/saved"
node scripts/check-image-inventory.mjs --layers "$root/saved"

mkdir -p "$root/context/plugins/private-sentinel"
mkdir -p "$root/context/plugins/project-gutenberg"
cp .dockerignore "$root/context/.dockerignore"
printf '%s\n' 'FROM scratch' 'COPY plugins/project-gutenberg/marker /marker' >"$root/context/Dockerfile.control"
printf '%s\n' 'FROM scratch' 'COPY plugins/private-sentinel/marker /marker' >"$root/context/Dockerfile.private"
printf '%s\n' 'non-secret marker' >"$root/context/plugins/project-gutenberg/marker"
printf '%s\n' 'non-secret marker' >"$root/context/plugins/private-sentinel/marker"
docker build --no-cache -f "$root/context/Dockerfile.control" "$root/context" >"$root/context-control.log" 2>&1
if docker build --no-cache -f "$root/context/Dockerfile.private" "$root/context" >"$root/context-private.log" 2>&1; then
  echo "IMAGE-INVENTORY: FAIL" >&2
  echo "private-plugin-like context sentinel was not excluded" >&2
  exit 1
fi

printf 'IMAGE-INVENTORY: PASS (config, final filesystem, all saved layers, context allowlist control, private sentinel excluded)\n'