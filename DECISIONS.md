# DECISIONS.md — running log of non-obvious choices

Format: date — decision — why.

## 2026-07-16 — Toolchain pins

- **TypeScript 5.9 (not 7.x), Prisma 6 (not 7.x), ESLint 9 (not 10)** — the newest majors
  (TS 7 native port, Prisma 7 client rewrite) are young rewrites with ecosystem friction;
  a production service favors the mature, still-supported majors. Revisit quarterly.
- **Zod 4 + fastify-type-provider-zod 7** — current stable pairing; gives one schema source
  of truth for validation and OpenAPI generation.
- **pdfjs-dist for PDF parsing (goal allowed pdf-parse or pdfjs-dist)** — `pdf-parse` v1 is
  unmaintained (2018) and v2 is a fresh rewrite; pdfjs-dist is the actively maintained
  upstream. We reconstruct lines from positioned text items, which also gives us control
  over PAGASA's PDF layout quirks.

## 2026-07-16 — PSGC dataset

- Bundled from the community-maintained PSGC API mirror (`psgc.gitlab.io`, PSA 2019 codes):
  81 provinces + 1,634 cities/municipalities, checked into `packages/shared` as JSON.
  Barangays are excluded (PAGASA wind signals never go below city/municipality).
- **Metro Manila** is not a PSGC province; we add a pseudo-entry with the NCR region code
  `130000000` and map NCR cities to it, because PAGASA bulletins address "Metro Manila"
  as a single area.
- PAGASA also references non-PSGC geographies ("Babuyan Islands", "mainland Cagayan",
  "Polillo Islands", named islands like "Fuga Is."). These get a curated alias table;
  anything unresolvable is stored with `psgcCode = null` and the raw name preserved
  (per the goal: log, never crash).

## 2026-07-16 — Fixtures are real PAGASA documents

- Downloaded 6 real TCB PDFs from PAGASA's public file server (cyclones Inday, Francisco,
  Josie — June/July 2026) covering: STY/TY/STS/LPA stages, Signal 1–2 tables, nested
  municipality lists, partial-area descriptors, "No Wind Signal hoisted", final "NR. nF"
  bulletins, and OUTSIDE-PAR variants.
- HTML fixtures: current live page ("No Active Tropical Cyclone" state) plus two
  Wayback-Machine snapshots of the severe-weather-bulletin page while cyclones were active
  (Super Typhoon Nando/Ragasa 2025 with Signals up to 4–5; Emong 2025), so the HTML parser
  is written against PAGASA's real markup, not a reconstruction.

## 2026-07-16 — Rate limiting algorithm

- Tiers are daily quotas (100/day … 100k/day). A true sliding-window ZSET per key would
  hold up to 100k members per PRO key (megabytes per key), so we use the standard
  **sliding-window counter** approximation: fixed daily buckets with the previous bucket
  weighted by overlap. Error bound is small, memory is O(1) per key, and headers
  (`X-RateLimit-*`, `Retry-After`) stay exact for the reset time.

## 2026-07-16 — Monorepo build strategy

- Each package compiles with `tsc` to `dist/`; apps run compiled JS in Docker and `tsx`
  in dev. Vitest resolves workspace packages to `src/` via aliases so tests never require
  a pre-build. `pnpm deploy` builds pruned production images.

## 2026-07-16 — pdfjs detaches input buffers

- `getDocument({ data })` transfers the underlying ArrayBuffer, silently zeroing the
  caller's copy. Content hashes computed after parsing were hashes of empty buffers —
  the idempotency integration test caught it. `extractPdfText` now copies its input.

## 2026-07-16 — Cyclone status comes from the newest bulletin only

- Backfilling an older bulletin (re-parsing history, fixture seeding in file order) must
  never regress `Cyclone.status/category`. `persistBulletin` applies status/category only
  when the incoming bulletin is the newest for that cyclone.

## 2026-07-16 — @bagyo/ingest package

- `persistBulletin` + change detection started inside apps/worker, but the seed script
  and API integration tests both need them; extracted to `packages/ingest`
  (deps: db + shared only) instead of cross-app imports.

## 2026-07-16 — Seeding lives in apps/worker

- The seed ingests fixture PDFs through the real parser (`@bagyo/parser`) and
  `@bagyo/ingest`. Putting it in `packages/db` would create a dependency cycle
  (db → ingest → db), so it ships as `apps/worker/dist/seed.js`.

## 2026-07-16 — Poll cadence via a single 10-minute tick

- One BullMQ job scheduler ticks every 10 minutes; a Redis-backed gate stretches the
  effective cadence to 30 minutes when no cyclone is ACTIVE. Simpler than swapping
  repeatable jobs at runtime, and the worst case (one extra HEAD-sized fetch per half
  hour) stays well within polite-scraping bounds.

## 2026-07-16 — PSGC filter semantics for webhooks

- A non-empty `psgcFilter` restricts a subscription to signal events touching those
  areas; area-less events (`bulletin.issued`, PAR transitions) are skipped for such
  subscriptions to avoid spam. `minSignalLevel` gates on max(previous, new) so a
  Signal 3 → 1 lowering still notifies a "Signal 2+" subscriber.

## 2026-07-16 — Rainfall ingestion is best-effort

- PAGASA regional rainfall advisories are free-form pages with no stable markup. The
  parser extracts (level, time, areas) conservatively and records a SKIPPED IngestRun
  when nothing parses — never guesses. Revisit when a stable source appears.

## 2026-07-16 — Docker image strategy

- Multi-stage build compiles once and ships `pnpm prune --prod` output for api/worker;
  the `migrate` target keeps the full toolchain for `prisma migrate deploy` and seeding.
  `pnpm deploy`-based slimming was rejected for now: Prisma's generated client lives in
  the virtual store and does not survive re-installation without re-generating.

## 2026-07-16 — Docker image strategy, revised after real build

- `pnpm prune --prod` at a workspace root prunes against the ROOT manifest and stripped
  the sub-packages' runtime deps (api container died with `Cannot find package 'bullmq'`).
  Replaced with a dedicated `prod` stage: fresh `pnpm install --prod --frozen-lockfile`,
  `prisma generate` (prisma CLI promoted to @bagyo/db prod deps — needed for
  `migrate deploy` in production anyway), then COPY the built `dist/` folders. Verified:
  `docker compose up -d --build` reaches a healthy, seeded API in ~80s. The ~1GB image
  has headroom to shrink (prisma engines, pdfjs); acceptable for now.

## 2026-07-17 — RapidAPI marketplace auth

- Marketplace traffic authenticates via RapidAPI's `X-RapidAPI-Proxy-Secret` (constant-time
  compare against `RAPIDAPI_PROXY_SECRET`; unset = feature off). Subscribers are
  auto-provisioned as local users from `X-RapidAPI-User` so stateful features (webhooks)
  work; `X-RapidAPI-Subscription` maps BASIC/PRO/ULTRA/MEGA → FREE/HOBBY/PRO/BUSINESS.
  Our rate limiter stays on as a ceiling behind RapidAPI's own plan quotas — defense in
  depth if the proxy misconfigures, and it keeps one enforcement path for both audiences.
