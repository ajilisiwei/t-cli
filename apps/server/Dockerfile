# syntax=docker/dockerfile:1
#
# t-cli sync server. Build from the repository root:
#   docker build -f apps/server/Dockerfile --platform linux/amd64 -t t-cli-server .
#
# Node 24 runs the TypeScript sources directly (type stripping), so there is
# no compile stage: `deps` installs only the server's production dependencies,
# `runtime` adds the sources and the SQL migrations.
#
# The production host is linux/amd64; always pass --platform when building on
# an arm64 machine, or the image dies there with `exec format error`.
ARG NODE_VERSION=24-alpine

# ---------------------------------------------------------------- deps ------
FROM node:${NODE_VERSION} AS deps
WORKDIR /repo

# Manifests only, so this layer stays cached until a dependency changes.
# Every workspace manifest is needed for `npm ci` to accept the lockfile; the
# --workspace filter still installs only the server's dependency closure
# (measured: 38 MB, no CLI/TUI or dev packages).
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/cli/package.json apps/cli/
COPY packages/core/package.json packages/core/
# --ignore-scripts: no install script is needed by the server's dependencies.
RUN npm ci --omit=dev --workspace @t-cli/server --ignore-scripts \
 && npm cache clean --force

# ------------------------------------------------------------- runtime ------
FROM node:${NODE_VERSION} AS runtime
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app

COPY --from=deps /repo/node_modules node_modules
COPY package.json ./
COPY packages/core/package.json packages/core/
COPY packages/core/src packages/core/src
COPY apps/server/package.json apps/server/
COPY apps/server/src apps/server/src
COPY apps/server/drizzle apps/server/drizzle
# Operator scripts (invites, roles, CLI device approval) run inside the image.
COPY apps/server/scripts apps/server/scripts

USER node
WORKDIR /app/apps/server
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz >/dev/null || exit 1

CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
