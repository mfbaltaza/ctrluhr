# Plan Overview

This is the reference architecture for ctrluhr. Read it once end-to-end before
writing any code. Other docs reference sections from here.

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
  ship, not fight borrow checker for a background process).
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
  type safety, built on Vite/Vinxi).
- TanStack Router gives you type-safe params/search/loaders; TanStack Query
  handles caching against the Hono API.
- It's pre-1.0 — the trade-off we accept for bleeding edge. If anything
  blocks you during the build, Fall back to Remix/React Router v7 — same
  philosophy, but more stable. The plan should work identically either way.

### better-auth with magic link, not Clerk or NextAuth
- Self-hosted, no per-user pricing, schema fits in your Postgres.
- Magic link = no passwords to hash, no reset flows, no breaches. Simplest
  secure auth. Resend delivers the email.
- you can add OAuth later via the same better-auth plugins.

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
6. INSERT … ON CONFLICT DO NOTHING (idempotent — daemon can replay safely).
7. Return { event_id, category_id|null }[] for the daemon's local state.
```

### Read (dashboard)

```
1. Browser sends TanStack Query request to Hono route /analytics/day?date=…
2. API runs SQL aggregates (window functions over activity_events).
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
5. User can rotate/revoke in /devices; daemon gets 401 and halts with a tray notification.
```

## 4. Database schema (full reference)

This is the target. Phase 0 creates all of it (including pgvector columns) so
we never migrate. See `02-database-setup.md` for the step-by-step.

```sql
CREATE EXTENSION IF NOT EXISTS vector;

-- better-auth manages its own tables; we create them via Drizzle schema
-- (user, session, verification). below are ctrluhr-owned tables.

users          (id, email, created_at)  -- better-auth user table
sessions       (id, user_id, expires_at, token)
verifications  (id, user_id, token, type, expires_at)

devices
  id              uuid pk default gen_random_uuid()
  user_id         uuid not null references users(id) on delete cascade
  name            text not null
  os              text not null                  -- 'linux' | 'windows' | 'darwin'
  api_token_hash  text not null                  -- argon2 hash of long-lived key
  last_seen_at    timestamptz
  created_at      timestamptz default now()
  index (user_id)

categories
  id              uuid pk default gen_random_uuid()
  user_id         uuid not null references users(id) on delete cascade
  name            text not null
  color           text not null default '#6b7280'
  is_productive   int  not null default 0        -- -1 distracting | 0 neutral | 1 productive
  embedding       vector(1536)                   -- category centroid (avg of labeled rows); nullable until first labeled event
  created_at      timestamptz default now()
  unique (user_id, name)

category_rules
  id            uuid pk default gen_random_uuid()
  category_id   uuid not null references categories(id) on delete cascade
  pattern_type  text not null                   -- 'app_name' | 'title_regex'
  pattern       text not null
  index (category_id)

activity_events
  id              uuid pk default gen_random_uuid()
  user_id         uuid not null references users(id) on delete cascade
  device_id       uuid not null references devices(id) on delete cascade
  app_name        text not null
  window_title    text not null                  -- full title per user decision
  category_id     uuid references categories(id) -- nullable: uncategorized, awaiting relabel
  productive      int                            -- snapshot of category.is_productive at event time; nullable until categorized
  started_at      timestamptz not null
  ended_at       timestamptz not null
  duration_sec    int generated always as (extract(epoch from ended_at - started_at)) stored
  raw_embedding   vector(1536)                   -- cached embedding of (app || '' || title); nullable until first embedding
  -- indexes
  index (user_id, started_at desc)
  index (user_id, category_id, started_at)
  -- pgvector hnsw on raw_embedding for similarity queries (phase 2+)

habits
  id                       uuid pk default gen_random_uuid()
  user_id                  uuid not null references users(id) on delete cascade
  name                     text not null
  target_minutes_per_day   int not null default 60
  color                    text not null default '#22c55e'
  cadence                  text not null default 'daily'   -- 'daily' | 'weekly' | cron expr
  linked_category_id       uuid references categories(id) -- can be null for manual-only habits
  created_at               timestamptz default now()

habit_checkins
  id              uuid pk default gen_random_uuid()
  habit_id        uuid not null references habits(id) on delete cascade
  user_id         uuid not null references users(id) on delete cascade
  day             date not null
  minutes_actual  int not null default 0
  achieved        bool not null default false
  created_at      timestamptz default now()
  unique (habit_id, day)
