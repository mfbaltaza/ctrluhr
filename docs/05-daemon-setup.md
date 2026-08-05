# 05 — Daemon Setup (Go, stub tracker)

Goal: a Go binary you can run that:
- Loads a `Config` from `~/.config/ctrluhr/config.toml` (endpoint + Device Key)
- Emits synthetic Activity Events from a fixture file and POSTs them to the API
  in gzipped batches
- Has an `enroll` subcommand that exchanges an Enrollment Token for a
  long-lived Device Key (JWT) and writes it to config
- Has a system-tray icon with Pause / Resume / Quit — or a clean stub; see
  Step 8 and the Open decisions list

"Stub tracker" means: no real window polling, just a fixture-driven emitter.
Phase 1 swaps in real Hyprland/X11/Windows trackers behind the same
`Tracker` interface (see `07-future-phases.md`).

> Assumes `01-monorepo-setup.md` (daemon scaffold), `03-api-setup.md` §5–§7
> (device auth, `/devices/enroll`, `/events`), and `04-web-setup.md` §6.2
> (the `/devices` page that issues Enrollment Tokens) are done. The API is
> reachable at `http://localhost:3000`.

## Plan-first note

`apps/daemon` holds only the scaffold — `go.mod`, a stub `main.go`, and
`project.json`. Everything in this file except Step 1.1 is **plan-first**:
verified against the ADRs (`docs/adr/0002`, `docs/adr/0005`), the plan
(`docs/00-plan-overview.md` §3 device-auth flow, §7 repo layout), and the
API's documented wire format (`03` §5–§7, `packages/schema/src/event.ts`),
not against built code. Reference blocks are sanity-check targets — if a
snippet and the official docs disagree, the docs win.

## Conventions we use

- **Imports use the full module path.** The module is
  `github.com/btz/ctrluhr/daemon` (`go.mod`, from `01` Step 7), so internal
  imports are `github.com/btz/ctrluhr/daemon/tracker`, never `daemon/tracker`.
  Mixing short and full paths fails the build.
- **`Tracker` and the queue are the seams.** They stay stable so phase 1 can
  drop in real trackers without touching `main`, the queue, or the client.
- **Times are emitted in UTC (`...Z`).** The API validates `started_at` /
  `ended_at` with `z.string().datetime()`, which accepts the UTC `Z` form
  but not a `+02:00` offset. A `time.Time` marshals to its own location, so
  call `.UTC()` before emitting (Step 3.1).
- **The Device Key never leaves `config.toml`** except into the
  `Authorization: Bearer` header (00 §3).

## The enrollment flow (read first)

This is the flow the whole doc is built around; it must match `00` §3 and
`03` §6 exactly. Do not re-design it.

1. An authed User creates a Device in the web app's `/devices` page →
   `POST /devices` returns a one-time Enrollment Token (64 hex chars,
   30-minute expiry; no device row exists yet).
2. The User runs `ctrluhr auth enroll <token>` on the daemon machine. The
   token carries the requested name/OS — no CLI args needed.
3. The daemon calls `POST /devices/enroll` with the token → the API creates
   the device row and returns `{ device_id, device_key, name, os }`.
   `device_key` **is** the long-lived Device Key (a JWT). There is no
   `api_token_hash` dance —
   that column is dropped (ADR-0005).
4. The daemon presents `Authorization: Bearer <jwt>` on every `/events`
   POST.
5. The API verifies the JWT signature *and* the device's `status` on every
   batch (ADR-0005). A Revoked device gets `401 { error: 'device revoked' }`
   immediately — the daemon should halt, not retry. Rotation is revoke +
   re-enroll.

## 1. Confirm the scaffold and load dependencies

### 1.1 Confirm the scaffold (the only code-backed step)

**Assumes**

- `01-monorepo-setup.md` Step 7 done: `apps/daemon/go.mod` declares
  `module github.com/btz/ctrluhr/daemon`, and a stub `apps/daemon/main.go`
  exists with a `dev` subcommand (produced by `01` Step 7).
- `apps/daemon/project.json` exists with `build` / `dev` / `test` / `lint` /
  `typecheck` targets (produced by `01` Step 6).

**Do**

Confirm the scaffold is exactly what Step 8 of `01` left behind, so later
steps build on the right shape. `go.mod` should contain only the module
line and the `go` directive (`go 1.26.5` at the time of writing — the repo
is truth here, not this doc). `main.go` is a stub that prints a message for
`dev` and a usage hint otherwise; Step 7 replaces it.

**Verify**

```sh
cd apps/daemon
go build ./... && echo OK
go run . dev
```

Expected: `OK`, then the stub prints `ctrluhr daemon dev mode (stub tracker)`
and `noop - fill me in during 05-daemon-setup.md`. If the build fails, the
scaffold drifted — re-read `01` Step 7.

**Produces**

A compiling, single-package scaffold (`main` package in `main.go` only).

### 1.2 Load the daemon's dependencies

**Assumes**

- Step 1.1 passed. `apps/daemon/go.sum` does not exist yet (no deps).

**Read first**

