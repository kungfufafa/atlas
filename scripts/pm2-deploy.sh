#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

if ! command -v bun >/dev/null 2>&1; then
  echo "Bun is required. Install it from https://bun.sh then retry."
  exit 1
fi

echo "Installing dependencies..."
bun install

echo "Checking LibreOffice for Office artifact previews..."
if ! bash "${ROOT}/scripts/ensure-office-converter.sh"; then
  echo "Continuing without LibreOffice. PPTX/DOCX/XLSX thumbnails will be unavailable until soffice is installed."
fi

echo "Building the dashboard..."
bun run --filter @atlas/web build

echo "Starting Atlas with PM2..."
bun x pm2 startOrReload "${ROOT}/ecosystem.config.cjs" --only atlas --update-env

PORT="${ATLAS_PORT:-4310}"
ASSET="$(find "${ROOT}/apps/web/dist/assets" -name 'index-*.js' -print -quit || true)"
if [[ -z "${ASSET}" ]]; then
  echo "Dashboard JS bundle not found in apps/web/dist/assets."
  exit 1
fi

ASSET_PATH="/assets/$(basename "${ASSET}")"
echo "Waiting for Atlas to serve ${ASSET_PATH} with gzip..."
READY=0
for _ in {1..30}; do
  if curl -sf "http://127.0.0.1:${PORT}/health" >/dev/null; then
    READY=1
    break
  fi
  sleep 1
done
if [[ "${READY}" -ne 1 ]]; then
  echo "Atlas did not become healthy on port ${PORT}."
  exit 1
fi

HEADERS="$(curl -sSI -H 'Accept-Encoding: gzip' "http://127.0.0.1:${PORT}${ASSET_PATH}")"
if ! printf '%s\n' "${HEADERS}" | grep -qi 'content-encoding:[[:space:]]*gzip'; then
  echo "Dashboard JS is not Content-Encoding: gzip. Restart Atlas after rebuilding the web app."
  printf '%s\n' "${HEADERS}"
  exit 1
fi

echo "Atlas is up: http://0.0.0.0:${PORT}"
echo "Open that URL and complete the setup wizard if this is a fresh install."
echo "Keep it running after reboot: bun x pm2 save && bun x pm2 startup"
