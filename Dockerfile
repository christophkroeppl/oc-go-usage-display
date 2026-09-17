# Single container definition shared by the devcontainer and compose.yml.
#
#   - .devcontainer/devcontainer.json builds { dockerfile: "../Dockerfile" }
#     and bind-mounts the workspace for interactive dev.
#   - compose.yml builds `.` and runs the test gate against the checkout baked
#     into the image: no bind mount, so container runs are identical on a
#     developer laptop and in CI and never depend on host UID/GID ownership.
#
# The image ships Node 22 (for node --test, tsc, npm scripts), a pinned
# opencode CLI, and a pinned bun (primary package manager for deps).
# Tests run as the non-root `node` user; HOME and opencode state live under
# /home/node. The real host ~/.config/opencode and ~/.opencode are never
# copied into the image or referenced by the harness.
#
# NOTE: ghcr.io/bun/bun:1.4.2-bookworm is the preferred base (bun pre-installed),
# but GHCR requires read:packages auth not available in all environments. When
# the bun image is unreachable, fall back to node:22-bookworm-slim + the bun
# installer script — still using `bun install` for deps and `node --test` for
# tests (Bun's os.homedir() does not respect runtime HOME changes, so
# bun test is not parity-compatible with node --test for hermeticity tests).
FROM node:22-bookworm-slim

# Runtime tooling:
#   git / ca-certificates / curl : opencode + plugin installs, smoke probes
#   tar / xz-utils / unzip       : npm pack + tarball extraction
#   util-linux                   : the `script` PTY used by the TUI smoke test
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    curl \
    tar \
    xz-utils \
    unzip \
    util-linux \
  && rm -rf /var/lib/apt/lists/*

# Pin bun to an exact release: bun is the primary package manager for
# plugin dependency resolution.  The download must fail the build (no masked
# fallback) and the installed binary is verified, so the image never silently
# ships a half-provisioned toolchain behind the pinned version.
ARG BUN_VERSION=1.4.2
ENV BUN_INSTALL=/usr/local
RUN curl -fsSL https://bun.sh/install -o /tmp/bun-install.sh \
  && bash /tmp/bun-install.sh "bun-v${BUN_VERSION}" \
  && rm -f /tmp/bun-install.sh \
  && bun --version

# Pin the opencode CLI to the version this repo is tested against.
# Try bun install -g first; fall back to npm install -g (Node.js is already
# present in the base image).
ARG OPENCODE_VERSION=1.18.31
RUN bun add -g "opencode-ai@${OPENCODE_VERSION}"

ENV HOME=/home/node
# Never attempt a self-update inside the container.
ENV OPENCODE_DISABLE_AUTOUPDATE=1

# Bake the repository checkout into the image. compose.yml runs this exact
# tree; the devcontainer overlays its bind-mounted workspace on top. The
# checkout is owned by the non-root user and `bun install` runs as that user,
# so node_modules is writable without any host UID mapping.
RUN mkdir -p /workspaces/oc-go-usage-display \
  && chown -R node:node /workspaces
WORKDIR /workspaces/oc-go-usage-display
COPY --chown=node:node . .
USER node
RUN bun install