1. **go-toml/v2** — https://github.com/pelletier/go-toml/tree/v2
   Read the README's "Getting started" (Unmarshaling + Marshaling). Two
   functions, `toml.Marshal` / `toml.Unmarshal`; struct tags follow
   `encoding/json` conventions. That is the whole API we use.
2. **google/uuid** — https://pkg.go.dev/github.com/google/uuid
   One function: `uuid.NewString()`. That is all.
3. **badger v4** — https://github.com/dgraph-io/badger
   README only for now: what it is (embedded pure-Go KV store), the
   `go get github.com/dgraph-io/badger/v4` line, and the requirement of
   Go 1.23+ (our `go 1.26.5` satisfies it). The transaction/iteration API
   is read in Step 4.
4. **getlantern/systray** — https://github.com/getlantern/systray
   README only for now: `systray.Run(onReady, onExit)`, the cgo
   requirement, and the Linux dev-header requirement. Read the full API
   only if you keep the tray (Step 8).

**Do**

From `apps/daemon/`:

```sh
go get github.com/pelletier/go-toml/v2
go get github.com/google/uuid
go get github.com/dgraph-io/badger/v4
go get github.com/getlantern/systray
```

Why each:

- **go-toml/v2** — config load + save (Step 2). We use both `Marshal` and
  `Unmarshal`, so a TOML library beats hand-rolling.
- **google/uuid** — client-side event IDs. The daemon generates the UUID;
  the API's `ON CONFLICT (id) DO NOTHING` makes replays idempotent
  (03 §7, ADR-0006). Without a stable client-generated id, a retried
  batch would duplicate rows.
- **badger/v4** — the embedded queue between restarts (Step 4). Pure Go,
  so it works on every target the daemon builds for.
- **getlantern/systray** — the tray (Step 8). This is the only dependency
  with build friction (cgo); Step 8 and the Open decisions list cover
  whether it survives the phase-0 build.

We deliberately **do not** add an HTTP client library (resty etc.). One
`net/http` POST per 10s needs nothing more, and the queue is the retry
mechanism — retry-with-backoff inside the client would be redundant.

**Verify**

```sh
cd apps/daemon
go mod tidy
go build ./... && go vet ./...
go list -m all | rg 'pelletier/go-toml|google/uuid|dgraph-io/badger|getlantern/systray'
```

Expected: build and vet exit clean; `go list -m all` shows the four modules.
`go get` picks the latest tagged versions — if a version's API has drifted
from what Steps 2–5 show, the official docs win and this doc gets corrected.

**Produces**

`go.mod` + `go.sum` with the four dependencies. **[commit]** after this
step: `git add -A && git commit -m "chore(daemon): add go-toml/v2, uuid, badger/v4, systray deps"`.

## 2. Config

### 2.1 Write the config package

**Assumes**

- Step 1.2 done (go-toml/v2 in `go.mod`).

**Read first**

1. **go-toml/v2 — `Marshal` / `Unmarshal`** —
   https://pkg.go.dev/github.com/pelletier/go-toml/v2#Marshal
   The two functions and the struct-tag rule. Also note the `omitempty`
   behavior in the README if you add optional fields later.
2. **`os.UserConfigDir`** — https://pkg.go.dev/os#UserConfigDir
   Returns `$XDG_CONFIG_HOME` (or `~/.config`) on Linux, `%AppData%` on
   Windows. Do not hardcode `~/.config`.
3. **`os.MkdirAll` + `os.WriteFile`** — https://pkg.go.dev/os#MkdirAll
   `0o755` for the directory, `0o600` for the file that holds the Device
   Key.

**Do**

Write `config/config.go`: a `Config` struct with TOML tags, a
`DefaultPath()`, a `Load()` with defaults, and a `Save()`.

The two bits that matter and why:

- **The file is `0o600`.** `config.toml` holds the long-lived Device Key.
  World-readable would leak the key to any local process/user.
- **`os.UserConfigDir()` + `os.MkdirAll`.** On a fresh install the
  `ctrluhr/` dir does not exist; `DefaultPath` creates it so `Save` never
  fails on a missing directory. Defaults fill in `Endpoint`
  (`http://localhost:3000`), `PollIntervalMS` (1000), and `FixturesPath`
  (`tracker/fixtures.json`, relative to the `apps/daemon` cwd) so a bare
  config file still works.

`Load()`'s error message should point at `enroll` — a user running the
daemon before enrolling should be told exactly what to do.

**Reference**

```go
// apps/daemon/config/config.go — REFERENCE ONLY

package config

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/pelletier/go-toml/v2"
)

// Config is persisted to ~/.config/ctrluhr/config.toml.
// DeviceJWT is the long-lived Device Key the daemon presents as
// `Authorization: Bearer <jwt>` on every /events POST (00 §3, ADR-0005).
type Config struct {
	Endpoint       string `toml:"endpoint"`
	DeviceID       string `toml:"device_id"`
	DeviceJWT      string `toml:"device_jwt"`
	DeviceName     string `toml:"device_name"`
	DeviceOS       string `toml:"device_os"`
	PollIntervalMS int    `toml:"poll_interval_ms"`
	FixturesPath   string `toml:"fixtures_path"`
}

func DefaultPath() (string, error) {
	home, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(home, "ctrluhr")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	return filepath.Join(dir, "config.toml"), nil
}

func Load() (*Config, error) {
	path, err := DefaultPath()
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("no config at %s - run 'ctrluhr auth enroll <token>' first: %w", path, err)
	}
	var c Config
	if err := toml.Unmarshal(data, &c); err != nil {
		return nil, err
	}
	if c.Endpoint == "" {
		c.Endpoint = "http://localhost:3000"
	}
	if c.PollIntervalMS == 0 {
		c.PollIntervalMS = 1000
	}
	if c.FixturesPath == "" {
		c.FixturesPath = "tracker/fixtures.json"
	}
	return &c, nil
}

func (c *Config) Save() error {
	path, err := DefaultPath()
	if err != nil {
		return err
	}
	data, err := toml.Marshal(c)
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o600)
}
```

