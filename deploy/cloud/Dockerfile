# The cloud side of a hybrid installation (PM-317): projectman in `PROJECTMAN_MODE=cloud`, a
# Cloudflare tunnel to reach it, Litestream for the database and restic for the rest of /data.
# Guide: docs/HYBRID.md. Build from the repository root:
#
#   docker build -f deploy/cloud/Dockerfile --build-arg PROJECTMAN_VERSION=$(git rev-parse HEAD) -t projectman-cloud .
#
# Deliberately NOT in this image: the `claude`, `codex` and `gh` CLIs. The cloud runs no AI session
# and no machine-dependent part but one: the history search's local embedding (PM-767) is the server's own
# worker thread over the history in this database, so it runs here (docs/ARCHITECTURE.md, "Machine-dependent
# parts"); the rest is the engine's on the owner's Mac. `git` IS here: the customization repository
# (config/git.ts) runs it.

ARG NODE_IMAGE=node:22-bookworm-slim

FROM cloudflare/cloudflared:2026.10.0 AS cloudflared
FROM litestream/litestream:0.5.17 AS litestream
FROM restic/restic:0.19.1 AS restic

# ---- build: the lockfile's dependencies, the web app and the server bundle ----
FROM ${NODE_IMAGE} AS build
WORKDIR /app
# A toolchain only in case a native module has no prebuilt binary for this platform.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/feedback-widget/package.json apps/feedback-widget/
COPY packages/shared/package.json packages/shared/
COPY packages/templates/package.json packages/templates/
RUN npm ci
COPY . .
# The pinned embedding model of the history search (PM-767), fetched and hash-checked here; `npm run build` copies
# it to apps/server/dist/models/history. The runtime never downloads anything.
RUN npm run prepare:history-model && npm run build && npm prune --omit=dev

# ---- runtime ----
FROM ${NODE_IMAGE} AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl git tini util-linux \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid 10001 projectman \
  && useradd --system --uid 10001 --gid 10001 --home-dir /home/projectman --create-home --shell /usr/sbin/nologin projectman \
  && mkdir -p /data \
  && chown projectman:projectman /data \
  && chmod 700 /data

COPY --from=cloudflared /usr/local/bin/cloudflared /usr/local/bin/cloudflared
COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream
COPY --from=restic /usr/bin/restic /usr/local/bin/restic

WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/server/package.json ./apps/server/package.json
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/web/package.json ./apps/web/package.json
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/apps/feedback-widget/dist ./apps/feedback-widget/dist
COPY --chmod=0755 deploy/cloud/entrypoint.sh deploy/cloud/backup.sh deploy/cloud/smoke.sh ./deploy/cloud/
COPY deploy/cloud/litestream.yml ./deploy/cloud/litestream.yml
# The memory tools run by hand on a disposable copy, never by the entrypoint (docs/HYBRID.md "Memory profile").
COPY deploy/cloud/memory-probe.mjs deploy/cloud/memory-profile.mjs deploy/cloud/heap-summary.mjs ./deploy/cloud/

# Shared by the cloud and the engine: git HEAD is not in the image, so the version is a build argument.
ARG PROJECTMAN_VERSION=dev
LABEL org.opencontainers.image.revision=${PROJECTMAN_VERSION}
# The server stays on the loopback: cloudflared inside the container is the only way in (an outbound
# tunnel), and it names the real client in cf-connecting-ip, which the login limits count by.
ENV NODE_ENV=production \
    HOME=/home/projectman \
    HOST=127.0.0.1 \
    PORT=4700 \
    PROJECTMAN_MODE=cloud \
    PROJECTMAN_HOME=/data \
    PROJECTMAN_CLIENT_IP_HEADER=cf-connecting-ip \
    PROJECTMAN_VERSION=${PROJECTMAN_VERSION}

# Memory (PM-775, PM-772; docs/HYBRID.md "Settings"): the server logs its memory every 10 minutes, and
# the entrypoint gives node --max-old-space-size from PROJECTMAN_HEAP_LIMIT_MB. The PM-773 baseline
# measured a live heap of ~65 MB with no growth (63.9 MB at the start, 64.9 MB after an hour), so
# ceil32(2 x live heap) is 160 MB. The baseline had no request load, so 256 MB leaves four times the
# idle live heap. It bounds a runaway; it saves little, because the ~650 MB outside the JS heap is
# native memory that no heap limit reaches (the V8 default and a lower limit ended within 12 MB).
# Sized for the 2 GB machine the card proposes (t4g.small), not squeezed into the 904 MB one.
ENV PROJECTMAN_MEMORY_LOG_SECONDS=600 \
    PROJECTMAN_HEAP_LIMIT_MB=256

# The entrypoint starts as root only to hand the volume (mounted root-owned) to the `projectman`
# user (uid 10001), then runs everything as that user without privileges.
# curl is already in the image; a node process per check cost ~35 MB and CPU time every 30 seconds.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["curl", "-fsS", "--max-time", "5", "-o", "/dev/null", "http://127.0.0.1:4700/api/setup"]
ENTRYPOINT ["/usr/bin/tini", "--", "/app/deploy/cloud/entrypoint.sh"]
