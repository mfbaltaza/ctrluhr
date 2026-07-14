# 06 — Phase 0 Smoke Test

Run this once you've completed steps 01–05. It's the end-to-end checklist
that proves the whole pipeline works together. If anything fails here,
don't move to phase 1 — fix it first.

## Setup before the test

Run these in three terminals:

**Terminal A — API**
```sh
cd apps/api
bun run src/index.ts
```
Waits on `:3001`. Confirms `Started Hono app on http://localhost:3001` (or
whatever Bun prints).

**Terminal B — Web**
```sh
cd apps/web
pnpm dev
```
Boots Vite/Vinxi on `:3000`.

**Terminal C — Daemon** (we'll start it after enrollment)

## Checklist

### 1. Health check
```sh
curl http://localhost:3001/healthz
```
Expected: `{"ok":true}`

### 2. Magic link login
- Open `http://localhost:3000/login` in your browser.
- Enter the email you signed up to Resend with (the only one sandbox will
  deliver to).
- Submit. You should see "Check your inbox".
- Open your inbox. Click the link.
- You should land on `/dashboard` (URL bar shows it). The page renders even
  though it's empty — that's fine.
- In browser DevTools → Application → Cookies → `http://localhost:3001`:
  you should see a `better-auth.session_token` (or similarly named) cookie.

If the cookie doesn't appear, you have a CORS / credentials issue — see
`04-web-setup.md` pitfalls.

### 3. Create a device
- Navigate to `/devices` (manually type the URL; nav comes later).
- Pick a name (`my-laptop`) and OS (`linux`).
- Click "Create device".
- A box appears with a long hex enrollment token. Copy it.
- The device appears in the list above (initially with `last_seen_at: null`).

### 4. Enroll the daemon
In Terminal C:
```sh
cd apps/daemon
go build -o ctrluhr . && ./ctrluhr enroll <token> my-laptop linux
```
Expected output: `Enrolled. Config saved.`

Verify `~/.config/ctrluhr/config.toml` contains `device_jwt = "ey..."`.

### 5. Run the daemon
```sh
./ctrluhr dev
```
You should see (after ~2s) actual events being emitted (if you add logs via
`fmt.Println`) and after ~10s the first batch flush attempt.

Watch the API log in Terminal A — a `POST /events` request should arrive
with status 200. If 401 — JWT is invalid/expired/mismatched. If 400 — batch
shape is wrong (check Zod validation response for `details`).

### 6. Verify the dashboard updates
Go back to the browser → `/dashboard`. Within 15s you should see:
- The stacked bar in the "current hour" position growing.
- The "min tracked" total at top-right incrementing.

If it stays empty: check the API logs for the `/analytics/day` call. If you
see the request returning buckets but the chart is blank — check the browser
console for errors. ECharts renders silently if the container has zero
height or the data array is all zeros.

### 7. Verify idempotency
Stop the daemon with Ctrl-C. Start it again. It will re-emit events with
random UUIDs — that's expected, they're new events. But the dashboard's
total should grow by the new set only, not double.

If you want a cleaner idempotency test: temporarily make the stub tracker
reuse a fixed UUID. Confirm the events count doesn't bloat after restart.

### 8. Verify offline buffering
- Stop the API (Terminal A).
- Run the daemon for ~30s (it will fail to flush — check stdout for
  `uplink: ...` errors).
- Start the API again.
- Within ~10s the daemon's flusher succeeds; events appear on the dashboard
  retroactively.

That's badger doing its job. If events are lost when the API is down, your
Drain + release logic is buggy — re-check `uplink/queue.go`.

### 9. Lint + typecheck the whole repo
```sh
cd /home/btz/Code/ctrluhr
pnpm exec nx run-many -t lint typecheck
```
Everything green. If Biome complains, fix; don't disable rules.

### 10. Build everything
```sh
pnpm exec nx run-many -t build
```
- `@ctrluhr/schema` — tsc no-op (TS only)
- `@ctrluhr/api` — bun build artifacts in `apps/api/dist/`
- `@ctrluhr/web` — vinxi build in `apps/web/.output/` (or wherever vinxi puts it)
- `daemon` — `dist/ctrluhr-linux-amd64` and `dist/ctrluhr-windows-amd64.exe`

The Windows cross-compile works because Go is cool like that. You won't be
able to run the .exe on Linux, but it should compile cleanly. If your glibc
version or CGO flags cause issues, set `CGO_ENABLED=0` in the build command.

## 11. Final commit
```sh
git add -A
git commit -m "chore: phase 0 smoke test passing"
git tag phase-0-complete
```

Tag it. When phase 3 goes off the rails you'll be grateful for a known-good
rollback point.

## What phase 0 does NOT need to do

Don't aim for these in this phase; they belong to later phases:
- Real window tracking (phase 1)
- Embedding-based categorization (phase 2)
- Hourly breakdown in /analytics/day (phase 1)
- Habit features (phase 3)
- AI suggestions (phase 4)
- Beautiful UI/polish (any time)
- Tests beyond the smoke test (when needed)

If you find yourself drifting to one of these, stop and finish phase 0 first.

## Phase 0 success = pipeline works end-to-end

The whole point of phase 0 was to de-risk the architecture. You now have:
- Auth working across web + API + device
- A category-agnostic persistence layer that can grow
- A queue that survives network hiccups
- A dashboard that reflects reality in <30s

From here, every phase adds features on top of a known-good foundation. If
phase 1 introduces a bug in the real-tracker, you know the rest of the
system is fine because phase 0 still works (you can revert the daemon and
re-run the stub to confirm).

## Next: read `07-future-phases.md`

Pick a phase, work through it. Each phase has its own design notes, schema
changes, and a smoke test at the end. Don't start a phase without
re-reading the relevant section — they reference the current schema and
API shape which may have evolved.