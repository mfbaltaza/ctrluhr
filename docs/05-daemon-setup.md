# 05 — Daemon Setup (Go, stub tracker)

Goal: a Go binary you can run that:
- Loads config from `~/.config/ctrluhr/config.toml` (endpoint + JWT)
- Pushes synthetic events from a fixture file (`fixtures.json`) to the API
- Has a system-tray icon with Pause / Resume / Quit
- Has a `ctrluhr enroll <token> <name> <os>` subcommand that exchanges an
  enrollment token for a device JWT and writes it to config

Stub tracker means: no real window polling, just a script reading a JSON
file of scheduled events. Phase 1 swaps in real Hyprland/X11/Windows
trackers behind the same `Tracker` interface (see `07-future-phases.md`).

> Assumes `03-api-setup.md` done. API reachable at `http://localhost:3000`.
>
> **Doc convention:** this file follows the docs-as-source-of-truth pattern.
> For every Go library used (go-toml/v2, badger, systray) the doc points you
> at the README/docs and shows a reference of the end-state shape. For our
> own business logic (tracker interface, enrollment flow, main loop
> orchestration) the doc goes heavier on code + "why".

## 0. Daemon structure

```
apps/daemon/
├── go.mod
├── main.go            # CLI entrypoint, dispatches subcommands
├── config/
│   └── config.go      # TOML load/save, ~ /.config/ctrluhr/config.toml
├── tracker/
│   ├── tracker.go     # interface
│   ├── stub.go        # fixture-based emission
│   └── fixtures.json   # 24h of synthetic events
├── uplink/
│   ├── client.go      # HTTP client, auth, gzip, retry
│   └── queue.go       # badger-backed pending queue
├── tray/
│   └── tray.go        # systray wrapper
└── auth/
    └── enroll.go      # subcommand: token → JWT
```

This layout is convention, not gospel. If you find a different split
works better as you write, restructure. The interfaces (`Tracker`,
`Uplink`) are the things that need to stay stable.

## 1. Dependencies

In `apps/daemon/`:

```sh
go get github.com/pelletier/go-toml/v2
go get github.com/google/uuid
go get github.com/dgraph-io/badger/v4
go get github.com/getlantern/systray
```

`uuid` is for client-side event UUID generation (critical for
idempotent inserts). `badger` is the embedded KV store for between-restart
event buffering. `systray` (the `getlantern` fork is older; try it first
and fall back to `fydo/systray` or `energye/systray` if it breaks).

We deliberately **don't** add `resty` or another HTTP-client library —
the stdlib `net/http` + `compress/gzip` is enough for one POST per 10s
of events. Add a dep when you actually need a feature stdlib doesn't
have (retries with backoff, connection pooling telemetry, etc.).

### 1.1 Read these in order

1. **go-toml/v2** — https://github.com/pelletier/go-toml/tree/v2
   The `Marshal` / `Unmarshal` API. We use it for both directions
   (load + save config). The README has the 1-page shape you need.
2. **google/uuid** — https://github.com/google/uuid#uuid
   Just the `uuid.NewString()` call. Single function; no need to deep-read.
3. **badger v4** — https://github.com/dgraph-io/badger
   The `db.Update(func(txn) error { ... })` + `txn.NewIterator()` pattern
   in §4. Read the "Transactions" and "Iteration" sections — those are
   the only two APIs we use.
4. **getlantern/systray** — https://github.com/getlantern/systray
   `systray.Run(onReady, onExit)`, `systray.AddMenuItem`, the
   `ClickedCh` channel pattern. Cross-platform: Wayland support is
   spotty (often needs GTK dev headers) — see pitfalls at the end.

> **If `getlantern/systray` gives you headaches on Wayland/Hyprland,**
> drop the tray for phase 0 and re-add it in phase 1. The daemon works
> headless; tray is a nice-to-have. Keep the `tray/` package as a
> stub so `main` can call `tray.Run()` as a no-op.

