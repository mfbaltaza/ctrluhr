# 07 — Future Phases (1–5): the map

A **lean map** of what comes after phase 0 — not a build doc. Per ADR-0007,
the full 8-field build doc for a phase is written **when that phase starts**,
fed by a fresh `/research` pass over the official docs this map points at.
Fast-moving libraries (TanStack Start pre-1.0, better-auth, Vercel AI SDK)
are documented at build time, not frozen here early.

Each phase block gives you:
- **Goal** — what the phase makes true.
- **Entry criteria** — runnable-ish checks that must pass before you start
  (a state check against the previous phase's Produces).
- **Constraining decisions** — the ADRs and non-negotiables that shape the
  phase. Check these before re-litigating anything.
- **Research pointers** — official docs to read when you write the build
  doc. Verify they're still current at that time.

> The library references here are starting points, not facts. Things move:
> verify each against its official docs when the phase starts.

---

## Phase 1 — Real tracking

**Goal:** replace the stub tracker with real window polling (Hyprland/X11 +
Windows). The dashboard shows your actual day, not fixtures.

**Entry criteria:**
- [ ] Phase 0 exit gate (`06`) fully green, tagged `phase-0-complete`.
- [ ] Client-side encryption shipped **before any real tracking**: the
      daemon encrypts `app_name`/`window_title` client-side (ADR-0002).
      This is a hard gate — plaintext titles must never hit the server.
- [x] Pre-phase-1 migration batch applied: `devices.status` added,
      `api_token_hash` dropped (ADR-0005), `activity_events.productive`
      dropped (ADR-0004), `users.timezone` added (ADR-0003). The schema is
      then the ADR-0007-clean target that `00` §4 documents.

**Constraining decisions:**
- ADR-0002 (encryption gate), ADR-0003 (user-local days — analytics now
  real), ADR-0005 (revoke + per-batch status check; rotation = revoke +
  re-enroll).
- Tray is a phase-0 stub; the real tray (systray) lands here
  (`05`'s adjudication list).
- Linux tracker targets your Hyprland first; a non-Hyprland move needs
  tracker work later (`00` §10 risk 2).

**Research pointers:**
- Hyprland IPC (`hyprctl activewindow -j`,
  `HYPRLAND_INSTANCE_SIGNATURE`) — https://wiki.hyprland.org/IPC/
- X11 fallback (`_NET_ACTIVE_WINDOW`, WM_NAME) — https://github.com/jezek/xgb
- Windows (`GetForegroundWindow` + `GetWindowTextW`) —
  https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getforegroundwindow
- Idle detection: X11 `xprintidle`, Windows `GetLastInputInfo`
- ECharts heatmap (week view) — https://echarts.apache.org/en/option.html#series-heatmap
- Postgres `extract(hour from ...)` for the hourly breakdown —
  https://www.postgresql.org/docs/current/functions-datetime.html

**Exit gate:** real events for a full work day look sensible on the
dashboard; idle pauses emission; a browser tab's title is tracked (no URL —
`00` §10 risk 3).

---

## Phase 2 — Categorization

**Goal:** stop leaving everything "Uncategorized". Rules + similarity
auto-categorize most events; you relabel the rest in the UI.

**Entry criteria:**
- [ ] Phase 1 done; the daemon emits real (encrypted) events.
- [ ] The `category_rules` composite-PK + `priority` design (`00` §4) is
      confirmed or revised, and rules evaluation order decided.

**Constraining decisions:**
- ADR-0002 supersedes the original server-side embeddings pipeline **in
  full**: rules run **in the daemon** (plaintext is local there); embedding
  matching is **browser-mediated** — BYOK by default (browser calls OpenAI
  with the User's own key), a **proxied** opt-in tier that is transient
  (never persisted/logged server-side), and manual Relabel as the
  always-available floor. The phase-2 build doc is written **from the ADR**,
  not from the old 07 detail below.
- `raw_embedding` / `categories.embedding` keep their columns but have no
  server-side role; pgvector's future is re-evaluated here (`00` §4).
- The `is_productive` check constraint and live-read productivity
  (ADR-0004) mean relabeling a category corrects history for free.

**Research pointers:**
- Rules in the daemon: see `05`'s tracker/config sections for where they
  hook in.
- Browser-mediated embedding: OpenAI Embeddings API —
  https://platform.openai.com/docs/api-reference/embeddings
- pgvector (only if BYOK/proxied design needs server-side similarity later)
  — https://github.com/pgvector/pgvector

**Exit gate:** a rule auto-categorizes the daemon's real events; a no-rule
category fills via relabel + similarity; the Uncategorized queue stays
small.

---

## Phase 3 — Habits

**Goal:** habit loops with streaks. Define a habit, see daily progress, get
nudged.

**Entry criteria:**
- [ ] Phase 2 done (categories are real, so habits have something to link).
- [ ] `users.timezone` in use — day-bucketing is genuinely User-local
      (ADR-0003) before streaks can be trusted.

**Constraining decisions:**
- ADR-0003: check-ins and streaks bucket by the User's timezone; changing
  the setting later does not rewrite history.
- `habits`/`habit_checkins` already exist in the schema (`00` §4) —
  including `habits.cadence` (only `'daily'` is meaningful yet; `00` §4).
- Manual check-ins are sticky and never overwritten by auto-derivation
  (CONTEXT.md, Check-in).
- Streaks are derived at query time, never stored (CONTEXT.md, Streak).

**Research pointers:**
- Daily check-in job: Bun scheduler or `node-cron`.
- Streak heatmap (ECharts calendar) — https://echarts.apache.org/en/option.html#series-calendar
- TanStack Query optimistic updates for the check-in button —
  https://tanstack.com/query/latest/docs/framework/react/guides/optimistic-updates

**Exit gate:** a "Deep work — 120 min/day linked to Coding" habit goes
"achieved" on a real 2h day; streak heatmap renders the past week.

---

## Phase 4 — AI suggestions

**Goal:** ask "why am I distracted at 3pm?" and get a grounded answer; a
weekly recap; similar-session lookup.

**Entry criteria:**
- [ ] Phase 3 done (habits feed the AI's context).
- [ ] Encryption design intact: the server never sees plaintext content.

**Constraining decisions:**
- ADR-0002 supersedes server-side AI over plaintext events. AI features are
  **client-mediated**: the browser decrypts in-session and talks to the
  provider directly (BYOK/proxied tiers as in phase 2). No server-side
  prompts over user content. The phase-4 build doc is written **from the
  ADR**, not the old server-side design.

**Research pointers:**
- Vercel AI SDK `streamText` — https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text
- `@ai-sdk/react` `useChat` — https://ai-sdk.dev/docs/reference/ai-sdk-react/use-chat
- Hono streaming helpers — https://hono.dev/docs/helpers/streaming
- `react-markdown` for recap rendering — https://github.com/remarkjs/react-markdown

**Exit gate:** "why am I distracted at 3pm?" returns a grounded answer
naming apps/categories; a weekly recap renders and references habit streaks.

---

## Phase 5 — SaaS hardening

**Goal:** real users beyond you. Billing, rate limits, deployment,
observability, multi-device polish.

**Entry criteria:**
- [ ] Phase 4 done and the single-user instance is stable.
- [ ] Open-signup posture confirmed (ADR-0001) and the encryption gate is
      airtight before strangers' data arrives.

**Constraining decisions:**
- ADR-0001 (multi-user self-hosted posture; Operator hosts, many Users),
  ADR-0002 (the server holds only ciphertext for content fields).
- Row-level security as belt-and-braces over the app-level scoping that
  already exists (RLS `USING (user_id = current_setting('app.user_id'))`).

**Research pointers:**
- better-auth OAuth (GitHub/Google) — https://www.better-auth.com/docs/authentication/social
- better-auth Stripe plugin — https://www.better-auth.com/docs/plugins/stripe
- Postgres Row-Level Security — https://www.postgresql.org/docs/current/ddl-rowsecurity.html
- Fly.io (API) — https://fly.io/docs/languages-and-frameworks/bun/
- Vercel (web) — https://vercel.com/docs/frameworks/tanstack-start
- `go-selfupdate` for the daemon — https://github.com/minio/selfupdate
- Sentry for Bun + Go

**Exit gate:** a second User signs up via OAuth, verifies email, installs
the daemon on two devices, sees both on one dashboard; a rate limit kicks
in with a friendly upgrade path; the daemon auto-updates from a release.

---

## How to use this map

Pick the next phase. Re-read its block, run its entry criteria, then write
the phase build doc per the convention (`docs/README.md`, ADR-0007) with a
fresh `/research` pass. One feature per commit; a phase exit gate per phase.

### When to revisit phase 0 decisions

- **Switching TanStack Start for Remix** if Start becomes a blocker → only
  `apps/web` changes; everything else is untouched.
- **Switching Resend** for AWS SES or Postmark → only
  `apps/api/src/auth.ts` changes.
- **Switching Neon** for Supabase → the schema is portable; change the
  connection string and the driver import.

The architecture is intentionally decomposed so each layer can be swapped
without reworking the others.
