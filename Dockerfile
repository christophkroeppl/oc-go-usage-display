# Single container definition shared by the devcontainer and compose.yml.
#
# The v2 binary is copied from its release image. `COPY --from` cannot expand an
# ARG, so the image is pinned through a named stage instead.
ARG OPENCODE_V2_VERSION=2.1.4
FROM ghcr.io/anomalyco/opencode:${OPENCODE_V2_VERSION} AS opencode-v2

FROM oven/bun:1.4.2-alpine

RUN apk add --no-cache tmux bash

ARG OPENCODE_VERSION=1.19.0
ARG KILO_VERSION=7.8.12

ENV OPENCODE_DISABLE_AUTOUPDATE=1
RUN bun add -g "opencode-ai@${OPENCODE_VERSION}" "@kilocode/cli@${KILO_VERSION}"

COPY --from=opencode-v2 /usr/local/bin/opencode /usr/local/bin/opencode-v2
RUN ln -sf /usr/local/bin/opencode-v2 /usr/local/bin/opencode2

WORKDIR /workspaces/oc-go-usage-display
COPY . .

RUN ln -sf "$(command -v bun)" /usr/local/bin/node \
  && bun install \
  && bun run build

CMD ["sh"]
