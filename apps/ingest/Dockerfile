# SharePoint → Outline ingestion service.
# Build context is the REPO ROOT (pnpm workspace) — see docker/docker-compose.yml.

FROM node:22-slim
RUN corepack enable
WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/ingest/package.json apps/ingest/package.json
COPY packages/mort-core/package.json packages/mort-core/package.json
RUN pnpm install --frozen-lockfile --filter ingest...

COPY packages/mort-core packages/mort-core
COPY apps/ingest apps/ingest

ENV NODE_ENV=production
ENV PORT=8080
WORKDIR /repo/apps/ingest
EXPOSE 8080
CMD ["pnpm", "start"]
