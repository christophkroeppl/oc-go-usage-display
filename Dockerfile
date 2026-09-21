# Single container definition shared by the devcontainer and compose.yml.
#
#   - .devcontainer/devcontainer.json builds { dockerfile: "../Dockerfile" }
#     and bind-mounts the workspace for interactive dev.
#   - compose.yml builds `.` and runs the full test gate against the checkout
#     baked into the image: no bind mount, so container runs are identical on a
#     developer laptop and in CI.
#
# oven/bun:1.4.2-debian ships bun, tar, script (util-linux), and
# ca-certificates — no apt installs needed. Node.js is provided via a
# `node`→`bun` symlink so `tsc` (which carries a `#!/usr/bin/env node`
# shebang) runs under bun's runtime without a nodejs package.

FROM oven/bun:1.4.2-debian

# tmux is required by the e2e TUI display tests: they drive a real opencode/kilo
# TUI in a detached session and assert on `capture-pane` plain text.
RUN apt-get update \
  && apt-get install -y --no-install-recommends tmux \
  && rm -rf /var/lib/apt/lists/*

# Pin global CLI versions
ARG OPENCODE_VERSION=1.18.31
ARG KILO_VERSION=7.7.5

# Install pinned CLI tools globally
ENV OPENCODE_DISABLE_AUTOUPDATE=1
RUN bun add -g "opencode-ai@${OPENCODE_VERSION}" "@kilocode/cli@${KILO_VERSION}"

# Copy repo source into the image (no bind mount — hermetic test gate).
WORKDIR /workspaces/oc-go-usage-display
COPY . .

# Create a `node`→`bun` symlink so tsc's `#!/usr/bin/env node` shebang resolves
# to bun's runtime (no Node.js package installed). Then install deps and build
# (tsc for type-checking/emitting + esbuild for plugin bundles).
RUN ln -sf "$(command -v bun)" /usr/local/bin/node \
  && bun install \
  && bun run build
