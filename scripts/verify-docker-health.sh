#!/usr/bin/env bash
set -euo pipefail

image="${1:?Pass the production image tag or digest to verify.}"
container="atlas-startup-verification-$(date +%Y%m%d%H%M%S)-$$"
container_started=false
cleanup() {
  local status=$?
  if [[ "$status" -ne 0 ]]; then
    docker inspect "$container" --format 'Failed startup state: {{json .State}}' >&2 || true
    docker logs "$container" >&2 || true
  fi
  if [[ "$container_started" == true ]] || docker inspect "$container" >/dev/null 2>&1; then
    if ! docker rm --force "$container" >/dev/null; then
      echo "Failed to remove startup verification container: $container" >&2
      if [[ "$status" -eq 0 ]]; then
        status=1
      fi
    fi
  fi
  exit "$status"
}
trap cleanup EXIT

# Keep the image's real entrypoint and CMD. Fresh data and no network prevent
# configured provider/channel connections or use of host credentials.
docker run --detach --name "$container" --network none --read-only \
  --tmpfs /tmp:rw,exec,nosuid,size=512m \
  --tmpfs /atlas/data:rw,exec,nosuid,uid=1000,gid=1000,size=512m \
  "$image" >/dev/null
container_started=true
docker inspect "$container" --format 'Startup container: {{.Name}}; image: {{.Image}}; network: {{.HostConfig.NetworkMode}}; read-only: {{.HostConfig.ReadonlyRootfs}}; binds: {{json .HostConfig.Binds}}'
docker exec "$container" bun -e '
import { ATLAS_API_VERSION } from "./packages/core/src/contract.ts";
const deadline = Date.now() + 45000;
let health;
while (Date.now() < deadline) {
  try {
    const response = await fetch("http://127.0.0.1:4310/health", {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(Math.max(1, Math.min(1000, deadline - Date.now())))
    });
    const body = await response.text();
    const payload = JSON.parse(body);
    if (response.status === 200 && response.headers.get("content-type")?.includes("application/json") && payload?.ok === true && payload?.apiVersion === ATLAS_API_VERSION) {
      health = { status: response.status, body, apiVersion: payload.apiVersion };
      break;
    }
  } catch {}
  await Bun.sleep(Math.max(0, Math.min(250, deadline - Date.now())));
}
if (!health) throw new Error("Default entrypoint did not become healthy within 45 seconds");
const healthBody = health.body;
const index = await fetch("http://127.0.0.1:4310/", { signal: AbortSignal.timeout(5000) });
const indexBody = await index.text();
if (index.status !== 200 || !index.headers.get("content-type")?.includes("text/html") || !indexBody.includes("/assets/") || !indexBody.includes("<html")) {
  throw new Error("Default entrypoint did not serve the built web dashboard");
}
const hash = value => new Bun.CryptoHasher("sha256").update(value).digest("hex");
console.log(JSON.stringify({
  evidenceClass: "actual production image default-entrypoint HTTP startup",
  health: { status: health.status, apiVersion: health.apiVersion, bytes: Buffer.byteLength(healthBody), sha256: hash(healthBody) },
  index: { status: index.status, contentType: index.headers.get("content-type"), bytes: Buffer.byteLength(indexBody), sha256: hash(indexBody) },
  liveMessengers: "NOT_RUN",
  liveProvider: "NOT_RUN",
  status: "passed"
}));
'
docker stop --time 10 "$container" >/dev/null
