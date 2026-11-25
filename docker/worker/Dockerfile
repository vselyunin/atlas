# Builds the Atlas Worker image. Build from the repository root:
#   docker build -f docker/worker/Dockerfile -t atlas-worker:dev .

FROM node:22-bookworm-slim AS build

# node-pty has no Linux prebuild and compiles here, so the final stage needs no toolchain.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates g++ make python3 \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable

WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @atlas/contracts build \
  && pnpm --filter @atlas/worker build \
  && pnpm --filter @atlas/worker deploy --prod --legacy /opt/atlas/worker

FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bubblewrap ca-certificates git ripgrep socat \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g \
    @anthropic-ai/claude-code@2.1.330 \
    @openai/codex@0.169.0 \
    @anthropic-ai/sandbox-runtime@0.0.83 \
  && npm cache clean --force

# The mounted workspace belongs to the host user, not to the container user.
RUN git config --system --add safe.directory '*'

# UID 1001 owns the Claude login in the atlas-agent-home volume.
RUN groupadd --gid 1001 atlas \
  && useradd --uid 1001 --gid atlas --create-home --home-dir /home/atlas --shell /bin/bash atlas

COPY --from=build /opt/atlas/worker /opt/atlas/worker

USER atlas
WORKDIR /opt/atlas/worker
ENTRYPOINT ["node", "dist/main.js"]
