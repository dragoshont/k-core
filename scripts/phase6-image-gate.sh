#!/usr/bin/env bash
set -euo pipefail

image="${1:-k:phase6}"
source_label="${OCI_SOURCE:-https://github.com/dragoshont/k-core}"
revision_label="${OCI_REVISION:-phase6-candidate}"
version_label="${OCI_VERSION:-$(node -p 'require("./package.json").version')}"

docker buildx build \
  --platform linux/amd64 \
  --load \
  --build-arg "OCI_SOURCE=${source_label}" \
  --build-arg "OCI_REVISION=${revision_label}" \
  --build-arg "OCI_VERSION=${version_label}" \
  --build-arg OCI_LICENSES=Apache-2.0 \
  --tag "$image" \
  .

scripts/check-image-inventory.sh "$image"
scripts/container-smoke.sh "$image"

if command -v trivy >/dev/null 2>&1; then
  trivy image --scanners vuln,secret --severity HIGH,CRITICAL --exit-code 1 --no-progress "$image"
else
  echo "PHASE6-IMAGE: Trivy not installed (optional Phase 7 release evidence)"
fi

if command -v syft >/dev/null 2>&1; then
  syft "$image" -o syft-json >/dev/null
  echo "PHASE6-IMAGE: Syft inventory PASS"
else
  echo "PHASE6-IMAGE: Syft not installed (optional Phase 7 SBOM evidence)"
fi

printf 'PHASE6-IMAGE-GATE: PASS (%s, local build only, no push)\n' "$image"