**Verify**

```sh
cd apps/daemon
go build ./... && go vet ./config
```

Expected: exit clean. (The file's behavior is exercised for real in Step 6
via `enroll`, which calls `Save`.)

**Produces**

`config/config.go` — the `config` package.

## 3. Tracker interface + stub

### 3.1 `Event` — the wire format

**Assumes**

- Step 1.2 done (google/uuid available).
- `packages/schema/src/event.ts` exists with `ActivityEventSchema` (produced
  by `03` §2).

**Read first**

1. **`encoding/json` — `Marshal`** — https://pkg.go.dev/encoding/json
   The struct-tag rule and how `time.Time` marshals (RFC 3339, in the
   time's own location).
2. **google/uuid — `NewString`** —
   https://pkg.go.dev/github.com/google/uuid#NewString
   Generates an RFC 4122 v4 UUID string.

**Do**

Define `tracker.Event` in a new `tracker` package. This struct is the
daemon's internal representation *and* the wire format: its JSON tags match
`ActivityEventSchema` exactly, so `json.Marshal` produces a batch element the
API will accept.

Two constraints from the API's schema, and why:

- **`id` must be a UUID string** (`z.string().uuid()`). The daemon generates
  it with `uuid.NewString()` per event. This is what makes ingestion
  idempotent — the same id on replay hits `ON CONFLICT (id) DO NOTHING`
  instead of inserting a duplicate (03 §7).
- **`started_at` / `ended_at` must end in `Z`.** The API's
  `z.string().datetime()` rejects offset forms. `time.Time` marshals in its
  own location, so an event stamped in your local timezone would be rejected
  with a 400. Emit `.UTC()` times everywhere (Step 3.2 does).

**Reference**

```go
// apps/daemon/tracker/event.go — REFERENCE ONLY

package tracker

import "time"

// Event is one recorded span of focus on this device. The id is generated
// client-side so the API's ON CONFLICT (id) DO NOTHING makes replays
// idempotent (03 §7). JSON tags match ActivityEventSchema in
// packages/schema/src/event.ts.
type Event struct {
	ID          string    `json:"id"`
	AppName     string    `json:"app_name"`
	WindowTitle string    `json:"window_title"`
	StartedAt   time.Time `json:"started_at"`
	EndedAt     time.Time `json:"ended_at"`
}
```

**Verify**

```sh
cd apps/daemon
go build ./... && go vet ./tracker
```

Expected: exit clean.

**Produces**

`tracker/event.go` — the `tracker` package with the `Event` type.

### 3.2 `Tracker` interface + `StubTracker`

**Assumes**

- Step 3.1 done.

**Read first**

1. **Go — channels** — https://go.dev/tour/concurrency
   The "Channels" section only. The pattern: the tracker blocks writing to
   a channel; `main` reads from it.
2. **`time.After` / `time.Until`** — https://pkg.go.dev/time#After
   The scheduling primitive for the stub.

**Do**

The `Tracker` interface is deliberately one method: `Run(ctx, out)`. It is
the seam phase 1 plugs real trackers into (`HyprTracker`, `X11Tracker`,
`WindowsTracker` per `07-future-phases.md`) — the interface must not grow
phase-1 concerns now.

`StubTracker` reads a JSON fixture list, then for each entry waits until
`start_offset_sec` after daemon start and emits an `Event` on `out`. With
`LoopForever: true` it repeats the list indefinitely, so the dashboard's
15s auto-refresh always has fresh data. The `select` on `ctx.Done()` is what
makes shutdown clean: cancel the context and the tracker unwinds instead of
blocking forever on a channel send.

Emit `StartedAt`/`EndedAt` as `.UTC()` per Step 3.1.

**Reference**

```go
// apps/daemon/tracker/tracker.go — REFERENCE ONLY

package tracker

import "context"

// Tracker emits Activity Events on out until ctx is cancelled.
// Implementations:
//   - StubTracker (phase 0): reads fixtures.json (Step 3.3)
//   - HyprTracker / X11Tracker / WindowsTracker (phase 1, 07-future-phases.md)
type Tracker interface {
	Run(ctx context.Context, out chan<- Event) error
}
```

```go
// apps/daemon/tracker/stub.go — REFERENCE ONLY

package tracker

import (
	"context"
	"encoding/json"
	"os"
	"time"

	"github.com/google/uuid"
)

type stubEntry struct {
	AppName        string `json:"app_name"`
	WindowTitle    string `json:"window_title"`
	StartOffsetSec int    `json:"start_offset_sec"`
	DurationSec    int    `json:"duration_sec"`
}

type StubTracker struct {
	FixturesPath string
	LoopForever  bool
}

func (s *StubTracker) Run(ctx context.Context, out chan<- Event) error {
	data, err := os.ReadFile(s.FixturesPath)
	if err != nil {
		return err
	}
	var entries []stubEntry
	if err := json.Unmarshal(data, &entries); err != nil {
		return err
	}

	start := time.Now().UTC()
	for {
		for _, e := range entries {
			fireAt := start.Add(time.Duration(e.StartOffsetSec) * time.Second)
			select {
			case <-ctx.Done():
				return nil
			case <-time.After(time.Until(fireAt)):
				out <- Event{
					ID:          uuid.NewString(),
					AppName:     e.AppName,
					WindowTitle: e.WindowTitle,
					StartedAt:   fireAt.UTC(),
					EndedAt:     fireAt.Add(time.Duration(e.DurationSec) * time.Second).UTC(),
				}
			}
		}
		if !s.LoopForever {
			break
		}
		start = time.Now().UTC()
	}
	return nil
}
```

**Verify**

```sh
cd apps/daemon
go build ./... && go vet ./tracker
```

Expected: exit clean. (Emission is exercised end-to-end in Step 9.1 — the
stub isn't reachable until `main` wires it up in Step 7.)

**Produces**

`tracker/tracker.go` + `tracker/stub.go`.

### 3.3 `fixtures.json` — a synthetic day

**Assumes**

- Step 3.2 done (the stub reads this file).

**Do**

Write `tracker/fixtures.json`: a ~30-minute snippet of plausible activity.
Each entry fires `start_offset_sec` after daemon start and lasts
`duration_sec`. `LoopForever: true` makes the stub replay the block, so the
dashboard always has data in its "current hour" bucket. Keep titles short —
they are plaintext in phase 0; from phase 1 the daemon encrypts content
fields client-side (ADR-0002), and this file stops being the source.

**Reference**

```json
[
  { "app_name": "Visual Studio Code", "window_title": "main.go - ctrluhr", "start_offset_sec": 2,   "duration_sec": 280 },
  { "app_name": "Slack",              "window_title": "#general - Slack", "start_offset_sec": 282, "duration_sec": 90  },
  { "app_name": "Mozilla Firefox",    "window_title": "pgvector docs - Mozilla Firefox", "start_offset_sec": 372, "duration_sec": 240 },
  { "app_name": "Visual Studio Code", "window_title": "schema/users.ts - ctrluhr", "start_offset_sec": 612, "duration_sec": 420 },
  { "app_name": "Discord",            "window_title": "ctrluhr-build - Discord", "start_offset_sec": 1032, "duration_sec": 180 },
  { "app_name": "Visual Studio Code", "window_title": "daemon/main.go - ctrluhr", "start_offset_sec": 1212, "duration_sec": 600 }
]
```

**Verify**

```sh
cd apps/daemon
go build ./... && test -f tracker/fixtures.json && echo OK
```

Expected: `OK`. (Real validation happens in Step 9.1 — the stub reads the
file at startup and fails loudly on malformed JSON.)

**Produces**

`tracker/fixtures.json`.

## 4. Uplink queue (badger)

### 4.1 Write the persistent queue

**Assumes**

- Step 1.2 done (badger/v4 available). Step 3.1 done (`tracker.Event`).

**Read first**

1. **badger — Transactions** — https://github.com/dgraph-io/badger#transactions
   The `db.Update(func(txn) error)` shape. `Update` is read+write; `View` is
   read-only. We use `Update` for both enqueue and drain.
2. **badger — Iteration** — https://github.com/dgraph-io/badger#iterating-over-keys
   `txn.NewIterator(opt)` with the `Seek(nil)` / `Valid()` / `Next()`
   pattern, and `item.Value(func(v []byte) error)` for reading values without
   copying. Use the package's `badger.DefaultIteratorOptions` as the starting
   point for the options value.

**Do**

Write `uplink/queue.go`: a FIFO over badger with `Enqueue(batch)` and
`Drain(limit)`. This is the between-restart buffer: events survive daemon
restarts and API downtime, which is what makes the "offline buffering"
behavior in `06` Step 8 work.

Two design points:

- **Key = `started_at` nanos + index.** badger iterates keys in byte order,
  so `"%d-%d"` keys drain in emission order. The index suffix keeps two
  events with identical timestamps from colliding.
- **`Drain` returns a release closure, not deletes.** The caller POSTs the
  batch and only then calls `release()` to delete the keys. On a failed
  POST the events stay queued and the next drain retries them. Idempotency
  covers the replay: the API's `ON CONFLICT (id) DO NOTHING` means a
  re-sent batch never double-counts (03 §7).
- **`WithLoggingLevel(badger.ERROR)`** silences badger's info chatter; we
  only care about real errors.

The import direction is `uplink -> tracker` (one-way, no cycle), so the
queue can store `tracker.Event` directly — no shadow struct or
marshal/unmarshal helper pair needed.

**Reference**

```go
// apps/daemon/uplink/queue.go — REFERENCE ONLY

package uplink

import (
	"encoding/json"
	"fmt"

	"github.com/btz/ctrluhr/daemon/tracker"
	"github.com/dgraph-io/badger/v4"
)

// Queue is a persistent FIFO of unsent events. badger is embedded and pure
// Go (no cgo), so it runs on every target the daemon builds for.
type Queue struct {
	db *badger.DB
}

func NewQueue(dir string) (*Queue, error) {
	opts := badger.DefaultOptions(dir).WithLoggingLevel(badger.ERROR)
	db, err := badger.Open(opts)
	if err != nil {
		return nil, err
	}
	return &Queue{db: db}, nil
}

func (q *Queue) Close() error { return q.db.Close() }

// Enqueue writes a batch atomically. Keys sort in emission order.
func (q *Queue) Enqueue(events []tracker.Event) error {
	return q.db.Update(func(txn *badger.Txn) error {
		for i, ev := range events {
			data, err := json.Marshal(ev)
			if err != nil {
				return err
			}
			key := []byte(fmt.Sprintf("%d-%d", ev.StartedAt.UnixNano(), i))
			if err := txn.Set(key, data); err != nil {
				return err
			}
		}
		return nil
	})
}

// Drain reads up to limit events and returns a release func that deletes
// them. Call release only after the batch POSTed successfully.
func (q *Queue) Drain(limit int) ([]tracker.Event, func(), error) {
	var events []tracker.Event
	var releaseKeys [][]byte
	err := q.db.Update(func(txn *badger.Txn) error {
		it := txn.NewIterator(badger.DefaultIteratorOptions)
		defer it.Close()
		for it.Seek(nil); it.Valid() && len(events) < limit; it.Next() {
			item := it.Item()
			err := item.Value(func(v []byte) error {
				var ev tracker.Event
				if err := json.Unmarshal(v, &ev); err != nil {
					return err
				}
				events = append(events, ev)
				releaseKeys = append(releaseKeys, item.KeyCopy(nil))
				return nil
			})
			if err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return nil, nil, err
	}

	release := func() {
		_ = q.db.Update(func(txn *badger.Txn) error {
			for _, k := range releaseKeys {
				_ = txn.Delete(k)
			}
			return nil
		})
	}
	return events, release, nil
}
```

**Verify**

```sh
cd apps/daemon
go build ./... && go vet ./uplink
```

Expected: exit clean.

**Produces**

`uplink/queue.go` — the `uplink` package.

## 5. Uplink HTTP client

### 5.1 Write the `/events` client

**Assumes**

- Step 4.1 done (`uplink` package exists). Step 3.1 done (`tracker.Event`).

**Read first**

1. **net/http — `Client.Do`** — https://pkg.go.dev/net/http#Client.Do
   `http.NewRequestWithContext(ctx, ...)` + `client.Do(req)`. The context is
   how a daemon shutdown cancels an in-flight POST.
2. **compress/gzip — `NewWriter`** — https://pkg.go.dev/compress/gzip#NewWriter
   `gzip.NewWriter(&buf)`, write, `Close()`. The `Content-Encoding: gzip`
   header tells the server the body is compressed.
3. **net/http — `Header.Set`** — https://pkg.go.dev/net/http#Header.Set
   The `Authorization: Bearer <jwt>` header.

**Do**

Write `uplink/client.go`: `PostBatch(ctx, events)` gzips the batch, sets the
`Authorization` header from the Device Key, and POSTs to
`<endpoint>/events`.

Two design points:

- **The queue is the retry mechanism, so the client never retries.** A
  failed POST returns an error; `Drain`'s release closure is not called, and
  the next flusher tick retries.
- **Return a typed error that carries the status code**, so `main` can tell
  a transient failure from a 401. A Revoked device gets
  `401 { error: 'device revoked' }` on the per-batch status check
  (ADR-0005); retrying a dead key forever is pointless — the flusher should
  halt instead (00 §3). The reference returns `*BatchError` with the status
  for exactly that reason.

One open question lives here: the API's events route reads the body with
`c.req.json()` (03 §7) and never gunzips manually — it relies on
Bun's server auto-decompressing `Content-Encoding: gzip` request bodies.
Confirm that at build time (Step 9.1 is the test). If it does not, the
simplest fix is to drop gzip in phase 0 — the payloads are a handful of
events per 10s.

**Reference**

```go
// apps/daemon/uplink/client.go — REFERENCE ONLY

package uplink

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/btz/ctrluhr/daemon/tracker"
)

// BatchError carries the HTTP status so the flusher can distinguish a
// revoked device (401) from a transient failure.
type BatchError struct {
	Status int
}

func (e *BatchError) Error() string {
	return fmt.Sprintf("post events: status %d", e.Status)
}

type Client struct {
	Endpoint  string
	DeviceJWT string
	HTTP      *http.Client
}

func NewClient(endpoint, jwt string) *Client {
	return &Client{
		Endpoint:  endpoint,
		DeviceJWT: jwt,
		HTTP:      &http.Client{Timeout: 30 * time.Second},
	}
}

// PostBatch gzips one batch and POSTs it with the Device Key. Never retries;
// the queue (Step 4) is the retry mechanism.
func (c *Client) PostBatch(ctx context.Context, events []tracker.Event) error {
	body := struct {
		Events []tracker.Event `json:"events"`
	}{Events: events}
	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	if _, err := gz.Write(raw); err != nil {
		return err
	}
	if err := gz.Close(); err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, "POST", c.Endpoint+"/events", &buf)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.DeviceJWT)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Content-Encoding", "gzip")

	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, resp.Body)
	if resp.StatusCode >= 400 {
		return &BatchError{Status: resp.StatusCode}
	}
	return nil
}
```

**Verify**

```sh
cd apps/daemon
go build ./... && go vet ./uplink
```

Expected: exit clean. (Live behavior is Step 9.1: the API log shows a
`POST /events` 200.)

**Produces**

`uplink/client.go`.

## 6. Enrollment subcommand

### 6.1 Write `auth/enroll.go`

**Assumes**

- Step 2.1 done (`config` package with `Save`).
- `03` §6.2 done: `POST /devices/enroll` exists and returns
  `{ device_id, device_key, name, os }` — `device_key` is the Device Key JWT.

**Read first**

- No new third-party library. Read `03` §6.1 (the enrollment flow, and the
  ADR-0005 `api_token_hash` drop) before writing — this step is pure
  business logic and the flow must match.

**Do**

Write `auth/enroll.go` implementing the enrollment side of the flow from the
top of this file:

1. `POST <endpoint>/devices/enroll` with
   `{ "enrollment_token": "<token>" }` — the API reads the device's name/OS
   from the token row (created in the web app, `03` §6.2).
2. Decode `{ device_id, device_key, name, os }`. `device_key` is the Device
   Key — there is no random-token-plus-hash exchange anymore (ADR-0005); the
   JWT is returned directly.
3. Build a `config.Config` with the endpoint, the device id, the Device Key,
   and the device's name/OS, then `Save()` it. `Save` writes `0o600`, so the
   key lands on disk owner-only (Step 2.1).

A 401 on this call means the Enrollment Token was already used (it is
one-time, `03` §6.1) or expired (30 minutes). The token is created in the
web app's `/devices` page (`04` §6.2); if it expired, create a new Device
and copy the fresh token.

**Reference**

```go
// apps/daemon/auth/enroll.go — REFERENCE ONLY

package auth

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/btz/ctrluhr/daemon/config"
)

// Enroll exchanges a one-time Enrollment Token for a long-lived Device Key
// (JWT). Flow matches 00 §3 and 03 §6. The API reads the device's name/OS
// from the token row and returns them with the key; there is no
// api_token_hash dance (ADR-0005).
func Enroll(endpoint, token string) error {
	payload := map[string]string{
		"enrollment_token": token,
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	resp, err := http.Post(endpoint+"/devices/enroll", "application/json", bytes.NewReader(raw))
	if err != nil {
		return fmt.Errorf("enroll: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		// 401 = token already used or expired (03 §6.1): re-create in the
		// web app's /devices page and try again.
		return fmt.Errorf("enroll: status %d", resp.StatusCode)
	}
	var out struct {
		DeviceID   string `json:"device_id"`
		DeviceKey  string `json:"device_key"`
		DeviceName string `json:"name"`
		DeviceOS   string `json:"os"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return err
	}

	cfg := &config.Config{
		Endpoint:   endpoint,
		DeviceID:   out.DeviceID,
		DeviceJWT:  out.DeviceKey,
		DeviceName: out.DeviceName,
		DeviceOS:   out.DeviceOS,
	}
	if err := cfg.Save(); err != nil {
		return err
	}
	fmt.Println("Enrolled. Config saved.")
	return nil
}
```

**Verify**

```sh
cd apps/daemon
go build ./... && go vet ./auth
```

Expected: exit clean. (The live exchange with the API is Step 9.1.)

**Produces**

`auth/enroll.go` — the `auth` package.

## 7. Main

### 7.1 Write `main.go`

**Assumes**

- Steps 2.1, 3.2, 4.1, 5.1, 6.1 done (all packages compile).

**Read first**

1. **`context.WithCancel`** — https://pkg.go.dev/context#WithCancel
   The `ctx, cancel := context.WithCancel(...)` + `defer cancel()` pattern.
   Every goroutine selects on `<-ctx.Done()` for shutdown.
2. **`os/signal.Notify`** — https://pkg.go.dev/os/signal#Notify
   `signal.Notify(ch, syscall.SIGINT, syscall.SIGTERM)` for Ctrl-C /
   kill shutdown.
3. **`time.NewTicker`** — https://pkg.go.dev/time#NewTicker
   For the 10s flusher tick. Prefer `NewTicker` over `time.Tick` (which is
   not stoppable).

**Do**

Replace the stub `main.go`. Two subcommands and one run loop:

- **`ctrluhr auth enroll <token>`** — dispatch to `auth.Enroll` and
  return. The endpoint defaults to `http://localhost:3000`; if you want a
  flag override, that is a small addition (see Open decisions).
