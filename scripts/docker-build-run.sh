#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTAINER_NAME="${ATLAS_CONTAINER_NAME:-atlas}"
IMAGE_NAME="${ATLAS_IMAGE_NAME:-atlas}"
HOST_PORT="${ATLAS_HOST_PORT:-4310}"
VOLUME_NAME="${ATLAS_DATA_VOLUME:-atlas-data}"

echo "Building ${IMAGE_NAME}..."
# buildx handles cross-platform builds; legacy `docker build` fails on Apple Silicon
# when forcing linux/amd64. Custom DOCKER_CONFIG disables the buildx CLI plugin.
# Build before stopping the running container so a failed build leaves the old service up.
if [[ "${IMAGE_NAME}" == "atlas" && "$#" -eq 0 ]]; then
  docker buildx build --load --platform=linux/amd64 -t atlas "${ROOT}"
else
  docker buildx build --load --platform=linux/amd64 -t "${IMAGE_NAME}" "$@" "${ROOT}"
fi

echo "Stopping ${CONTAINER_NAME}..."
docker rm -f "${CONTAINER_NAME}" 2>/dev/null || true

echo "Starting ${CONTAINER_NAME}..."
docker run -d \
  -p "${HOST_PORT}:4310" \
  -v "${VOLUME_NAME}:/atlas/data" \
  --name "${CONTAINER_NAME}" \
  "${IMAGE_NAME}"

for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null "http://localhost:${HOST_PORT}/" 2>/dev/null; then
    echo "Atlas is up: http://localhost:${HOST_PORT}"
    docker ps --filter "name=${CONTAINER_NAME}" --format '{{.Names}}\t{{.Status}}'
    exit 0
  fi
  sleep 1
done

echo "Container started but health check timed out. Check: docker logs ${CONTAINER_NAME}"
docker ps --filter "name=${CONTAINER_NAME}" --format '{{.Names}}\t{{.Status}}'
exit 1