## 2. Config (`config/config.go`)

A small `Config` struct with TOML tags, plus `Load()` and `Save()` that
read/write `~/.config/ctrluhr/config.toml` with `0600` perms (the file
contains a long-lived JWT — must not be world-readable).

The interesting bits are:
- `os.UserConfigDir()` returns the platform-correct config dir
  (`~/.config` on Linux, `~/Library/Application Support` on macOS,
  `%AppData%` on Windows). Don't hardcode `~/.config`.
- `os.MkdirAll(dir, 0o755)` before the first save — the dir may not
  exist on a fresh install.
- `0o600` on the config file (owner read/write only) — it contains a
  long-lived JWT.

### 2.1 Read these in order

1. **go-toml/v2 — Marshal/Unmarshal** — https://pkg.go.dev/github.com/pelletier/go-toml/v2#Marshal
   The exact API we use. Single-page.
2. **`os.UserConfigDir`** — https://pkg.go.dev/os#UserConfigDir
   Behavior differs by platform. Read the note about Android (it
   returns the wrong thing — irrelevant for us, but good to know).
3. **`os.MkdirAll` + `os.WriteFile`** — https://pkg.go.dev/os#MkdirAll
   `0o755` for dirs, `0o600` for files with secrets.

### 2.2 Write `config/config.go`

By the time you've read the three docs above, the file should fall out
naturally. The shape: struct → `DefaultPath()` → `Load()` → `Save()`.

#### Reference — what the end file should look like

```go
// apps/daemon/config/config.go — REFERENCE ONLY

package config

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/pelletier/go-toml/v2"
)

type Config struct {
	Endpoint        string `toml:"endpoint"`
	DeviceJWT       string `toml:"device_jwt"`
	DeviceID        string `toml:"device_id"`
	DeviceName      string `toml:"device_name"`
	DeviceOS        string `toml:"device_os"`
	PollIntervalMS  int    `toml:"poll_interval_ms"`
	FixturesPath    string `toml:"fixtures_path"`
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
		return nil, fmt.Errorf("no config at %s — run 'ctrluhr enroll <token>' first: %w", path, err)
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

## 3. Tracker interface + stub

`Tracker` is a single-method interface that emits events to a channel.
The stub implementation reads from a JSON fixture file; phase 1 will
add `HyprTracker` / `X11Tracker` / `WindowsTracker` behind the same
interface.

### 3.1 Read these in order

1. **Go — interfaces and channels** — https://go.dev/tour/concurrency
   Just the "Channels" section. The pattern is:
   `Run(ctx, out chan<- Event) error` — the tracker blocks writing to
   `out`; main reads from it.
2. **google/uuid — `NewString`** — https://pkg.go.dev/github.com/google/uuid#NewString
   The one function we use. Generates a RFC 4122 v4 UUID string.
3. **encoding/json** — https://pkg.go.dev/encoding/json#Unmarshal
   `json.Unmarshal(data, &entries)` is the only call we need.

### 3.2 The `Event` struct — internal wire format

```go
// Event is a single observed window. IDs and timestamps come from the daemon.
type Event struct {
	ID          string    `json:"id"`
	AppName     string    `json:"app_name"`
	WindowTitle string    `json:"window_title"`
	StartedAt   time.Time `json:"started_at"`
	EndedAt     time.Time `json:"ended_at"`
}
```

The JSON tags match the API's `EventBatchSchema` (in
`packages/schema/src/event.ts`). When we `json.Marshal` an `Event`,
it produces the exact shape the API expects.

### 3.3 `tracker.go` — the interface

```go
// Tracker emits events on the provided channel. Implementations:
// - StubTracker (phase 0): reads from fixtures.json
// - HyprTracker / X11Tracker / WindowsTracker (phase 1)
type Tracker interface {
	Run(ctx context.Context, out chan<- Event) error
}
```

### 3.4 `stub.go` — fixture-based emission

Read the fixture, schedule each entry to fire at `start_offset_sec`
after daemon start, and emit. `LoopForever: true` makes it repeat
indefinitely (for the dashboard's 15s auto-refresh to keep showing
data).

The timing pattern is `time.After(time.Until(fireAt))` — non-blocking
on the channel send, cancellable via `ctx.Done()`. Read the Go time
package docs for `After` + `Until` if they're unfamiliar.

#### Reference — what the end file should look like

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

	start := time.Now()
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
					StartedAt:   fireAt,
					EndedAt:     fireAt.Add(time.Duration(e.DurationSec) * time.Second),
				}
			}
		}
		if !s.LoopForever {
			break
		}
		start = time.Now()
	}
	return nil
}
```

