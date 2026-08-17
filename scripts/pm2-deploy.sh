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
echo "Atlas is up: http://0.0.0.0:${PORT}"
echo "Open that URL and complete the setup wizard if this is a fresh install."
echo "Keep it running after reboot: bun x pm2 save && bun x pm2 startup"
