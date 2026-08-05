# Plan Overview

This is the reference architecture for ctrluhr, verified against the actual
code. Read it once end-to-end before writing any code. Other docs reference
sections from here. It follows the convention in `docs/README.md` (ADR-0007):
where this doc and the repo disagree about built work, the repo is truth and
this doc is corrected; changes the ADRs have scheduled but not yet applied
are annotated **[pending]** with the ADR that decided them.

## 1. The big picture

ctrluhr is a personal time-tracking system designed for habit construction
rather than billing. It records what application and window title is focused
on your screen over time, persists that to a cloud database, categorizes it,
and shows it back to you with charts, habits, and (later) AI-driven
suggestions.

Three independently-deployable pieces talk over HTTPS:

```
┌─────────────────────────┐        ┌──────────────────────────────────┐
│  Go daemon (per device) │        │  Hono API on Bun                  │
│  Windows + Linux         │  HTTPS │  ─ device auth (JWT)               │
│  ─ active window/app/title│ ─────▶│  ─ event ingest + categorize      │
│  ─ batch queue + retry    │  JWT   │  ─ analytics endpoints             │
│  ─ tray icon, config toml│        │  ─ AI suggestions (phase 4)       │
└─────────────────────────┘        └──────────────┬───────────────────┘
                                                   │
        ┌──────────────────────────┐    ┌──────────▼───────────┐
        │  TanStack Start web app  │    │ Postgres + pgvector │
        │  React 19 + ECharts      │ ── │  (Neon, serverless) │
        │  ─ dashboard, timeline   │    └─────────────────────┘
        │  ─ habits, devices       │
        └──────────────────────────┘
```

## 2. Why this stack (reference card)

When you forget why we picked something, come back here.

### Go for the daemon, not Rust or Node
- Single static binary per OS/arch → trivial install + auto-update.
- Cross-platform window-tracking libraries exist (`xgb`, user32).
- Lower memory than Node (always-on process), simpler than Rust (you want to
  ship, not fight the borrow checker for a background process).
- Badger-backed queue means no external state; daemon survives restarts.

### Hono on Bun, not Next.js or Express
- **Hono** is the modern edge-ready web framework; tiny, typed, fast.
- **Bun** is the fastest JS runtime; native TS, bun install is quick, and
  `Bun.serve` rivals Go for HTTP throughput.
- We do NOT use Next.js for the API because the API is a service, not a
  webpage. Keeping it separate from the web app means each layer scales and
  breaks independently.

### Drizzle ORM, not Prisma
- Drizzle is SQL-first: you write real SQL or query-builder, no DSL lock-in.
- Migrations are generated from your TS schema (single source of truth) and
  checked into git.
- Sits on top of Neon's serverless driver without a proxy process.
- Prisma's heavier runtime + engine is overkill for our query patterns.

### Neon Postgres + pgvector, not SQLite / Mongo / a separate vector DB
- **One store** for relational data, time-series-ish events, AND vector
  embeddings. No second database to sync or pay for.
- **Neon** is serverless, branches per PR, native pgvector support, generous
  free tier. The "DB branch" feature later lets you preview migrations before
  landing them.
- pgvector is a Postgres extension, free, one column, runs analytics queries
  inline with your normal SQL.

### TanStack Start + React 19, not Next.js
- You wanted bleeding edge + talent pool. React has it; TanStack Start is the
  most forward-looking React framework (router-first, server functions, full
  type safety, built on Vite).
- TanStack Router gives you type-safe params/search/loaders; TanStack Query
  handles caching against the Hono API.
- It's pre-1.0 — the trade-off we accept for bleeding edge. If anything
  blocks you during the build, fall back to Remix/React Router v7 — same
  philosophy, but more stable. The plan should work identically either way.

### better-auth with magic link, not Clerk or NextAuth
- Self-hosted, no per-user pricing, schema fits in your Postgres.
- Magic link = no passwords to hash, no reset flows, no breaches. Simplest
  secure auth. Resend delivers the email.