### 3.5 `fixtures.json` — synthetic day of activity

A realistic "day snippet" of activity. Each entry fires some seconds
after daemon start. Looping makes it repeat so the dashboard keeps
showing data.

```json
[
  { "app_name": "Visual Studio Code", "window_title": "main.go — ctrluhr", "start_offset_sec": 2,   "duration_sec": 280 },
  { "app_name": "Slack",              "window_title": "#general — Slack", "start_offset_sec": 282, "duration_sec": 90  },
  { "app_name": "Mozilla Firefox",    "window_title": "pgvector docs — Mozilla Firefox", "start_offset_sec": 372, "duration_sec": 240 },
  { "app_name": "Visual Studio Code", "window_title": "schema/users.ts — ctrluhr", "start_offset_sec": 612, "duration_sec": 420 },
  { "app_name": "Discord",            "window_title": "ctrluhr-build — Discord", "start_offset_sec": 1032, "duration_sec": 180 },
  { "app_name": "Visual Studio Code", "window_title": "daemon/main.go — ctrluhr", "start_offset_sec": 1212, "duration_sec": 600 }
]
```

The `start_offset_sec + duration_sec` adds up to ~30 minutes. Loop
forever → repeating 30-min blocks give the dashboard plenty to show.

## 4. Uplink queue (badger-backed)

A persistent queue so events survive daemon restarts and API downtime.
The `Enqueue` writes events to badger; `Drain` reads up to N events
and returns them along with a "release" closure that deletes them on
successful POST.

### 4.1 Read these in order

1. **badger — Transactions** — https://github.com/dgraph-io/badger#transactions
   The `db.Update(func(txn) error {...})` shape. `Update` is for
   read+write; `View` is read-only. We use `Update` for both
   enqueue and drain.
2. **badger — Iteration** — https://github.com/dgraph-io/badger#iterating-over-keys
   `txn.NewIterator(...)` with the `Seek(nil)` / `Valid()` / `Next()`
   pattern. The `item.Value(func(v []byte) error {...})` closure is
   how you read the value without copying it out.

### 4.2 Write `uplink/queue.go`

The two methods are: `Enqueue(batch)` serializes a batch and writes
each event as a key/value (key = timestamp + index, value = JSON);
`Drain(limit)` reads up to `limit` events and returns them with a
release closure for the keys to delete on success.

The `trackerEvent` struct (defined in §4.3) is the on-disk wire format.
It mirrors `tracker.Event` but lives in the `uplink` package so the
`tracker` package doesn't import `uplink` (avoids a cycle).

#### Reference — what the end file should look like

