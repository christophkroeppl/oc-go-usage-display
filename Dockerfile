# Single container definition shared by the devcontainer and compose.yml.

FROM oven/bun:1.4.2-alpine

RUN apk add --no-cache tmux bash

ARG OPENCODE_VERSION=1.19.0
ARG KILO_VERSION=7.8.12

ENV OPENCODE_DISABLE_AUTOUPDATE=1
RUN bun add -g "opencode-ai@${OPENCODE_VERSION}" "@kilocode/cli@${KILO_VERSION}"

COPY --from=ghcr.io/anomalyco/opencode:2.1.4 /usr/local/bin/opencode /usr/local/bin/opencode-v2
RUN ln -sf /usr/local/bin/opencode-v2 /usr/local/bin/opencode2

WORKDIR /workspaces/oc-go-usage-display
COPY . .

RUN ln -sf "$(command -v bun)" /usr/local/bin/node \
  && bun install \
  && bun run build

CMD ["sh"]