- You can add OAuth later via the same better-auth plugins.

### Nx, not just pnpm workspaces or Turborepo
- Task caching, affected-projects detection, and project graph for free.
- Plays nicely with Go modules living alongside TS workspaces (we give the
  daemon its own project.json that shells out to go).
- pnpm is the package manager; Nx is the orchestration layer on top.

### Biome, not ESLint + Prettier
- One tool for lint and format, significantly faster, no plugin hell.
- It is stricter than Prettier but configurable. For a small team / solo dev
  that's worth it.

## 3. Data flow

### Ingest (write path)

```
1. Daemon polls active window every 1s (debounced).
2. On (app, title) change or every 30s of sameness, daemon emits an event.
3. Daemon batches events locally (gzip), POSTs to /events every 10s or 100 events.
4. API validates batch with Zod (packages/schema is source of truth).
5. For each event:
   a. rules match (app_name → category)? assign.
   b. skip embed if raw_embedding cached and title matches; else embed once.
   c. nearest category by cosine sim > threshold? assign. else category_id NULL.
   (b–c are phase-2+ and their server-side form is superseded — ADR-0002.
   Rules move into the daemon; embedding matching becomes browser-mediated.)
6. INSERT … ON CONFLICT DO NOTHING (idempotent — daemon can replay safely).
7. Return { event_id, category_id|null }[] for the daemon's local state.
```

### Read (dashboard)

```
1. Browser sends TanStack Query request to Hono route /analytics/day?date=…
2. API runs SQL aggregates over activity_events, day-bucketed in the User's
   timezone (ADR-0003), productivity read live from categories (ADR-0004).
3. JSON returned: per-category buckets with durations + uncategorized count.
4. React renders ECharts stacked bar timeline + heatmap.
```

### Auth (magic link)

```
1. User enters email on /login.
2. Web → POST /auth/magic-link (better-auth).
3. API sends email via Resend with a one-time link.
4. User clicks link → browser → /auth/verify?token=… → better-auth sets session cookie.
5. Subsequent requests carry the session cookie (HTTP-only, signed).
```

### Auth (device)

```
1. Authed user creates a device in /devices → POST /devices → returns one-time enrollment token.
2. User runs: ctrluhr auth enroll <token> on the daemon's machine.
3. Daemon exchanges token for a long-lived JWT ("device API key").
4. Daemon uses API key in Authorization: Bearer on every /events POST.
5. API verifies JWT signature AND device status per batch (ADR-0005):
   a Revoked device's key dies immediately — daemon gets 401 and halts
   with a tray notification. Rotation = revoke + re-enroll.
```

## 4. Database schema (full reference)

This is the schema **as built** in `apps/api/src/schema/` (phase 0 creates all
of it, including pgvector columns, so structural migrations stay rare).
Annotations mark changes the ADRs have already decided but not yet migrated.
See `02-database-setup.md` for the step-by-step.

> **Ids are `text`, not `uuid`** (ADR-0006): better-auth owns
> `users`/`sessions`/`verifications` and supplies id values itself, so its
> tables use `text` primary keys with no server-side default, and every
> other table follows suit (all PKs and FKs are `text`). The `account`
> table is deferred until OAuth lands (phase 1+).

