# 07 — Future Phases (1–5)

Reference for each phase after MVP plumbing is done. Read the relevant
section fully before starting that phase. Each phase assumes the previous
one is complete and the phase-0 smoke test still passes on `main`.

## Phase 1 — Real tracking

**Goal:** replace the stub tracker with actual window polling on Linux
(Hyprland/X11) and Windows. Dashboard shows your real day.

### Daemon work

1. **`tracker/linux_hypr.go`** — Hyprland first (you're on it).
   ```go
   // Hyprland IPC: hyprctl activewindow -j returns JSON
   // { "class": "...", "title": "...", "workspace": { "id": ... } }
   ```
   - Run `hyprctl activewindow -j` every 1s via `os/exec`.
   - Compare to last reading; on change emit event.
   - Detect Hyprland via `HYPRLAND_INSTANCE_SIGNATURE` env var.

2. **`tracker/linux_x11.go`** — X11 fallback.
   - Use `github.com/jezek/xgbutil` or `github.com/jezek/xgb`.
   - Listen to `_NET_ACTIVE_WINDOW` property changes on the root window.
   - Get window title via `ICCCM WM_NAME` or `_NET_WM_NAME`.

3. **`tracker/windows.go`** — Windows tracker.
   - `user32.GetForegroundWindow` + `GetWindowTextW`.
   - Process name via `QueryFullProcessImageNameW`.
   - Poll 1Hz like the Linux variants.

4. **`select` at startup** — pick the tracker based on `runtime.GOOS` and env
   vars. Fall back to stub if no real tracker matches (useful for testing on
   CI).

5. **Idle detection** — pause emission when the OS reports > 5 minutes idle.
   - Linux: `xprintidle` (X11) or `wlr-session` equivalent (Wayland: no
     standard; you can poll Hyprland for no focused window changes).
   - Windows: `GetLastInputInfo`.
   - On idle-end, emit no events for the idle period.

6. **Pause rules** — config-driven.
   ```toml
   [[pause_rules]]
   title_regex = ".*1Password.*"
   ```
   Drop matching events silently (don't even buffer).

### API work

1. **Hourly breakdown** — update `/analytics/day` to return hourly buckets
   so the dashboard's ECharts can render a real timeline.

   ```sql
   SELECT
     extract(hour from started_at) AS hour,
     category_id, productive,
     sum(extract(epoch from ended_at - started_at))::int AS sec
   FROM activity_events
   WHERE user_id = $1 AND started_at >= $2 AND started_at < $3
   GROUP BY hour, category_id, productive
   ORDER BY hour
   ```
   Drizzle equivalent uses `sql` template with `extract(hour from ...)`.

2. **Daily totals endpoint** — `/analytics/week?from=YYYY-MM-DD` returning
   7-day totals for the heatmap component.

### Web work

1. **Timeline chart upgrade** — feed the real hourly data into
   `DayTimelineChart`. The chart is already built for it (24-bucket array).

2. **Week heatmap** — new component `WeekHeatmap.tsx` using ECharts
   `visualMap` + `series.type='heatmap'`. Cells = day × hour, value =
   productive minutes.

3. **Timeline page** (`/_auth/timeline`) — Gantt-style day detail listing raw
   events. Each event is deletable and relabelable (relabel gets a real use
   in phase 2). Use ECharts `custom` series or render manually with CSS
   grid; the latter is simpler for raw events.

### Phase 1 smoke test

- Daemon outputs your real app names (visible in API logs or a temp
  `/events?dry_run=1` debug mode).
- After 1h of real work, dashboard shows sensible data.
- Idle detection pauses events when you walk away (verify by idling 6 min).

## Phase 2 — Categorization

**Goal:** stop labeling everything "Uncategorized". Hybrid rules + embeddings
auto-categorize 90%+ of events; user relabels the rest via UI.

### API work

1. **`lib/embeddings.ts` integration with categorizer** — when no rule
   matches, embed the title, cache to `raw_embedding`, nearest category by
   cosine sim.

   ```ts
   async function categorizeEmbedding(userId, appName, title) {
     const vector = await embed(`${appName} ${title}`);
     const rows = await db.execute(sql`
       SELECT id, is_productive, embedding <=> ${vector} AS distance
       FROM categories
       WHERE user_id = ${userId} AND embedding IS NOT NULL
       ORDER BY distance LIMIT 1
     `;
     const hit = rows[0];
     if (!hit || hit.distance > 0.22) return null; // sim < 0.78 = dist > 0.22
     return { categoryId: hit.id, productive: hit.is_productive };
   }
   ```

2. **Cache the embedding on insert** — always set `raw_embedding` during
   the event INSERT, so retroactive categorization is free.

3. **Category centroids** — periodic job recomputes
   `categories.embedding = avg(raw_embedding)` over labeled events. For
   phase 2 you can run this synchronously on each relabel — a single SQL
   update.

4. **`/categories` CRUD** — full routes for managing categories +
   category_rules.

5. **Retroactive reclassify** — `POST /categories/:id/reclassify` runs all
   matching uncategorized events through the category's centroid again, in
   a single SQL update.

6. **Title regex rules** — extend the categorizer to try
   `title_regex` rules after `app_name` rules.

### Web work

1. **Categories page** (`/_auth/categories`)
   - List categories with color, productivity flag, rule count.
   - Add/edit/delete.
   - Rules sub-editor: per category, list of `{pattern_type, pattern}` rules.
   - Reclassify button.

2. **Uncategorized queue** — component listing the past week's events with
   `category_id IS NULL`, with inline relabel (select a category → POST
   `/events/:id/relabel`).

3. **CategoryPie chart** — daily breakdown by category.

### Phase 2 smoke test

- Add a category "Coding" with rule `app_name = Visual Studio Code`.
- Daemon's VS Code windows auto-match. Dashboard shows them green.
- Add a category "Research" with no rule. Relabel a Firefox window to
  "Research". Centroid gets updated.
- Next time a similar Firefox window appears it gets auto-categorized as
  "Research" via embedding similarity.

## Phase 3 — Habits

**Goal:** define habit loops, see streaks, get nudged.

### Schema additions (already in DB from phase 0)
- `habits` and `habit_checkins` tables are ready.

### API work

1. **`/habits` CRUD** — create/list/update/delete.
2. **`POST /habits/:id/checkin`** — record today's minutes (auto-derived if
   `linked_category_id` is set; else manual).
3. **`GET /habits/streak`** — current streak per habit.
4. **Auto-derived checkins** — a daily job (Bun cron or Vercel cron) reads
   yesterday's events, sums minutes per linked category, upserts
   `habit_checkins`.

### Web work

1. **Habits page** (`/_auth/habits`)
   - Create form (name, target minutes, cadence, linked category, color).
   - List with current streak + today's progress bar.
   - Manual checkin button (override the auto-derived value).
   - Streak heatmap (ECharts calendar).

2. **Dashboard integration** — habits strip at top of dashboard: today's
   habit progress in colored pills.

3. **Notifications** — daemon tray shows a notification when a habit's
   daily target is reached. (Optional / phase 3.5.)

### Phase 3 smoke test

- Create habit "Deep work — 120 min/day on weekdays linked to Coding
  category".
- After 2h of VS Code time in a day, the habit shows "achieved".
- Streak heatmap shows the past week.

## Phase 4 — AI suggestions

**Goal:** ask "why am I distracted at 3pm?" and get a grounded answer.
Surface weekly recaps. Find similar sessions.

### New deps

- `ai` (Vercel AI SDK) + `@ai-sdk/openai` (or `@ai-sdk/anthropic`).
- In `apps/api/package.json`:
  ```json
  "ai": "^4.0.0",
  "@ai-sdk/openai": "^1.0.0"
  ```

### API work

1. **`/suggest`** (streaming) — Hono SSE endpoint.
   - Receives a user question.
   - System prompt includes the user's recent activity summary (1 week of
     daily aggregates, top distracting apps, habit progress).
   - Streams tokens back via Vercel AI SDK's `streamText`.

