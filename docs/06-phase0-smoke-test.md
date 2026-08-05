# 06 — Phase 0 Smoke Test (executable exit gate)

Run this once you've completed `01`–`05`. It is the end-to-end gate that
proves the whole pipeline works together. Every item is a runnable check
with an expected output — nothing here is guesswork. If anything fails, don't
move to phase 1; fix it first.

This file is a **manual test plan, not a build doc** — there are no new
libraries to learn. Where a check touches a component explained elsewhere,
it links to that doc so you can re-read the design if you need context.

Note on form: this gate intentionally follows the executable
exit-gate/checklist pattern — the prior art named in spec issue #5's Testing
Decisions — not per-step 8-field blocks, because it is the gate that
exercises the steps docs 01–05 build. Code-fix items surface as failing
checks (see the Adjudication list), not as `[pending]` markers.

## Pre-flight

### 0. Pre-requisite: the enrollment migration is applied

The plan-first parts of `03` §6 need a schema that phase 0's early build
doesn't have yet: the `enrollment_tokens` table, `devices.status`, the drop
of `devices.api_token_hash` and `activity_events.productive` (ADR-0005,
ADR-0004). `03` §6's Assumes tell you how to generate + apply that
migration. **Do not start this test without it** — the device-enroll checks
below will fail against the old schema.

### 1. Three terminals

**Terminal A — API** (`03-api-setup.md` §4, the Hono bootstrap):
```sh
cd apps/api
bun run src/index.ts
```
Expected: Hono listens on `:3000`; `/healthz` answers (check 1).

**Terminal B — Web** (`04-web-setup.md`, the TanStack Start dev server):
```sh
cd apps/web
pnpm dev
```
Expected: Vite dev server on `:5173`.

**Terminal C — Daemon** (`05-daemon-setup.md`): started at check 4, run at
check 5.

## The gate

### 2. API health

```sh
curl http://localhost:3000/healthz
```
Expected: `{"ok":true}`.

If this fails, the API isn't serving. Re-read `03-api-setup.md` §4.

### 3. Magic-link login

- Open `http://localhost:5173/login` in a browser.
- Enter the email Resend's sandbox will deliver to (`03-api-setup.md` §3).
- Submit → you see "Check your inbox".
- Open the email, click the link.
- Expected: you land on `/dashboard` (the URL bar shows it) and the page
  renders, even though it's empty.
- In browser DevTools → Application → Cookies, you should see a
  `better-auth.session_token` (or similarly named) cookie.

If no cookie appears, you have a CORS/credentials issue — see
`04-web-setup.md`'s pitfalls on `auth.getSession()` not returning a session,
and the better-auth CORS/cookie sections it links.

### 4. Create a Device → Enrollment Token

- Navigate to `/devices` (type the URL; nav comes later).
- Pick a name (`my-laptop`) and OS (`linux`).
- Click "Create device".
- Expected: a box appears with a long hex Enrollment Token (~30-minute
  expiry). Copy it. The device does **not** appear in the list yet — the row
  is created at enroll time (`03-api-setup.md` §6.2).
- If the device *does* appear immediately with no token flow, the API is
  still on the old `api_token_hash` design — re-check check 0.

This exercises `03-api-setup.md` §6 (`POST /devices`) end-to-end.

### 5. Enroll the daemon

In Terminal C:
```sh
cd apps/daemon
go build -o ctrluhr . && ./ctrluhr auth enroll <token>
```
Expected output: `Enrolled. Config saved.`

Then verify the key landed owner-only:
```sh
cat ~/.config/ctrluhr/config.toml
```
Expected: contains `device_jwt = "ey..."` and the device name/OS from the
web form. If the token was already used or expired you get 401 — re-create
a Device in the web app and try again (`05-daemon-setup.md`, enroll
pitfalls).

### 6. Run the daemon → events flow

In Terminal C:
```sh
./ctrluhr dev
```
- Within ~2s the stub tracker emits synthetic events.
- Within ~10s the first batch flush happens: **watch Terminal A's API log**
  — a `POST /events` request arrives.

Expected statuses, and what they mean:
- **200** — ingest OK.
- **401** — Device Key rejected (re-check enroll + revocation; `05` §8).
- **400** — batch shape wrong; check the Zod `flatten()` details in the
  response (`03-api-setup.md` §7).

### 7. Dashboard reflects events

Back in the browser → `/dashboard`. Within ~30s you should see:
- The stacked bar in the "current hour" position growing.
- The "min tracked" total incrementing.

If it stays empty: check Terminal A for the `/analytics/day` call. If the
request returns buckets but the chart is blank, check the browser console —
ECharts renders silently when the container has zero height or the data is
all zeros (`04-web-setup.md`, ECharts pitfalls).

