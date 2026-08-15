# Atlas — one container: API, web dashboard, automation + task workers
# Build & run: ./scripts/docker-build-run.sh

ARG BUILDPLATFORM

# --- Build web dashboard (devDependencies stay in this stage only) ---
FROM --platform=${BUILDPLATFORM} oven/bun:1.3-slim AS web-builder
WORKDIR /app

COPY package.json bun.lock ./
COPY apps apps
COPY packages packages

RUN bun install --frozen-lockfile --ignore-scripts \
  && bun run --filter @atlas/web build

# --- Production runtime (server + workspace packages + built static assets) ---
FROM oven/bun:1.3-slim AS runtime
WORKDIR /app

# Optional tool-output optimiser. Empty by default, so the published image is
# unchanged and carries no binary most deployments would never run. Build with
# --build-arg OMNI_VERSION=0.7.3 to include it, then set ATLAS_OMNI=1.
# The release is a static musl build, which runs on this glibc base, and the
# published checksum is verified rather than the download trusted.
ARG OMNI_VERSION="0.7.5"
RUN if [ -n "$OMNI_VERSION" ]; then \
      set -eu; \
      apt-get update && apt-get install -y --no-install-recommends curl ca-certificates; \
      case "$(dpkg --print-architecture)" in \
        amd64) target=x86_64-unknown-linux-musl ;; \
        arm64) target=aarch64-unknown-linux-musl ;; \
        *) echo "no omni build for $(dpkg --print-architecture)" >&2; exit 1 ;; \
      esac; \ 
      base="https://github.com/fajarhide/omni/releases/download/v${OMNI_VERSION}"; \
      archive="omni-v${OMNI_VERSION}-${target}.tar.gz"; \
      curl -fsSL -o "/tmp/${archive}" "${base}/${archive}"; \
      curl -fsSL -o /tmp/SHA256SUMS "${base}/SHA256SUMS"; \
      (cd /tmp && grep " ${archive}\$" SHA256SUMS | sha256sum -c -); \
      tar -xzf "/tmp/${archive}" -C /usr/local/bin omni; \
      rm -rf "/tmp/${archive}" /tmp/SHA256SUMS /var/lib/apt/lists/*; \
      omni --version; \
    fi

COPY package.json bun.lock ./
COPY apps/server apps/server
COPY apps/platform/automation apps/platform/automation
COPY apps/platform/telegram apps/platform/telegram
COPY apps/platform/whatsapp apps/platform/whatsapp
COPY apps/platform/discord apps/platform/discord
COPY packages packages
# Workspace stubs keep the lockfile valid without pulling web/cli sources.
COPY apps/web/package.json apps/web/
COPY apps/cli/package.json apps/cli/
COPY --from=web-builder /app/apps/web/dist apps/web/dist

RUN bun install --frozen-lockfile --production --ignore-scripts \
      --filter '@atlas/server' \
      --filter '@atlas/automation' \
      --filter '@atlas/telegram' \
      --filter '@atlas/whatsapp' \
      --filter '@atlas/discord' \
  && test -n "$(find node_modules/.bun -path '*/node_modules/pm2/bin/pm2-runtime' -type f -print -quit)" \
  && mkdir -p /atlas/data \
  && if getent group 1000 >/dev/null; then \
       G=$(getent group 1000 | cut -d: -f1); \
       [ "$G" = atlas ] || groupmod -n atlas "$G"; \
     else groupadd --system --gid 1000 atlas; fi \
  && if getent passwd atlas >/dev/null; then \
       usermod -d /atlas/data atlas; \
     elif getent passwd 1000 >/dev/null; then \
       U=$(getent passwd 1000 | cut -d: -f1); \
       usermod -l atlas -g atlas -d /atlas/data "$U"; \
     else useradd --system --uid 1000 --gid atlas --home-dir /atlas/data --create-home atlas; fi \
  && chown -R atlas:atlas /app /atlas

ENV NODE_ENV=production \
    ATLAS_HOST=0.0.0.0 \
    ATLAS_PORT=4310 \
    ATLAS_CONFIG_DIR=/atlas/data \
    DATABASE_URL=file:/atlas/data/sqlite/atlas.sqlite \
    BUN_INSTALL_BIN=/atlas/data/.bun/bin \
    BUN_INSTALL_GLOBAL_DIR=/atlas/data/.bun/install/global

EXPOSE 4310

VOLUME ["/atlas/data"]

USER 1000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:4310/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["bun", "run", "apps/server/src/index.ts"]