2. **Tool calls** — give the model tools:
   - `query_events(filter)` — read events by date range / category.
   - `query_similar_sessions(embedding)` — pgvector nearest-neighbor over
     `raw_embedding` to find past "like this one" sessions.
   - `get_habits()` — current habit states.
   The model uses tools to ground its answer in your data.

3. **Weekly recap** — `POST /recap/generate` runs a longer analysis
   (non-streamed), saves the markdown to a `recaps` table.

### Schema additions

```sql
recaps (id, user_id, week_start date, markdown text, created_at)
```

### Web work

1. **Ask page** (`/_auth/ask`) — chat UI. Use `@ai-sdk/react`'s `useChat`
   hook with the `/suggest` endpoint as the route. Messages persist for the
   session.

2. **Recap page** (`/_auth/recap`) — generated weekly recap, readable
   markdown (use `react-markdown`).

3. **Suggestion cards** on dashboard — surfaces top 3 insights from the
   last recap ("You're 30% more distracted on Tuesdays; consider…").

### Phase 4 smoke test

- Ask "why am I distracted at 3pm?" — model calls `query_events`, returns
  grounded answer naming apps/categories.
- Generate weekly recap — markdown makes sense; references habit streaks.

## Phase 5 — SaaS hardening

**Goal:** real users beyond you. Billing, rate limits, deployment, monitoring.

