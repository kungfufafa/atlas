#!/usr/bin/env bash
set -euo pipefail

docker rm -f atlas 2>/dev/null || true

while IFS= read -r id; do
  docker rm -f "$id" 2>/dev/null || true
done < <(docker ps -aq --filter publish=4310 2>/dev/null || true)

docker volume rm atlas-data atlas-config 2>/dev/null || true
docker image rm atlas 2>/dev/null || true

echo "Destroy complete."