```sql
CREATE EXTENSION IF NOT EXISTS vector;

-- better-auth-owned tables (we hold the Drizzle schema; better-auth reads/writes)
users
  id              text pk                    -- better-auth supplies the value (ADR-0006)
  email           text not null unique
  email_verified  bool not null default false
  name            text
  image           text
  created_at      timestamptz not null default now()
  updated_at      timestamptz not null default now()
  -- [pending] timezone text (IANA) — the User-local Day setting of ADR-0003;
  --           column not yet created; needed before user-local analytics

sessions
  id              text pk
  user_id         text not null references users(id) on delete cascade
  token           text not null unique
  expires_at      timestamptz not null
  ip_address      text
  user_agent      text
  created_at      timestamptz not null default now()
  updated_at      timestamptz not null default now()

verifications
  id              text pk
  identifier      text not null
  value           text not null
  user_id         text references users(id) on delete cascade   -- nullable
  expires_at      timestamptz not null
  created_at      timestamptz not null default now()
  updated_at      timestamptz not null default now()

-- ctrluhr-owned tables
devices
  id              text pk
  user_id         text not null references users(id) on delete cascade
  name            text not null
  os              text not null                  -- 'linux' | 'windows' | 'darwin'
  api_token_hash  text not null                  -- [pending] dropped (ADR-0005: rotation = revoke + re-enroll)
  last_seen_at    timestamptz
  created_at      timestamptz not null default now()
  -- [pending] status text not null default 'active'  -- 'active' | 'revoked' (ADR-0005)
  index (user_id)

categories
  id              text pk
  user_id         text not null references users(id) on delete cascade
  name            text not null
  color           text not null default '#6b7280'
  is_productive   int  not null default 0        -- -1 distracting | 0 neutral | 1 productive
  embedding       vector(1536)                   -- category centroid; server-side role suspended (ADR-0002)
  created_at      timestamptz not null default now()
  unique (user_id, name)
  index (user_id)
  check (is_productive in (-1, 0, 1))

category_rules
  category_id     text not null references categories(id) on delete cascade
  pattern_type    text not null                  -- 'app_name' | 'title_regex'
  pattern         text not null
  priority        int default 0                  -- ordering room for phase 2
  primary key (category_id, pattern_type, pattern)  -- same pattern may exist under both matcher types
  index (category_id)
  check (pattern_type in ('app_name', 'title_regex'))

activity_events
  id              text pk                        -- generated by the daemon, not the API
  user_id         text not null references users(id) on delete cascade
  device_id       text not null references devices(id) on delete cascade
  app_name        text not null                  -- [phase 1] client-encrypted (ADR-0002)
  window_title    text not null                  -- [phase 1] client-encrypted (ADR-0002)
  category_id     text references categories(id) -- nullable: uncategorized, awaiting relabel
  productive      int                            -- [pending] dropped (ADR-0004: productivity is read live from the category)
  started_at      timestamptz not null
  ended_at        timestamptz not null
  raw_embedding   vector(1536)                   -- cached embedding; server-side role suspended (ADR-0002)
  index (user_id, started_at)
  index (user_id, category_id, started_at)
  -- pgvector hnsw on raw_embedding: re-evaluated when phase 2 is designed (ADR-0002)

habits
  id                       text pk
  user_id                  text not null references users(id) on delete cascade
  name                     text not null
  target_minutes_per_day   int not null default 60
  color                    text not null default '#22c55e'
  cadence                  text not null default 'daily'   -- as built; only 'daily' is meaningful in phase 0–3
  linked_category_id       text references categories(id)  -- null for manual-only habits
  created_at               timestamptz not null default now()

habit_checkins
  id              text pk
  habit_id        text not null references habits(id) on delete cascade
  user_id         text not null references users(id) on delete cascade
  day             date not null                  -- a User-local Day (ADR-0003)
  minutes_actual  int not null default 0
  achieved        bool not null default false
  created_at      timestamptz not null default now()
  unique (habit_id, day)
```

### Design notes worth internalizing

- **Ids are text and caller-generated (ADR-0006).** better-auth supplies ids
  for its tables; the daemon generates event ids on emission. There is no
  `gen_random_uuid()` anywhere — inserts always carry their id.
- **Idempotent inserts** via `ON CONFLICT (id) DO NOTHING`: daemon batches can
  be replayed safely on network failure.
- **Productivity is read live from the category (ADR-0004).** There is no
  per-event snapshot: an event's productivity is always its category's
  current `is_productive`, so reclassifying a category corrects history. The
  `activity_events.productive` column still physically exists — its drop
  migration is scheduled before phase 1 — but nothing may read or write it.
