# Single container definition shared by the devcontainer and compose.yml.
#
#   - .devcontainer/devcontainer.json builds { dockerfile: "../Dockerfile" }
#   - compose.yml builds `.` for `docker compose run --rm test`
#
# The image ships Node 22, a pinned opencode CLI, and (best effort) bun.
# Tests run as the non-root `node` user; HOME and opencode state live under
# /home/node, and the repo is mounted at WORKDIR. The real host
# ~/.config/opencode and ~/.opencode are never copied into the image or
# referenced by the harness.
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

# Pin the opencode CLI to the version this repo is tested against.
ARG OPENCODE_VERSION=1.18.31
RUN npm install -g "opencode-ai@${OPENCODE_VERSION}"

# bun is used opportunistically by opencode's plugin dependency resolution.
# The test suite never requires it, so a failed install must not fail the build.
ENV BUN_INSTALL=/usr/local
RUN curl -fsSL https://bun.sh/install | bash || echo "bun install failed (non-fatal)"

ENV HOME=/home/node
# Never attempt a self-update inside the container.
ENV OPENCODE_DISABLE_AUTOUPDATE=1

# Repo mount point, owned by the non-root user used by compose + devcontainer.
RUN mkdir -p /workspaces/oc-go-usage-display \
  && chown -R node:node /workspaces

WORKDIR /workspaces/oc-go-usage-display
USER node