```go
// apps/daemon/uplink/queue.go — REFERENCE ONLY

package uplink

import (
	"encoding/json"
	"fmt"

	"github.com/dgraph-io/badger/v4"
)

type Queue struct {
	db *badger.DB
}

func NewQueue(dir string) (*Queue, error) {
	db, err := badger.Open(badger.DefaultOptions(dir).WithLoggingLevel(badger.ERROR))
	if err != nil {
		return nil, err
	}
	return &Queue{db: db}, nil
}

func (q *Queue) Close() error { return q.db.Close() }

type trackerEvent struct {
	ID          string `json:"id"`
	AppName     string `json:"app_name"`
	WindowTitle string `json:"window_title"`
	StartedAt   time.Time `json:"started_at"`
	EndedAt     time.Time `json:"ended_at"`
}

func (q *Queue) Enqueue(batch []tracker.Event) error {
	return q.db.Update(func(txn *badger.Txn) error {
		for i, ev := range batch {
			data, err := json.Marshal(toStoredEvent(ev))
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

func (q *Queue) Drain(limit int) ([]tracker.Event, func(), error) {
	var events []tracker.Event
	var releaseKeys [][]byte
	err := q.db.Update(func(txn *badger.Txn) error {
		it := txn.NewIterator(badger.DefaultIterator(badger.IteratorOptions{PrefetchValues: true}))
		defer it.Close()
		for it.Seek(nil); it.Valid() && len(events) < limit; it.Next() {
			item := it.Item()
			err := item.Value(func(v []byte) error {
				var stored trackerEvent
				if err := json.Unmarshal(v, &stored); err == nil {
					events = append(events, fromStoredEvent(stored))
					releaseKeys = append(releaseKeys, item.KeyCopy(nil))
				}
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

(You'll need a `toStoredEvent` / `fromStoredEvent` helper pair if you
keep the `trackerEvent` struct separate from `tracker.Event` —
optional, you can also `json.Marshal(tracker.Event)` directly if you
keep the import direction clean.)

## 5. Uplink HTTP client

Plain stdlib `net/http` + `compress/gzip`. We POST the batch as a
gzipped JSON body, with `Authorization: Bearer <jwt>`. No retries here
— the queue in §4 is the retry mechanism.

### 5.1 Read these in order

1. **net/http — `Client.Do`** — https://pkg.go.dev/net/http#Client.Do
   The `req, err := http.NewRequestWithContext(...)` + `client.Do(req)`
   pattern with context. We use the context so the daemon's shutdown
   can cancel an in-flight POST.
2. **compress/gzip — Writer** — https://pkg.go.dev/compress/gzip#NewWriter
   `gzip.NewWriter(&buf)` + `gz.Write(data)` + `gz.Close()`. The
   `Content-Encoding: gzip` header tells the server to decompress.
3. **net/http — `Request.Header.Set`** — https://pkg.go.dev/net/http#Header.Set
   Standard `Authorization: Bearer <token>` pattern.

### 5.2 Write `uplink/client.go`

#### Reference — what the end file should look like

```go
// apps/api/src/uplink/client.go — REFERENCE ONLY

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

	"daemon/tracker"
)

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
		return fmt.Errorf("post events: status %d", resp.StatusCode)
	}
	return nil
}
```

> `daemon/tracker` is the import path. **Be consistent**: the `go.mod`
> module path (`github.com/btz/ctrluhr/daemon` per
> `01-monorepo-setup.md` Step 6) means imports should be the full
> path, e.g. `github.com/btz/ctrluhr/daemon/tracker`. The reference
> above uses the short form for readability; replace with your actual
> module path.

## 6. Enrollment subcommand

`ctrluhr enroll <token> <name> <os>` calls `POST /devices/enroll` with
the token, gets back a device ID + JWT, and saves them to
`config.toml`. Pure stdlib.

### 6.1 The flow

1. Marshal the request body: `{ enrollment_token, name, os }`.
2. POST to `<endpoint>/devices/enroll`.
3. Read the response: `{ device_id, api_token }`. The `api_token` is
   the JWT (we return a JWT, not a random — see `03-api-setup.md` §6.3
   for why).
4. Build a `config.Config` and `Save()` it.

#### Reference — what the end file should look like

```go
// apps/daemon/auth/enroll.go — REFERENCE ONLY

package auth

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"

	"daemon/config"
)

