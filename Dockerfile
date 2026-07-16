# syntax=docker/dockerfile:1

FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

# ---- build: install all deps, generate prisma client, compile every package
FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY packages/shared/package.json packages/shared/
COPY packages/parser/package.json packages/parser/
COPY packages/ingest/package.json packages/ingest/
COPY packages/db/package.json packages/db/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# ---- migrate: full toolchain image used for `prisma migrate deploy` and seeding
FROM build AS migrate
CMD ["pnpm", "--filter", "@bagyo/db", "migrate:deploy"]

# ---- pruned: drop devDependencies, keep workspace links + generated prisma client
FROM build AS pruned
RUN pnpm prune --prod

# ---- api
FROM base AS api
ENV NODE_ENV=production
COPY --from=pruned /app /app
EXPOSE 3000
CMD ["node", "apps/api/dist/index.js"]

# ---- worker
FROM base AS worker
ENV NODE_ENV=production
COPY --from=pruned /app /app
CMD ["node", "apps/worker/dist/index.js"]
