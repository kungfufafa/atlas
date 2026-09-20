#!/usr/bin/env bash
set -euo pipefail

repository="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if ! docker info >/dev/null 2>&1; then
  printf 'BLOCKED: Docker daemon unavailable; image build and container checks were not run.\n' >&2
  exit 2
fi

docker info --format 'Docker server: {{.ServerVersion}}; OS: {{.OperatingSystem}}; kernel: {{.KernelVersion}}; architecture: {{.Architecture}}'
printf 'Requested image platform: %s\n' "${ATLAS_DOCKER_VERIFY_PLATFORM:-linux/amd64}"
image="atlas-file-verification:$(date +%Y%m%d%H%M%S)-$$"
docker buildx build --load --platform="${ATLAS_DOCKER_VERIFY_PLATFORM:-linux/amd64}" \
  --tag "$image" "$@" "$repository"
docker image inspect "$image" --format 'Built image: {{.Id}}; platform: {{.Os}}/{{.Architecture}}; size: {{.Size}} bytes; repository digests: {{json .RepoDigests}}'
bash "$repository/scripts/verify-linux-landlock.sh" "$image"
docker run --rm --network none --read-only \
  --tmpfs /tmp:rw,exec,nosuid,size=512m \
  --tmpfs /atlas/data:rw,exec,nosuid,uid=1000,gid=1000,size=512m \
  "$image" bun run scripts/file-runtime/container-check.ts
docker run --rm --network none --read-only \
  --tmpfs /tmp:rw,exec,nosuid,size=512m \
  --tmpfs /atlas/data:rw,exec,nosuid,uid=1000,gid=1000,size=512m \
  "$image" bun run scripts/file-runtime/check-pdf.ts \
  /usr/share/fonts/truetype/dejavu/DejaVuSans.ttf
docker run --rm --network none --read-only \
  --tmpfs /tmp:rw,exec,nosuid,size=512m \
  --tmpfs /atlas/data:rw,exec,nosuid,uid=1000,gid=1000,size=512m \
  "$image" bun test \
  ./apps/server/src/tools/process-filesystem-isolation.test.ts \
  ./apps/server/src/tools/python-execute-tool.test.ts \
  ./apps/server/src/tools/python-execute-deep.test.ts \
  ./apps/server/src/tools/bash.test.ts \
  ./packages/core/src/tools/paths.test.ts \
  ./packages/core/src/tools/filesystem.test.ts \
  ./packages/core/src/tools/search-files.test.ts \
  ./packages/core/src/files/pdf-text.test.ts \
  ./packages/core/src/office-document/office-document.test.ts \
  ./packages/core/src/office-document/revisions.test.ts \
  ./packages/core/src/tools/spreadsheet-ooxml.test.ts \
  ./packages/core/src/tools/spreadsheet-features.test.ts \
  ./packages/core/src/channel-integration-policy.test.ts \
  ./apps/server/src/http/routes/channel-native-actions.test.ts \
  ./apps/server/src/http/routes/channel-native-policy-settings.test.ts \
  ./apps/server/src/http/routes/channel-questionnaire-binding.test.ts \
  ./apps/server/src/http/routes/channel-voice.test.ts \
  ./apps/server/src/services/channel-native-provider-bridge.test.ts \
  ./apps/server/src/services/audio-transcription.test.ts \
  ./apps/server/src/providers/capabilities/executors/audio-transcription.test.ts \
  ./apps/server/src/providers/channel-native-schema.test.ts \
  ./apps/platform/whatsapp/src/authorization-integration.test.ts \
  ./apps/platform/whatsapp/src/native-actions.test.ts \
  ./apps/platform/whatsapp/src/native-controls.test.ts \
  ./apps/platform/whatsapp/src/native-media.test.ts \
  ./apps/platform/telegram/src/native-actions.test.ts \
  ./apps/platform/telegram/src/channel-artifact-flow.test.ts \
  ./apps/platform/telegram/src/native-controls.test.ts \
  ./apps/platform/telegram/src/native-handler.test.ts \
  ./apps/platform/telegram/src/native-media-handler.test.ts \
  ./apps/platform/telegram/src/video.test.ts \
  ./apps/platform/discord/src/native-actions.test.ts \
  ./apps/platform/discord/src/channel-artifact-authorization.test.ts \
  ./apps/platform/discord/src/native-audio.test.ts \
  ./apps/platform/discord/src/native-callbacks.test.ts \
  ./apps/platform/discord/src/native-handler.test.ts \
  ./apps/platform/discord/src/native-interaction.test.ts \
  ./apps/platform/discord/src/native-questionnaire-multiple.test.ts \
  ./apps/platform/discord/src/voice-session.test.ts
# Loading the voice wrapper alone can hide a missing architecture-specific
# native DAVE binary. Exercise its local key generation without a gateway.
docker run --rm --network none --read-only \
  --tmpfs /tmp:rw,exec,nosuid,size=512m \
  --tmpfs /atlas/data:rw,exec,nosuid,uid=1000,gid=1000,size=512m \
  --workdir /app/apps/platform/discord "$image" bun -e '
import assert from "node:assert/strict";
import { getCiphers } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const native = createRequire(require.resolve("@discordjs/voice"))("@snazzah/davey");
const session = new native.DAVESession(native.DAVE_PROTOCOL_VERSION, "123", "456");
const keyPackage = session.getSerializedKeyPackage();
assert.ok(keyPackage.length > 0);
assert.ok(getCiphers().includes("aes-256-gcm"));
session.reset();
console.log(JSON.stringify({
  evidenceClass: "actual native DAVE local key generation and crypto availability",
  architecture: process.arch,
  daveProtocol: native.DAVE_PROTOCOL_VERSION,
  keyPackageBytes: keyPackage.length,
  nativeAesGcm: true,
  liveDiscordVoice: "NOT_RUN",
  status: "passed"
}));
'
bash "$repository/scripts/verify-docker-health.sh" "$image"
bash "$repository/scripts/verify-docker-startup.sh" "$image"
printf 'PASS: built and exercised %s; no host data mounted or messenger traffic sent.\n' "$image"
