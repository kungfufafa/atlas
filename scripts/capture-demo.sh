#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT="$ROOT/assets/atlas_demo.png"
TEMP_CONFIG="/tmp/atlas-demo-screenshot-$$"
COOKIE_JAR="/tmp/atlas-demo-cookies-$$.txt"
PORT=4319
BASE_URL="http://127.0.0.1:${PORT}"
SESSION=atlas-demo-screenshot
SERVER_PID=""
VIEWPORT_WIDTH=1440
VIEWPORT_HEIGHT=900
if command -v agent-browser >/dev/null 2>&1; then
  AB="$(command -v agent-browser)"
elif [[ -x "${HOME}/Library/pnpm/nodejs/22.23.1/bin/agent-browser" ]]; then
  AB="${HOME}/Library/pnpm/nodejs/22.23.1/bin/agent-browser"
else
  AB="agent-browser"
fi

cleanup() {
  "$AB" --session "$SESSION" close --all 2>/dev/null || true
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$TEMP_CONFIG" "$COOKIE_JAR"
}
trap cleanup EXIT

mkdir -p "$TEMP_CONFIG"

echo "Building latest web UI..."
bun run --filter @atlas/web build

ATLAS_CONFIG_DIR="$TEMP_CONFIG" ATLAS_PORT="$PORT" \
  bun run "$ROOT/apps/server/src/index.ts" > /tmp/atlas-demo-server.log 2>&1 &
SERVER_PID=$!

for _ in $(seq 1 60); do
  if curl -sf "${BASE_URL}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done

curl -sf "${BASE_URL}/health" >/dev/null

curl -sf -c "$COOKIE_JAR" -X POST "${BASE_URL}/v1/auth/setup" \
  -H 'Content-Type: application/json' \
  -d "{
    \"organization\": {\"name\": \"Orbito Creative\", \"slug\": \"orbito-creative\"},
    \"admin\": {\"name\": \"Ahmad Rosid\", \"email\": \"admin@orbito.demo\", \"password\": \"password123\"},
    \"webPublicUrl\": \"${BASE_URL}\"
  }" >/dev/null

CSRF_VAL=$(awk '$6=="atlas_csrf"{print $7}' "$COOKIE_JAR")
SESSION_VAL=$(awk '$6=="atlas_session"{print $7}' "$COOKIE_JAR")

# Configure an Ollama provider so the chat page is fully rendered.
curl -sf -b "$COOKIE_JAR" -X POST "${BASE_URL}/v1/providers" \
  -H 'Content-Type: application/json' \
  -H "X-CSRF-Token: ${CSRF_VAL}" \
  -d '{"type":"ollama","apiKey":"","hostMode":"local","model":"llama3.2"}' >/dev/null

# Seed one extra profile so the new profile rail shows a small set (default + super_agent + 1).
curl -sf -b "$COOKIE_JAR" -X POST "${BASE_URL}/v1/profiles" \
  -H 'Content-Type: application/json' \
  -H "X-CSRF-Token: ${CSRF_VAL}" \
  -d '{"name":"Gary Vee"}' >/dev/null

"$AB" --session "$SESSION" close --all 2>/dev/null || true
"$AB" --session "$SESSION" cookies set atlas_session "$SESSION_VAL" \
  --url "${BASE_URL}/" --httpOnly --sameSite Lax
"$AB" --session "$SESSION" cookies set atlas_csrf "$CSRF_VAL" \
  --url "${BASE_URL}/" --sameSite Lax
"$AB" --session "$SESSION" set viewport "$VIEWPORT_WIDTH" "$VIEWPORT_HEIGHT"
"$AB" --session "$SESSION" set media dark
"$AB" --session "$SESSION" open "${BASE_URL}/chat"
"$AB" --session "$SESSION" wait 2000
"$AB" --session "$SESSION" storage local set atlas-sidebar-collapsed false
"$AB" --session "$SESSION" open "${BASE_URL}/chat"
"$AB" --session "$SESSION" wait 3500
"$AB" --session "$SESSION" screenshot "$OUTPUT"

echo "Demo screenshot saved to $OUTPUT"