- **Devices are Revoked, not deleted (ADR-0005).** The `status` column and
  the drop of `api_token_hash` are scheduled before phase 1; until then,
  don't build UI that deletes a device row — the cascade would silently take
  its entire event history with it.
- **`raw_embedding` / `categories.embedding` keep their columns but have no
  server-side role (ADR-0002).** Client-side encryption gates phase 1, so
  server-side embedding matching cannot work as originally designed;
  pgvector's future is re-evaluated when phase 2 is designed. Don't write
  code that depends on these columns yet.
- **`duration_sec` was dropped** — Drizzle can't express generated columns
  cleanly (see `02`). Compute duration at query time
  (`EXTRACT(EPOCH FROM ended_at - started_at)`); a raw-SQL migration can
  re-add it later if range queries need it.
- **Day boundaries are user-local (ADR-0003).** `habit_checkins.day` and all
  analytics bucketing use the User's IANA timezone; event storage stays UTC.
  The `users.timezone` column that setting lives in is not yet created.

## 5. Categorization (superseded design — kept for the record)

> **Superseded by ADR-0002.** Server-side embeddings over plaintext titles
> are no longer the design: rules run in the daemon and embedding matching
> is browser-mediated (BYOK by default, proxied as an opt-in). The phase-2
> build doc will be written from the ADR when phase 2 starts (ADR-0007);
> `07-future-phases.md` holds the current map.

The original two-tier pipeline was: rules first (title regexes, then app
names, first hit wins — see `category_rules`), then embedding match against
category centroids (`text-embedding-3-small`, cosine threshold ~0.78, cached
in `raw_embedding` so retroactive reclassification never re-pays OpenAI).
The rule-evaluation order and the Relabel vocabulary in `CONTEXT.md` survive;
the server-side embedding machinery does not.

## 6. Phases at a glance

| Phase | Goal | Key deliverable |
| --- | --- | --- |
| 0 | Plumbing works end-to-end with synthetic data | Daemon stub → API → Neon → React dashboard shows synthesized activity |
| 1 | Real tracking | Hyprland/X11 + Windows trackers; client-side encryption (ADR-0002); full day's actual activity on dashboard |
| 2 | Categorization | Client-side hybrid pipeline (ADR-0002); relabel UI; uncategorized queue stays small |
| 3 | Habits | Define habit loops, daily checkins auto-derived from events, streak heatmaps |
| 4 | AI | Weekly recap, "why am I distracted at 3pm?" grounded answers via Vercel AI SDK |
| 5 | SaaS hardening | Stripe billing, rate limits, auto-update pipeline, observability |

See `07-future-phases.md` for each phase's entry criteria and constraining decisions.

## 7. Repo layout target

```
ctrluhr/
├── nx.json
├── package.json                     # pnpm workspace root
├── pnpm-workspace.yaml
├── biome.json
├── tsconfig.base.json
├── apps/
│   ├── api/                         # Hono on Bun
│   │   ├── src/
│   │   │   ├── index.ts             # serve bootstrap
│   │   │   ├── auth.ts              # better-auth instance
│   │   │   ├── routes/
│   │   │   │   ├── events.ts
│   │   │   │   ├── categories.ts
│   │   │   │   ├── devices.ts
│   │   │   │   ├── analytics.ts
│   │   │   │   └── habits.ts
│   │   │   ├── lib/
│   │   │   │   ├── db.ts            # Drizzle client
│   │   │   │   ├── categorizer.ts
│   │   │   │   ├── embeddings.ts
│   │   │   │   ├── jwt.ts           # device API key sign/verify
│   │   │   │   └── resend.ts        # email sender
│   │   │   └── schema/              # Drizzle schema files
│   │   ├── drizzle.config.ts
│   │   ├── migrations/
│   │   └── project.json
│   ├── web/                         # TanStack Start
│   │   ├── src/
│   │   │   ├── routes/
│   │   │   │   ├── __root.tsx
│   │   │   │   ├── login.tsx
│   │   │   │   └── _auth/
│   │   │   │       ├── dashboard.tsx
│   │   │   │       ├── timeline.tsx
│   │   │   │       ├── categories.tsx
│   │   │   │       ├── habits.tsx
│   │   │   │       ├── devices.tsx
│   │   │   │       └── settings.tsx
│   │   │   ├── lib/
│   │   │   │   ├── api.ts
│   │   │   │   ├── auth.ts
│   │   │   │   └── charts/
│   │   │   └── components/
│   │   └── project.json
│   └── daemon/                      # Go module
│       ├── main.go
│       ├── tracker/
│       ├── uplink/
│       ├── config/
│       ├── tray/
│       └── project.json
├── packages/
│   └── schema/
│       └── src/
│           ├── event.ts             # Zod schema (source of truth)
│           └── index.ts
└── infra/
    ├── docker/
    └── .env.example
```