### 8. Idempotent replay

- Stop the daemon (Ctrl-C), start it again.
- The stub re-emits new events — expected.
- Expected: the dashboard total grows by the new set only; no duplicates.
  This is the `onConflictDoNothing` guarantee (`03-api-setup.md` §7).
- For a cleaner test: temporarily make the stub reuse a fixed event id,
  restart twice, and confirm the count doesn't bloat at all.

### 9. Offline buffering (badger)

- Stop the API (Terminal A).
- Run the daemon for ~30s — it fails to flush; check stdout for
  `uplink:` errors. That's fine.
- Start the API again.
- Expected: within ~10s the flusher drains; the dashboard shows the events
  retroactively.

If events are lost while the API was down, your Drain/release logic is
buggy — re-check `05-daemon-setup.md` §4 against the reference.

### 10. Revocation kills ingest

- In the web app's `/devices`, revoke `my-laptop` (ADR-0005).
- Expected: the daemon's **next** `POST /events` gets `401` and it halts
  (no retry loop). A re-enrolled Device gets a fresh id + key.

This is the per-batch status check (`03-api-setup.md` §5, `05-daemon-setup.md`
§5). If a Revoked Device keeps ingesting, the device middleware isn't reading
`devices.status` — the ADR-0005 promise is not yet true.

### 11. Repo gates

```sh
pnpm --filter @ctrluhr/api typecheck
pnpm --filter @ctrluhr/web typecheck
cd apps/daemon && go build ./... && go vet ./...
```
Expected: all green. Then the build:
```sh
pnpm exec nx run-many -t build
```
Expected: green except `@ctrluhr/schema` — it has no `tsconfig.json`, so its
`build`/`typecheck` fail (documented in `01`, adjudication list). **That, and
the repo-wide `biome check .` lint debt from the 02–04 code, are known
blockers** — they become the first code-fix tickets of the phase-1 queue.
The gate counts as passed when the only red is those two documented items,
each with a ticket.

### 12. Final commit + tag

```sh
git add -A
git commit -m "chore: phase 0 smoke test passing"
git tag phase-0-complete
```
Tag it. When phase 3 goes off the rails you'll be grateful for a
known-good rollback point.

## What phase 0 does NOT need to do

These belong to later phases (see `07-future-phases.md`):
- Real window tracking (phase 1)
- Embedding-based categorization (phase 2)
- Hourly breakdown in `/analytics/day` (phase 1)
- Habit features (phase 3)
- AI suggestions (phase 4)
- Beautiful UI/polish (any time)
- Tests beyond the smoke test (when needed)

If you find yourself drifting to one of these, stop and finish phase 0
first.

## Phase 0 success = pipeline works end-to-end

The whole point of phase 0 was to de-risk the architecture. You now have:
- Auth working across web + API + device
- A category-agnostic persistence layer that can grow
- A queue that survives network hiccups
- A dashboard that reflects reality in <30s
- A revocation path that actually cuts ingest

From here, every phase adds features on top of a known-good foundation. If
phase 1 introduces a bug in the real tracker, you know the rest of the
system is fine because phase 0 still works (revert the daemon, re-run the
stub, confirm).

## Adjudication list

This doc is an executable gate, so drift items surface as failing checks
rather than as `[pending]` markers. One line each, with a recommendation:

1. **Pre-phase-1 schema migration batch not applied** — check 0 fails against
   the old schema (`api_token_hash`, no `devices.status`). The pending
   code-fix ticket is the batch: `enrollment_tokens` table, `devices.status`,
   drop `devices.api_token_hash`, drop `activity_events.productive`
   (ADR-0005, ADR-0004), add `users.timezone` (ADR-0003). `03` §6's Assumes
   show how to generate + apply it.
2. **`@ctrluhr/schema` build/typecheck red** — no `tsconfig.json`, so check
   11's `nx run-many -t build` stays red on schema only (01 adjudication list
   item 1). Recommendation: code-fix ticket; the gate passes when the only
   red is this plus the biome lint debt, each with a ticket.
3. **Repo-wide `biome check .` lint debt** — files built by docs 02–04 (check
   11). Recommendation: code-fix ticket (`biome check --write .` once 02–04
   are rebuilt; 01 adjudication list item 2).

## Next: `07-future-phases.md`

Pick a phase. When you start one, **write its build doc** following the
convention in `docs/README.md` (ADR-0007) — 8-field steps, fed by a fresh
`/research` pass over the official docs the phase map points at. Each phase
has its own entry criteria, constraining ADRs, and exit gate (in `07`).