### Deploy

1. **API** — Fly.io (Bun image available) or Render. Use `infra/docker/api.Dockerfile`
   with `oven/bun:1.1` base. Single process, autoscale on Fly.
2. **Web** — Vercel. TanStack Start has a Vercel preset.
3. **DB** — Neon main branch (already); enable Neon's point-in-time recovery
   for daily snapshots.
4. **Daemon** — GitHub releases with `go-selfupdate`. Users install via a
   shell script (`curl ... | sh`). Windows gets an MSI installer later (NSIS
   or WiX).

### Auth + multi-tenancy

1. **OAuth providers** — add GitHub + Google via better-auth plugins (you
   deferred these in phase 0).
2. **Email verification** — Resend with a real domain (verify DKIM/SPF).
   Replace the sandbox email.
3. **Row-level security** — Postgres RLS on every table `USING (user_id =
   current_setting('app.user_id')::uuid)`. Set via `SET LOCAL app.user_id
   = ...` in a per-request transaction. Belt-and-braces with the
   application-level scoping we already have.

### Billing

1. **Stripe** — subscribe plans (free / pro / unlimited). better-auth has
   a `stripe` plugin you can wire in.
2. **Quota enforcement** — per-plan limits on `/events` POST rate (e.g.
   1000/day free) and historical data retention (90 days free, unlimited
   paid).

### Observability

1. **Logs** — structured JSON to Axiom or Posthog.
2. **Metrics** — events/day per user, categorizer cache hit rate, embedding
   latency. Use Hono middleware to record.
3. **Sentry** — Bun supports Sentry; daemon uses a Go Sentry SDK.

### Daemon polish

1. **Auto-update** — `go-selfupdate` checks GitHub releases on startup, in
   the background. User gets a tray notification when updated.
2. **Installer scripts** — `install.sh` for Linux, `install.ps1` for
   Windows.
3. **Settings UI** — cross-platform tray→settings dialog (use `fyne` or
   `walk` on Windows, GTK on Linux). Or skip and rely on a config-file UI
   in the webapp.
4. **Multi-device per user** — daemon sends `device_id` in JWT; the server
   stores per-device `last_seen_at` and a devices list page already does
   the right thing.

### Phase 5 smoke test

- New user signs up with GitHub OAuth, verifies email, installs daemon on
  two devices, sees data from both on one dashboard.
- Free-tier rate limit kicks in after 1000 events/day; user sees a
  friendly upgrade modal.
- Daemon auto-updates when you publish a new release.

## How to use this doc

Pick the next phase you're starting. Re-read its section here, then break
the work into small commits (one feature per commit, smoke test per
feature). Don't skip the smoke tests — each one catches a class of bugs
that compounds later.

### When to revisit phase 0 decisions

- **Switching TanStack Start for Remix** if Start becomes a blocker → only
  the `apps/web` changes; everything else is untouched.
- **Switching Resend** for AWS SES or Postmark → only `apps/api/src/auth.ts`
  changes.
- **Switching Neon** for Supabase → schema is portable; just change the
  connection string and the `db.ts` driver import (Supabase uses the same
  pg driver).

The architecture is intentionally decomposed so each layer can be swapped
without reworking the others. That's the gift you gave yourself by
structuring it this way.