func Enroll(endpoint, token, name, osName string) error {
	body, _ := json.Marshal(map[string]string{
		"enrollment_token": token,
		"name":             name,
		"os":               osName,
	})
	resp, err := http.Post(endpoint+"/devices/enroll", "application/json", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("enroll: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("enroll: status %d", resp.StatusCode)
	}
	var out struct {
		DeviceID string `json:"device_id"`
		APIToken string `json:"api_token"` // the JWT
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return err
	}

	cfg := &config.Config{
		Endpoint:   endpoint,
		DeviceJWT:  out.APIToken,
		DeviceID:   out.DeviceID,
		DeviceName: name,
		DeviceOS:   osName,
	}
	if err := cfg.Save(); err != nil {
		return err
	}
	fmt.Println("Enrolled. Config saved.")
	return nil
}
```

## 7. Main

The orchestrator. Three concurrent pieces:

1. **Tracker** — runs the stub, writes events to a channel.
2. **Batcher** — collects from the channel into a local slice,
   enqueues to badger on threshold (100 events) or 10s tick.
3. **Flusher** — every 10s, drains badger and POSTs the batch.

Plus the tray (optional, can be stubbed) and a `signal.Notify` for
clean shutdown.

### 7.1 Read these in order

1. **Go — context cancellation** — https://pkg.go.dev/context#WithCancel
   The `ctx, cancel := context.WithCancel(...)` + `defer cancel()`
   pattern. All goroutines `select` on `<-ctx.Done()` for shutdown.
2. **Go — `os/signal`** — https://pkg.go.dev/os/signal#Notify
   `signal.Notify(ch, syscall.SIGINT, syscall.SIGTERM)` for clean
   shutdown on Ctrl-C.
3. **Go — `time.Tick` / `time.NewTicker`** — https://pkg.go.dev/time#Tick
   We use `time.NewTicker(10 * time.Second)` for the flusher. Prefer
   `NewTicker` over `Tick` (which is global and can't be stopped).

### 7.2 Write `main.go`

The structure:

```go
func main() {
    // 1. Subcommand dispatch
    if len(os.Args) >= 2 && os.Args[1] == "enroll" {
        // parse args, call auth.Enroll, return
    }

    // 2. Load config
    cfg, err := config.Load()
    if err != nil { os.Exit(1) }

    // 3. Set up ctx, cancel
    ctx, cancel := context.WithCancel(context.Background())
    defer cancel()
    signal.Notify(...)

    // 4. Start tray (optional, can be stubbed)
    go tray.Run(...)

    // 5. Tracker → channel
    eventsCh := make(chan tracker.Event, 100)
    go stub.Run(ctx, eventsCh)

    // 6. Batcher: channel → local slice → queue
    go func() { ... }()

    // 7. Flusher: queue → HTTP
    go func() { ... }()

    // 8. Wait for signal
    <-sigCh
}
```

The exact code is mostly plumbing — read the Go docs above, copy
the pattern, adjust field names. The reference in the previous draft
of this doc had a few bugs (an import for a non-existent package);
trust the docs, not the old code.

### 7.3 Tray

If `getlantern/systray` builds cleanly on your system, the wrapper is
~20 lines. The pattern: `systray.Run(onReady, onExit)` with `onReady`
calling `SetTitle`, `SetTooltip`, `AddMenuItem`; the menu items
expose a `ClickedCh` channel that the main loop selects on.

If it doesn't build (Wayland + no GTK headers, see pitfalls), stub it:

```go
package tray

func Run(onAction func(string)) {
    // Stub — tray disabled for phase 0.
}
```

Main won't care; the daemon runs headless.

## 8. Build + verify locally

```sh
cd apps/daemon
go build -o ctrluhr .
```

Then enroll with a token from the web app's `/devices` page (created
in `04-web-setup.md`):

```sh
./ctrluhr enroll <token-from-web-ui> my-laptop linux
```

Expected: `Enrolled. Config saved.` Verify
`~/.config/ctrluhr/config.toml` contains `device_jwt = "ey..."`.

Then run:

```sh
./ctrluhr dev
```

You should see (after ~2s) actual events being emitted (if you add
logs via `fmt.Println`) and after ~10s the first batch flush attempt.
Watch the API log in the API terminal — a `POST /events` request
should arrive with status 200.

**Common 401 from the API:** your JWT is wrong or expired. Check
`config.toml` — paste `device_jwt` into a JWT debugger (jwt.io) to
confirm the claims look right. If the token is fine, check the API's
`verifyDeviceJwt` and make sure `BETTER_AUTH_SECRET` in the API's
`.env` matches the secret used to sign. If you regenerated
`BETTER_AUTH_SECRET` between creating the device and enrolling, the
JWT would be signed with a different secret. Re-enroll if you changed
it.

**Common 400:** your event batch shape is wrong. Run the API in
verbose mode and check the error details in the response body
(the API returns Zod's `flatten()` in `details`).

### Watch the dashboard

Have the web app open in a browser. The dashboard auto-refreshes
every 15s. Within ~30s of the daemon starting, you should see time
appearing in the stacked bar chart (in the "current hour" bucket for
now — `07-future-phases.md` §Phase 1 makes this hourly).

## 9. Commit `[commit]`

```sh
git add -A
git commit -m "feat(daemon): stub tracker + uplink + tray + enroll subcommand"
```

## Common pitfalls

### `getlantern/systray` fails to build on Linux without GTK dev deps
Install them: `sudo pacman -S gtk3` (Arch) or equivalent. If you can't,
stub the tray file (as shown in §7.3) and move on. Re-add later.

### `badger` opens slowly first time
badger needs to initialize a directory. It can take a few seconds on
first run. Use `/tmp/ctrluhr-queue` for development; for production
phase 1+ consider `~/.local/share/ctrluhr/queue`.

### `json.Unmarshal` panics on `time.Time`
`time.Time` needs a string in RFC3339 format. `time.MarshalJSON`
produces RFC3339, so Go to Go works. If you see parse errors in the
API, make sure `ev.started_at` is sent as an ISO string —
`json.Marshal(time.Time)` does this automatically. Verify by
`tail -f` your HTTP requests with a proxy.

### Enroll returns 401 "invalid or expired token"
- Token from web UI has a 30-min window. Re-create if expired.
- API's `vouchers` table lookup found a row but `type !== 'device_enroll'`.
  Check the type column in DB.

### Zombie events after kill
If you SIGINT during a flush, badger might keep the events in queue
without releasing them. Next run will re-flush them. Idempotency via
the `id` UUID means no duplicate rows in the DB — just duplicate
POSTs that resolve to `onConflictDoNothing` in the API.

### `go.mod` has `module github.com/btz/ctrluhr/daemon` but imports use `daemon/...`
Go is picky about the module root. You have two options:
1. Use the full module path in imports: `github.com/btz/ctrluhr/daemon/tracker`.
   (Recommended — standard Go style.)
2. Replace with `module daemon` in `go.mod` and keep imports short.

Pick one and be consistent. Don't mix — Go will fail to build.

## Done criteria

- [ ] `apps/daemon` builds: `go build -o ctrluhr .`
- [ ] `./ctrluhr enroll <token> <name> <os>` exchanges token → JWT → saves to `~/.config/ctrluhr/config.toml`
- [ ] `./ctrluhr dev` loads config + fixtures.json, emits events every ~2s
- [ ] Badger queue buffers events locally if the API is unreachable
- [ ] API receives events (`GET /analytics/day` returns them in the day's buckets)
- [ ] Web dashboard shows stacked bar increasing within ~30s of daemon start
- [ ] Tray shows up (or stubbed out cleanly without build errors)
- [ ] One commit: "feat(daemon): stub tracker + uplink + tray + enroll subcommand"

Next file: `06-phase0-smoke-test.md` — end-to-end checklist to prove the
whole pipeline before moving on to phase 1.
