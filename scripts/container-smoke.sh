#!/usr/bin/env bash
set -euo pipefail

image="${1:-k:phase6}"
network="k-browser-smoke-${RANDOM}"
root="$(mktemp -d)"
postgres_image="postgres:16.13-alpine@sha256:4e6e670bb069649261c9c18031f0aded7bb249a5b6664ddec29c013a89310d50"

cleanup() {
  docker ps -aq --filter "name=^/${network}-" | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  rm -rf "$root"
}
trap cleanup EXIT

random_hex() {
  node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))'
}

postgres_password="$(random_hex)"
pin_pepper="$(random_hex)"
pin_reuse_secret="$(random_hex)"
session_signing_key="$(random_hex)"
source_hash_secret="$(random_hex)"

cat >"$root/custom-profiles.json" <<'JSON'
{
  "schemaVersion": 1,
  "profiles": [
    { "profileId": "00000000-0000-4000-8000-000000000001", "slug": "reader-one", "displayName": "Reader One" },
    { "profileId": "00000000-0000-4000-8000-000000000002", "slug": "reader-two", "displayName": "Reader Two" },
    { "profileId": "00000000-0000-4000-8000-000000000003", "slug": "reader-three", "displayName": "Reader Three" }
  ]
}
JSON
chmod 0444 "$root/custom-profiles.json"

docker network create "$network" >/dev/null
proxy_cidr="$(docker network inspect "$network" --format '{{(index .IPAM.Config 0).Subnet}}')"

run_case() {
  local case_name="$1" profile_file="$2" expected_names="$3" expected_rows="$4"
  local database="${network}-${case_name}-db" web="${network}-${case_name}-web"
  local host_port ready html api uid readonly schema_version database_rows
  local profile_args=()

  if [[ -n "$profile_file" ]]; then
    profile_args=(--mount "type=bind,source=${profile_file},target=/run/config/profiles.json,readonly" -e PROFILE_CONFIG_FILE=/run/config/profiles.json)
  fi

  docker run -d --rm \
    --name "$database" \
    --network "$network" \
    -e POSTGRES_DB=k \
    -e POSTGRES_USER=k \
    -e POSTGRES_PASSWORD="$postgres_password" \
    --tmpfs /var/lib/postgresql/data:rw,noexec,nosuid,size=256m \
    "$postgres_image" >/dev/null

  for attempt in $(seq 1 60); do
    if docker exec "$database" pg_isready -U k -d k >/dev/null 2>&1; then break; fi
    if [[ "$attempt" == 60 ]]; then
      echo "PostgreSQL did not become ready for ${case_name}" >&2
      exit 1
    fi
    sleep 0.25
  done

  local common_env=(
    --network "$network"
    -e "DATABASE_URL=postgres://k:${postgres_password}@${database}:5432/k"
    -e PUBLIC_ORIGIN=https://k.example.invalid
    -e "TRUSTED_PROXY_CIDRS=${proxy_cidr}"
    -e ALLOWED_PRIVATE_CLIENT_CIDRS=10.0.0.0/8
    -e OUTBOUND_CONTACT=container-smoke@example.invalid
    -e "PIN_PEPPER=${pin_pepper}"
    -e "PIN_REUSE_SECRET=${pin_reuse_secret}"
    -e "SESSION_SIGNING_KEY=${session_signing_key}"
    -e "SOURCE_HASH_SECRET=${source_hash_secret}"
    -e PORT=3000
    -e PUBLIC_PLUGIN_DIR=/app/plugins
    -e QUARANTINE_DIR=/tmp/quarantine
  )

  docker run --rm --platform linux/amd64 \
    "${common_env[@]}" ${profile_args[@]+"${profile_args[@]}"} \
    --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m \
    "$image" node build/server/bin/migrate.js

  schema_version="$(docker exec "$database" psql -U k -d k -Atqc 'select coalesce(max(version), 0) from schema_migrations')"
  database_rows="$(docker exec "$database" psql -U k -d k -At -F '|' -c 'select slug, display_name from profiles order by profile_id')"
  [[ "$schema_version" == "7" ]]
  [[ "$database_rows" == "$expected_rows" ]]

  docker run -d --rm --platform linux/amd64 \
    --name "$web" \
    "${common_env[@]}" ${profile_args[@]+"${profile_args[@]}"} \
    --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m \
    -p 127.0.0.1::3000 \
    "$image" >/dev/null

  host_port="$(docker port "$web" 3000/tcp | sed -E 's/.*:([0-9]+)$/\1/')"
  for attempt in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:${host_port}/healthz" >/dev/null 2>&1; then break; fi
    if [[ "$attempt" == 60 ]]; then
      docker logs "$web" >&2
      exit 1
    fi
    sleep 0.25
  done

  local headers=(-H 'X-Forwarded-For: 10.0.0.50' -H 'X-Forwarded-Host: k.example.invalid' -H 'X-Forwarded-Proto: https')
  ready="$(curl -fsS "http://127.0.0.1:${host_port}/readyz")"
  html="$(curl -fsS "${headers[@]}" "http://127.0.0.1:${host_port}/unlock")"
  api="$(curl -fsS "${headers[@]}" "http://127.0.0.1:${host_port}/api/v1/auth/profiles")"
  uid="$(docker exec "$web" id -u)"
  readonly="$(docker inspect "$web" --format '{{.HostConfig.ReadonlyRootfs}}')"

  [[ "$ready" == "ready" ]]
  [[ "$uid" == "10001" ]]
  [[ "$readonly" == "true" ]]
  IFS='|' read -r -a names <<<"$expected_names"
  for name in "${names[@]}"; do [[ "$html" == *"$name"* ]]; done
  EXPECTED_NAMES="$expected_names" node -e '
    const expected = process.env.EXPECTED_NAMES.split("|");
    let source = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => source += chunk);
    process.stdin.on("end", () => {
      const body = JSON.parse(source);
      const names = body.profiles.map((profile) => profile.displayName);
      const ids = body.profiles.map((profile) => profile.profileId);
      const expectedIds = [1, 2, 3].map((slot) => `00000000-0000-4000-8000-${String(slot).padStart(12, "0")}`);
      if (JSON.stringify(names) !== JSON.stringify(expected) || JSON.stringify(ids) !== JSON.stringify(expectedIds)) process.exit(1);
    });
  ' <<<"$api"

  docker rm -f "$web" "$database" >/dev/null
  printf 'IMAGE-SMOKE: %s PASS (migration 0007, parity, SSR/API, uid=%s, read-only)\n' "$case_name" "$uid"
}

run_case neutral "" 'Member 1|Member 2|Member 3' $'member-1|Member 1\nmember-2|Member 2\nmember-3|Member 3'
run_case custom "$root/custom-profiles.json" 'Reader One|Reader Two|Reader Three' $'reader-one|Reader One\nreader-two|Reader Two\nreader-three|Reader Three'

printf 'IMAGE-SMOKE: PASS (neutral and custom profiles use isolated databases)\n'