- **`ctrluhr dev`** (or no args, whichever you prefer) — the run loop, made
  of three concurrent pieces plus a shutdown path:
  1. **Tracker** — `stub.Run(ctx, eventsCh)` in a goroutine.
  2. **Batcher** — collects from `eventsCh` into a slice; on 100 events or a
     10s tick, `queue.Enqueue` the slice (00 §3: "POSTs to /events every 10s
     or 100 events").
  3. **Flusher** — every 10s, `queue.Drain` up to N, `client.PostBatch`, and
     on success call the release closure. On a `*BatchError` with status 401,
     do **not** retry: the Device is revoked (ADR-0005), so log clearly and
     halt. Any other error just leaves the events queued for the next tick.
  4. **Shutdown** — wait on the signal channel; cancel the context so the
     tracker unwinds; close the queue.

Wire the pieces by reading the two channels / the ticker; there is no shared
mutable state between goroutines, so no locks.

**Reference**

```go
// apps/daemon/main.go — REFERENCE ONLY (structure; not copy-paste)

func main() {
	// Subcommand dispatch.
	if len(os.Args) > 1 && os.Args[1] == "enroll" {
		// os.Args[2] = token, [3] = name, [4] = os; endpoint defaults to
		// http://localhost:3000. Call auth.Enroll, exit.
	}

	cfg, err := config.Load()          // points the user at `enroll` if missing
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	// Optional tray goroutine (Step 8) — select on its menu channels here.

	eventsCh := make(chan tracker.Event, 100)
	stub := &tracker.StubTracker{FixturesPath: cfg.FixturesPath, LoopForever: true}
	go stub.Run(ctx, eventsCh)

	queue := ... // uplink.NewQueue(<queue dir>, e.g. /tmp/ctrluhr-queue for dev)
	client := uplink.NewClient(cfg.Endpoint, cfg.DeviceJWT)

	go batcher(ctx, eventsCh, queue)   // 100 events or 10s tick -> Enqueue
	go flusher(ctx, client, queue)     // 10s tick -> Drain -> PostBatch -> release; halt on 401

	<-sigCh
}
```

**Verify**

```sh
cd apps/daemon
go build ./... && go vet ./...
go run . dev
```

Expected: build clean. `go run . dev` no longer prints the scaffold stub;
it loads config (or tells you to run `enroll` first) and starts the run
loop. Full end-to-end behavior is Step 9.

**Produces**

A real `main.go`; `apps/daemon` is now an operable binary.

## 8. Tray (decision needed)

### 8.1 Stub the tray, or wire systray

**Assumes**

- Step 7.1 done (there is a run loop for the tray to control).

**Read first**

- **getlantern/systray — README** — https://github.com/getlantern/systray
   The `Run(onReady, onExit)` example, the cgo note ("requires cgo, set
   `CGO_ENABLED=1`"), and the Linux platform notes (needs `gcc`, `gtk3`,
   and `libayatana-appindicator3` development headers).
- The full API at https://pkg.go.dev/github.com/getlantern/systray
   `AddMenuItem` returns a `*MenuItem` whose `ClickedCh` channel fires on
   click — that is how the run loop learns about Pause / Quit.

**Do**

The tray is the one phase-0 piece with real build friction, so pick one path
(see Open decisions for the recommendation):

- **Stub (recommended for phase 0).** A `tray` package whose `Run` is a
  no-op. The daemon is headless-capable; nothing in `main` depends on a real
  tray. This keeps the build pure Go, which matters because `project.json`
  (`01` Step 6) cross-compiles a Windows binary and `06` Step 10 builds
  `dist/ctrluhr-windows-amd64.exe` — systray's cgo would drag a mingw
  toolchain into that path, and on Linux it needs GTK/appindicator headers.
- **Real systray (only if you want the tray now).** The wrapper is small:
  `systray.Run(onReady, onExit)`; in `onReady`, `systray.SetTitle`,
  `AddMenuItem` for Pause and Quit; the run loop selects on the items'
  `ClickedCh` channels. Build with `CGO_ENABLED=1` and the headers
  installed.

**Reference**

```go
// apps/daemon/tray/tray.go — REFERENCE ONLY (stub)

package tray

// Run is a no-op for phase 0. The daemon is headless-capable; a real tray
// (systray) is deferred to phase 1, where its cgo requirement no longer
// fights the phase-0 cross-compile. See 07-future-phases.md.
func Run() {}
```

**Verify**

```sh
cd apps/daemon
go build ./... && go vet ./tray
```

Expected: exit clean (stub path). If you opted for real systray, the build
requires the dev headers and `CGO_ENABLED=1`, and the Windows cross-build in
`project.json` needs a mingw toolchain.

**Produces**

`tray/tray.go` — either a stub or a systray wrapper.

## 9. Build + verify end-to-end

### 9.1 Enroll, run, and watch the dashboard

**Assumes**

- Steps 1–8 done; `go build ./...` clean.
- `03` running at `http://localhost:3000`; `04` web app running at
  `:5173`; you are logged in via magic link.

**Do**

Nothing to build — this is the exit gate that proves the whole pipeline.
The API terminal is the source of truth for `/events`; the dashboard is the
source of truth for the read path.

**Verify**

```sh
cd apps/daemon
go build -o ctrluhr .
```

1. In the web app, open `/devices`, create a Device (e.g. `my-laptop`,
   OS `linux`), copy the Enrollment Token.
2. Enroll:

```sh
./ctrluhr auth enroll <token>
```

Expected: `Enrolled. Config saved.` Then:

```sh
cat ~/.config/ctrluhr/config.toml
```

Expected: a TOML doc containing `device_jwt = "ey..."` (and
`device_id`, `device_name`, `device_os`). File perms are `-rw-------`.

3. Run the daemon:

```sh
./ctrluhr dev
```

Expected: events emitted a few seconds after start (visible via your
`fmt.Println` logs) and the first flush attempt at the 10s tick. In the API
terminal, a `POST /events` arrives with status 200. Within ~30s, the
dashboard's stacked bar (current-hour bucket) starts growing.

Red conditions, and what each means (all documented API behavior):

- **`enroll` returns 401** — the Enrollment Token was already used or is
  past its 30-minute window (`03` §6.1). Create a fresh Device in the web
  app.
- **`/events` returns 400** — the batch shape failed Zod. The API returns
  `details` from `error.flatten()` (`03` §7); the usual causes are a
  non-UTC timestamp (re-check Step 3.1) or a bad id.
- **`/events` returns 401** — the Device is revoked or the key doesn't match
  the signing secret (`03` §5.4/§5.5). Check the device's status; re-enroll
  for rotation (ADR-0005).
- **Events emitted but never flushed** — the gzip/`Content-Encoding`
  question from Step 5.1 is real: confirm Bun auto-decompressed the body.
  If it did not, drop gzip in phase 0 (volumes are tiny) or gunzip in `03`
  §7.

**Produces**

A working enrollment path and a daemon that feeds the dashboard.

### 9.2 Offline buffering + revocation

**Assumes**

- Step 9.1 passing.

**Verify**

1. **Offline buffering** (this is `06` Step 8):
   - Stop the API. Keep the daemon running ~30s — it fails to flush
     (visible in stdout), events stay queued.
   - Start the API again. Within ~10s the flusher succeeds and events
     appear on the dashboard retroactively.
   - If events are lost, your `Drain` + release logic is wrong — re-read
     Step 4.1.
2. **Revocation (ADR-0005)**: revoke the Device (web `/devices`, or set
   `devices.status = 'revoked'` directly). The daemon's next `/events` POST
   gets `401 { error: 'device revoked' }` and the flusher halts. To rotate:
   create a new Device + token and re-enroll. There is no key-rotation
   dance — revoke + re-enroll is the mechanism (ADR-0005).

**Produces**

Proof that the queue survives API downtime and that revocation kills a
Device's key immediately.

**[commit]**

```sh
git add -A
git commit -m "feat(daemon): stub tracker + uplink + enroll + tray"
```

## Open decisions (adjudication list)

One line each — decide and correct the doc (or file a code-fix ticket),
per the convention in `docs/README.md` §5.

1. **Tray for phase 0: stub vs real systray.** systray needs cgo (GTK +
   appindicator headers on Linux; mingw for the `project.json` Windows
   cross-build). Recommend: stub for phase 0, real tray in phase 1.
   `07-future-phases.md` does not carry the tray; `00` §3's "halts with a
   tray notification" becomes "logs clearly and halts" for now.
2. **Enroll CLI shape.** Standardized to `ctrluhr auth enroll <token>`
   (matches `00` §3 and `04` §6.2). The name/OS are captured when the Device
   is created in the web app and stored in the Enrollment Token row (`03`
   §6.2), so the CLI carries no args. The API reads them from the token row
   at `/devices/enroll` and returns them with the Device Key.
3. **`api_token` response field vs glossary "Device Key".** Resolved in favor
   of the glossary: the wire field is `device_key` everywhere (`03` §6.2,
   this file). `api_token` only survives in `api_token_hash`, the column
   being dropped (ADR-0005).
4. **Pending queue on revocation.** Events queued for a revoked Device will
   401 forever after re-enroll (new device id). Unspecified. Recommend:
   flusher halts and leaves the queue; user clears
   `<queue-dir>` after re-enrolling. Decide if a "clear on revoke" path is
   worth it.
5. **Enroll endpoint source.** The CLI has no endpoint argument; it defaults
   to `http://localhost:3000`. Fine for phase 0; decide later if a
   `-endpoint` flag or a config-based flow is wanted.

## Done criteria

- [ ] `apps/daemon` builds: `cd apps/daemon && go build -o ctrluhr .`
- [ ] `./ctrluhr auth enroll <token>` exchanges the token for a
      Device Key and writes `~/.config/ctrluhr/config.toml` (`0o600`,
      containing `device_jwt = "ey..."`)
- [ ] `./ctrluhr dev` loads config + fixtures and emits events within ~2s
- [ ] Events are queued in badger while the API is down, then flushed when
      it returns
- [ ] API log shows `POST /events` 200; the dashboard grows within ~30s
- [ ] A Revoked device's next `/events` gets 401 and the daemon halts
- [ ] One commit: "feat(daemon): stub tracker + uplink + enroll + tray"

Next file: `06-phase0-smoke-test.md` — the executable end-to-end exit gate.
