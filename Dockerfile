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
RUN CI=true pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# ---- migrate: full toolchain image used for `prisma migrate deploy` and seeding
FROM build AS migrate
CMD ["pnpm", "--filter", "@bagyo/db", "migrate:deploy"]

# ---- prod: production node_modules only + built artifacts + generated client
FROM base AS prod
ENV NODE_ENV=production
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY packages/shared/package.json packages/shared/
COPY packages/parser/package.json packages/parser/
COPY packages/ingest/package.json packages/ingest/
COPY packages/db/package.json packages/db/
RUN CI=true pnpm install --prod --frozen-lockfile
COPY packages/db/prisma packages/db/prisma
RUN pnpm --filter @bagyo/db exec prisma generate
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/parser/dist packages/parser/dist
COPY --from=build /app/packages/ingest/dist packages/ingest/dist
COPY --from=build /app/packages/db/dist packages/db/dist
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/worker/dist apps/worker/dist
# Fixture bulletins power the demo seed (apps/worker/dist/seed.js).
COPY fixtures fixtures

# ---- api
FROM prod AS api
EXPOSE 3000
CMD ["node", "apps/api/dist/index.js"]

# ---- worker
FROM prod AS worker
CMD ["node", "apps/worker/dist/index.js"]
