# SharePoint → Outline ingestion service.
FROM node:22-slim
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
CMD ["pnpm", "start"]