```

### Design notes worth internalizing

- **`raw_embedding` on activity_events is cached, not derived.** Embed once
  when the event lands; reuse forever. When you add new categories later,
  you can re-classify retroactively *without* paying OpenAI again — just
  re-query the cached embeddings against the new category centroids.
- **`productive` is snapshotted at event-time.** If a user reclassifies a
  category from neutral to productive, OLD events keep their old value. This
  is intentional: analytics for "was last week productive?" should reflect
  what the user believed at the time, not current classifications. Add a
  `productive_current` view at query time if you want the alternative.
- **`duration_sec` is generated always stored** — Postgres computes it
  cheaply, and you get range queries like `WHERE duration_sec > 60` for free.
- **Idempotent inserts** via `ON CONFLICT (id) DO NOTHING`: daemon batches can
  be replayed safely on network failure. The daemon generates the UUID on
  emission, not the API.

## 5. Categorization (phase 2 detail — read now, implement later)

Two-tier pipeline, rules first then embeddings:

```
Rules map (category_rules):
  pattern_type='app_name', pattern='Visual Studio Code' → category "Coding"
  pattern_type='title_regex', pattern='github\.com' → category "Coding"
  pattern_type='title_regex', pattern='youtube\.com' → category "Entertainment"

For each new event:
  1. Try rule match:
     - app_name IN category_rules(pattern_type='app_name')
     - regex_match(window_title, category_rules(pattern_type='title_regex'))
     - First hit wins (priority by rule order).
  2. If no rule matched:
     - Embed (app + ' ' + title) via text-embedding-3-small.
     - Cache the embedding in raw_embedding.
     - Query categories.embedding <-> $1 ORDER BY embedding <=> $1 LIMIT 1 for this user.
     - If cosine_sim > 0.78, assign category_id and set productive
       snapshot. Else category_id = NULL (uncategorized queue).
  3. If raw_embedding was already cached (event already in DB, retroactive run):
     - Skip embed, reuse. (Phase 2's "relabel" runs.)
```

### Why threshold 0.78

OpenAI recommendation range is 0.7–0.85. Start at 0.78; tune after seeing your
own uncategorized count. Below 0.78 = user labels manually (feed the loop),
which is exactly the habit-construction philosophy.

### Category centroids

`categories.embedding` is periodically recomputed as the average of all
labeled `raw_embedding` rows for events in that category. A nightly job (phase
2) or an on-relabel trigger refreshes it. Initially it is NULL → no embedding
match possible for that category until at least one labeled event exists.

## 6. Phases at a glance

| Phase | Goal | Key deliverable |
| --- | --- | --- |
| 0 | Plumbing works end-to-end with synthetic data | Daemon stub → API → Neon → React dashboard shows synthesized activity |
| 1 | Real tracking | Hyprland/X11 + Windows trackers; full day's actual activity on dashboard |
| 2 | Categorization | pgvector hybrid pipeline; relabel UI; uncategorized queue stays small |
| 3 | Habits | Define habit loops, daily checkins auto-derived from events, streak heatmaps |
| 4 | AI | Weekly recap, "why am I distracted at 3pm?" grounded answers via Vercel AI SDK |
| 5 | SaaS hardening | Stripe billing, rate limits, auto-update pipeline, observability |

See `07-future-phases.md` for what each phase entails.

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
│  │   │   │   ├── login.tsx
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

## 8. Naming conventions

- **Project name:** `ctrluhr` everywhere (npm scope if you publish later).
- **DB table names:** snake_case, plural (matches Drizzle conventions).
- **TS/JS:** camelCase variables, PascalCase types/components, kebab-case
  filenames for SvelteRoute files, camelCase for libs.
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
4. **Title privacy for multi-tenant SaaS** — You store full titles on your
   own server. That's fine for self/SaaS-as-trusted-operator. When you add
   real customers in phase 5, decide: encrypt at rest with user-held keys
   (upgrade story).
5. **Embedding cost** — Non-issue. At 1 event/min × 8h × 5d ≈ 2.4k/wk.
  text-embedding-3-small is $0.02/1M tokens → less than a cent per week.
6. **TanStack Start + TanStack Query confusing** — TanStack Start has its
   own data loading via route loaders. don't immediately reach for
   TanStack Query until you understand when each applies (loaders for initial
   route data, Query for mutations and cross-route caching). See 04.