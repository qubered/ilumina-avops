# Multi-stage build for the AV Ops assistant (Next.js standalone output).
# Build context is the REPO ROOT (pnpm workspace) — see docker/docker-compose.yml.

FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /repo

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/assistant/package.json apps/assistant/package.json
COPY packages/mort-core/package.json packages/mort-core/package.json
RUN pnpm install --frozen-lockfile --filter assistant...

FROM base AS build
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/assistant/node_modules ./apps/assistant/node_modules
COPY --from=deps /repo/packages/mort-core/node_modules ./packages/mort-core/node_modules
COPY packages/mort-core packages/mort-core
COPY apps/assistant apps/assistant
WORKDIR /repo/apps/assistant
RUN pnpm build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

COPY --from=build /repo/apps/assistant/.next/standalone ./
COPY --from=build /repo/apps/assistant/.next/static ./apps/assistant/.next/static
COPY --from=build /repo/apps/assistant/public ./apps/assistant/public
# Drizzle migrations run at boot (src/instrumentation.ts).
COPY --from=build /repo/apps/assistant/drizzle ./apps/assistant/drizzle

USER node
EXPOSE 3000
CMD ["node", "apps/assistant/server.js"]