**Current state** (so you can enter mid-build): `apps/api` has `index.ts`,
`auth.ts`, `lib/db.ts`, and `schema/` — `routes/` and the rest of `lib/` land
in `03`. `apps/web` has the root/login/`_auth` routes with dashboard and
devices — timeline, categories, habits, settings land later. `apps/daemon` is
a scaffold (`main.go`, `go.mod`, `project.json`) — its packages land in `05`.
`infra/` does not exist yet.

## 8. Naming conventions

- **Project name:** `ctrluhr` everywhere (npm scope if you publish later).
- **DB table names:** snake_case, plural (matches Drizzle conventions).
- **TS/JS:** camelCase variables, PascalCase types/components; TanStack
  Router filenames follow its conventions (`__root.tsx`, `_auth` pathless
  layout directories), kebab-case elsewhere; camelCase for libs.
- **Go:** exported PascalCase, unexported camelCase, package names lowercase
  single word.
- **Env vars:** UPPER_SNAKE (`DATABASE_URL`, `RESEND_API_KEY`).

## 9. Environments

- **Local dev** — everything on your machine. Neon dev branch. Bun serve on
  :3000, TanStack Start on :5173, daemon on demand (go run).
- **Preview** (phase 5+) — Neon PR branch, Fly.io preview app, Vercel preview
  URL per PR.
- **Production** (phase 5+) — Neon main branch, Fly.io API, Vercel web,
  daemon auto-update from GitHub releases.

## 10. Key risks (re-read when you hit a wall)

1. **TanStack Start pre-1.0** — If you hit a framework bug or undocumented
   gotcha, check the `#tanstack` Discord or the GitHub issues. Fallback to
   Remix/React Router v7 is a 1-day swap (the API and DB are unaffected).
2. **Wayland non-Hyprland** — `wlr-foreign-toplevel`-management impl is
   compositor-specific. Phase 1 only needs to support your own Hyprland; if
   you ever move off it, the Linux tracker needs work. That's fine.
3. **Browser tab URL depth** — Native OS APIs only give "app + window title"
   (which for a browser contains the page title). To match RescueTime's exact
   URL tracking you'd need browser extensions. 80% as good with just titles.
4. **Title privacy** — decided, not deferred: client-side encryption gates
   phase 1 (ADR-0002), driven by open signup (ADR-0001). The server only ever
   sees ciphertext for content fields once real tracking ships; the Operator
   reads metadata, never content.
5. **Embedding cost** — Non-issue if embeddings return in phase 2's
   browser-mediated form: BYOK spends the User's own key by design
   (ADR-0002), and volumes are tiny (≈2.4k events/wk at 1/min).
6. **TanStack Start + TanStack Query confusing** — TanStack Start has its
   own data loading via route loaders. Don't immediately reach for
   TanStack Query until you understand when each applies (loaders for initial
   route data, Query for mutations and cross-route caching). See 04.
