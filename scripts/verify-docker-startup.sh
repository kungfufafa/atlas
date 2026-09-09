#!/usr/bin/env bash
# Verify a built image with fresh, disposable data. Never uses an existing Atlas
# container, host port, bind mount, provider credential, or persistent data volume.
# Usage: ./scripts/verify-docker-startup.sh [image-tag]
# Optional: ATLAS_DOCKER_PLATFORM=linux/amd64 ATLAS_DOCKER_STARTUP_TIMEOUT=120
set -euo pipefail

IMAGE="${1:-atlas}"
STARTUP_TIMEOUT="${ATLAS_DOCKER_STARTUP_TIMEOUT:-120}"
CONTAINER_ID=""
RUN_ARGS=(--detach)

if [[ ! "${STARTUP_TIMEOUT}" =~ ^[1-9][0-9]{0,2}$ ]] || (( STARTUP_TIMEOUT > 900 )); then
  echo "ATLAS_DOCKER_STARTUP_TIMEOUT must be an integer from 1 to 900 seconds." >&2
  exit 1
fi
if [[ -n "${ATLAS_DOCKER_PLATFORM:-}" ]]; then
  RUN_ARGS+=(--platform "${ATLAS_DOCKER_PLATFORM}")
fi
if ! docker info >/dev/null 2>&1; then
  echo "Docker daemon is unavailable; startup smoke did not run." >&2
  exit 1
fi
if ! docker image inspect "${IMAGE}" >/dev/null 2>&1; then
  echo "Docker image '${IMAGE}' is unavailable. Build or pull it before running this check." >&2
  exit 1
fi

cleanup() {
  local result=$?
  trap - EXIT
  if [[ -n "${CONTAINER_ID}" ]]; then
    if (( result != 0 )); then
      docker inspect --format '{{json .State}}' "${CONTAINER_ID}" >&2 || true
      docker logs --tail 100 "${CONTAINER_ID}" >&2 || true
    fi
    if ! docker rm --force --volumes "${CONTAINER_ID}" >/dev/null; then
      echo "Could not remove smoke container ${CONTAINER_ID}." >&2
      if (( result == 0 )); then
        result=1
      fi
    fi
  fi
  exit "${result}"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "Starting isolated Docker smoke for ${IMAGE}..."
CONTAINER_ID="$(docker run "${RUN_ARGS[@]}" \
  --network none \
  --tmpfs /atlas/data:rw,uid=1000,gid=1000,mode=0700 \
  --health-interval=2s --health-timeout=3s --health-start-period=5s --health-retries=30 \
  "${IMAGE}")"

deadline=$((SECONDS + STARTUP_TIMEOUT))
while true; do
  state="$(docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "${CONTAINER_ID}")"
  if [[ "${state}" == "running healthy" ]]; then
    break
  fi
  if [[ "${state}" != "running starting" ]] || (( SECONDS >= deadline )); then
    echo "Docker startup did not become healthy within ${STARTUP_TIMEOUT}s (state: ${state})." >&2
    exit 1
  fi
  sleep 1
done
echo "Docker health check passed. Checking dashboard and first-run authentication..."

# Run the requests inside this container so no host port or host HTTP client is
# needed. A real session exercises SQLite writes and the tenant middleware.
docker exec --interactive "${CONTAINER_ID}" bun --eval "$(cat <<'JS'
import assert from "node:assert/strict";

const baseUrl = "http://127.0.0.1:4310";
const request = async (path, status = 200, options = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, status, `${options.method ?? "GET"} ${path}`);
  return response;
};
const post = (body, headers = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});
const sessionHeaders = (response) => {
  const cookies = response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]);
  assert(cookies.some((cookie) => cookie.startsWith("atlas_session=")), "Session cookie missing");
  const csrf = cookies.find((cookie) => cookie.startsWith("atlas_csrf="));
  assert(csrf, "CSRF cookie missing");
  return { cookie: cookies.join("; "), "x-csrf-token": csrf.slice("atlas_csrf=".length) };
};

const health = await (await request("/health")).json();
assert.equal(health.ok, true);
assert.equal(health.userConfigured, false, "Smoke must start with an empty database");
assert.equal(health.providerConfigured, false, "Smoke must not inherit provider credentials");
const dashboard = await request("/");
assert(dashboard.headers.get("content-type")?.includes("text/html"), "Dashboard HTML missing");
const html = await dashboard.text();
const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)].map((match) => match[1]);
assert(assets.some((asset) => asset.endsWith(".js")), "Built dashboard JavaScript missing");
for (const asset of new Set(assets)) {
  const response = await request(asset);
  assert(!response.headers.get("content-type")?.includes("text/html"), `Asset returned HTML: ${asset}`);
  assert((await response.arrayBuffer()).byteLength > 0, `Empty dashboard asset: ${asset}`);
}
await request("/v1/auth/me", 401);
await request("/v1/profiles", 401);

const credentials = { email: "docker-smoke@example.invalid", password: crypto.randomUUID() };
const setup = {
  admin: { ...credentials, name: "Docker Smoke" },
  organization: { name: "Docker Smoke", slug: "docker-smoke" },
};
const created = await request("/v1/auth/setup", 201, post(setup));
const createdUser = await created.json();
assert.equal(createdUser.email, credentials.email);
assert.equal(createdUser.isPlatformAdmin, true);
assert.equal(typeof createdUser.activeOrgId, "string");
assert(createdUser.activeOrgId.length > 0, "Setup did not select an organization");
const headers = sessionHeaders(created);
const me = await (await request("/v1/auth/me", 200, { headers })).json();
assert.equal(me.email, credentials.email);
assert.equal(me.activeOrgId, createdUser.activeOrgId);
const profiles = await (await request("/v1/profiles", 200, {
  headers: { ...headers, "X-Org-Id": createdUser.activeOrgId },
})).json();
assert(Array.isArray(profiles.profiles), "Authenticated profiles response missing");
await request("/v1/auth/setup", 409, post(setup));
await request("/v1/auth/logout", 200, post({}, headers));
await request("/v1/auth/me", 401, { headers });
const loggedIn = await request("/v1/auth/login", 200, post(credentials));
const restored = await (await request("/v1/auth/me", 200, { headers: sessionHeaders(loggedIn) })).json();
assert.equal(restored.email, credentials.email);
assert.equal((await (await request("/health")).json()).userConfigured, true);
console.log("Dashboard assets, anonymous access guards, setup, organization access, logout and login passed.");
JS
)"

state="$(docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "${CONTAINER_ID}")"
if [[ "${state}" != "running healthy" ]]; then
  echo "Container stopped being healthy after the smoke (state: ${state})." >&2
  exit 1
fi
echo "Docker startup smoke passed for ${IMAGE}."
