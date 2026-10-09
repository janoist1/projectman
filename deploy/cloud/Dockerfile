# The cloud side of a hybrid installation (PM-317): projectman in `PROJECTMAN_MODE=cloud`, a
# Cloudflare tunnel to reach it, Litestream for the database and restic for the rest of /data.
# Guide: docs/HYBRID.md. Build from the repository root:
#
#   docker build -f deploy/cloud/Dockerfile --build-arg PROJECTMAN_VERSION=$(git rev-parse --short HEAD) -t projectman-cloud .
#
# Deliberately NOT in this image: the `claude`, `codex` and `gh` CLIs. The cloud runs no AI session
# and no machine-dependent part; the engine on the owner's Mac does (docs/ARCHITECTURE.md,
# "Machine-dependent parts"). `git` IS here: the customization repository (config/git.ts) runs it.

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
COPY packages/shared/package.json packages/shared/
COPY packages/templates/package.json packages/templates/
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

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
COPY --chmod=0755 deploy/cloud/entrypoint.sh deploy/cloud/backup.sh deploy/cloud/smoke.sh ./deploy/cloud/
COPY deploy/cloud/litestream.yml ./deploy/cloud/litestream.yml

# Shared by the cloud and the engine: git HEAD is not in the image, so the version is a build argument.
ARG PROJECTMAN_VERSION=dev
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

# The entrypoint starts as root only to hand the volume (mounted root-owned) to the `projectman`
# user (uid 10001), then runs everything as that user without privileges.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4700/api/setup').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--", "/app/deploy/cloud/entrypoint.sh"]
