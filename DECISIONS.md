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
