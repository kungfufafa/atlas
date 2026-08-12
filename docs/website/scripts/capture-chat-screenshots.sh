#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SCREENSHOT_DIR="$(cd "$(dirname "$0")/.." && pwd)/public/screenshots"
TEMP_CONFIG="/tmp/atlas-docs-chat-screenshots-$$"
COOKIE_JAR="/tmp/atlas-docs-chat-cookies-$$.txt"
PORT=4313
BASE_URL="http://127.0.0.1:${PORT}"
SESSION=atlas-docs-chat-screenshots
SERVER_PID=""
VIEWPORT_WIDTH=1280
VIEWPORT_HEIGHT=800

cleanup() {
  agent-browser --session "$SESSION" close --all 2>/dev/null || true
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$TEMP_CONFIG" "$COOKIE_JAR"
}
trap cleanup EXIT

mkdir -p "$SCREENSHOT_DIR" "$TEMP_CONFIG"

ATLAS_CONFIG_DIR="$TEMP_CONFIG" ATLAS_PORT="$PORT" \
  bun run "$ROOT/apps/server/src/index.ts" > /tmp/atlas-docs-chat-screenshot-server.log 2>&1 &
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
    \"organization\": {\"name\": \"Docs Demo\", \"slug\": \"docs-demo\"},
    \"admin\": {\"name\": \"Admin\", \"email\": \"admin@docs.demo\", \"password\": \"password123\"},
    \"webPublicUrl\": \"${BASE_URL}\"
  }" >/dev/null

CSRF_VAL=$(awk '$6=="atlas_csrf"{print $7}' "$COOKIE_JAR")
SESSION_VAL=$(awk '$6=="atlas_session"{print $7}' "$COOKIE_JAR")

curl -sf -b "$COOKIE_JAR" -X POST "${BASE_URL}/v1/providers" \
  -H 'Content-Type: application/json' \
  -H "X-CSRF-Token: ${CSRF_VAL}" \
  -d '{"type":"ollama","apiKey":"","hostMode":"local","model":"llama3.2"}' >/dev/null

agent-browser --session "$SESSION" close --all 2>/dev/null || true
agent-browser --session "$SESSION" cookies set atlas_session "$SESSION_VAL" \
  --url "${BASE_URL}/" --httpOnly --sameSite Lax
agent-browser --session "$SESSION" cookies set atlas_csrf "$CSRF_VAL" \
  --url "${BASE_URL}/" --sameSite Lax
agent-browser --session "$SESSION" open "${BASE_URL}/chat"
agent-browser --session "$SESSION" wait 3000
agent-browser --session "$SESSION" set viewport "$VIEWPORT_WIDTH" "$VIEWPORT_HEIGHT"

capture_theme() {
  local theme="$1"
  local output="$2"
  agent-browser --session "$SESSION" set media "$theme"
  agent-browser --session "$SESSION" wait 500
  agent-browser --session "$SESSION" screenshot "$output"
}

capture_theme dark "$SCREENSHOT_DIR/chat-dark.png"
capture_theme light "$SCREENSHOT_DIR/chat-light.png"

echo "Screenshots saved to $SCREENSHOT_DIR"
