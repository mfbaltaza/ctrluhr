# 05 — Daemon Setup (Go, stub tracker)

Goal: a Go binary you can run that:
- Loads config from `~/.config/ctrluhr/config.toml` (endpoint + JWT)
- Pushes synthetic events from a fixture file (`fixtures.json`) to the API
- Has a system-tray icon with Pause / Resume / Quit
- Has a `ctrluhr auth enroll <token>` subcommand that exchanges an enrollment
  token for a device JWT and writes it to config

Stub tracker means: no real window polling, just a script reading a JSON
file of scheduled events. Phase 1 swaps in real Hyprland/X11/Windows
trackers behind the same `Tracker` interface.

> Assumes `03-api-setup.md` done. API reachable at `http://localhost:3000`.

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

## 1. Dependencies

In `apps/daemon/`:

```sh
go get github.com/pelletier/go-toml/v2
go get github.com/go-resty/resty/v2
go get github.com/google/uuid
go get github.com/dgraph-io/badger/v4
go get github.com/getlantern/systray
```

`resty` is a nice HTTP client with built-in retry. `uuid` for client-side
event UUID generation (critical for idempotent
insets). `badger` is the embedded KV for between-restart event buffering.
`systray` (the `getlantern` fork is older; try `github.com/getlantern/systray`
first; if problematic, use `github.com/fydo/systray` or
`github.com/energye/systray`).

If `getlantern/systray` gives you headaches on Wayland/Hyprland, drop the tray
for phase 0 and re-add it in phase 1. The daemon works headless; tray is a
nice-to-have. Keep the `tray/` package as a stub so main can call `tray.Run()`
no-op.

## 2. Config (`config/config.go`)

```go
package config

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/pelletier/go-toml/v2"
)

type Config struct {
	Endpoint      string `toml:"endpoint"`
	DeviceJWT     string `toml:"device_jwt"`
	DeviceID      string `toml:"device_id"`
	DeviceName    string `toml:"device_name"`
	DeviceOS      string `toml:"device_os"`
	PollIntervalMS int  `toml:"poll_interval_ms"`
	FixturesPath  string `toml:"fixtures_path"`
}

func DefaultPath() (string, error) {
	home, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(home, "ctrluhr")
	if err := os.MkdirAll(dir, 0o755); os.IsNotExist(err) {
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
		return nil, fmt.Errorf("no config at %s — run 'ctrluhr auth enroll <token>' first: %w", path, err)
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

### `apps/daemon/tracker/tracker.go`

```go
package tracker

import (
	"context"
	"time"
)

// Event is a single observed window. IDs and timestamps come from the daemon.
type Event struct {
	ID          string    `json:"id"`
	AppName     string    `json:"app_name"`
	WindowTitle string    `json:"window_title"`
	StartedAt   time.Time `json:"started_at"`
	EndedAt     time.Time `json:"ended_at"`
}

// Tracker emits events on the provided channel. Implementations:
// - StubTracker (phase 0): reads from fixtures.json
// - HyprTracker (phase 1): polls hyprctl
// - WindowsTracker (phase 1): polls user32
type Tracker interface {
	Run(ctx context.Context, out chan<- Event) error
}
```

### `apps/daemon/tracker/stub.go`

```go
package tracker

import (
	"context"
	"encoding/json"
	"os"
	"time"

	"github.com/google/uuid"
)

type stubEntry struct {
	AppName     string `json:"app_name"`
	WindowTitle string `json:"window_title"`
	StartOffsetSec int `json:"start_offset_sec"` // seconds since daemon start
	DurationSec  int    `json:"duration_sec"`
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
					WindowTitle:  e.WindowTitle,
					StartedAt:   fireAt,
					EndedAt:     fireAt.Add(time.Duration(e.DurationSec) * time.Second),
				}
			}
		}
		if !s.LoopForever {
			break
		}
		start = time.Now() // repeat
	}
	return nil
}
```

### `apps/daemon/tracker/fixtures.json`

A realistic "day snippet" of activity. Each entry fires some seconds after
daemon start. Looping=true makes it repeat so you can keep the daemon
running and see continuous events.

```json
[
  { "app_name": "Visual Studio Code", "window_title": "main.go — ctrluhr", "start_offset_sec": 2, "duration_sec": 280 },
  { "app_name": "Slack", "window_title": "#general — Slack", "start_offset_sec": 282, "duration_sec": 90 },
  { "app_name": "Mozilla Firefox", "window_title": "pgvector docs — Mozilla Firefox", "start_offset_sec": 372, "duration_sec": 240 },
  { "app_name": "Visual Studio Code", "window_title": "schema/users.ts — ctrluhr", "start_offset_sec": 612, "duration_sec": 420 },
  { "app_name": "Discord", "window_title": "ctrluhr-build — Discord", "start_offset_sec": 1032, "duration_sec": 180 },
  { "app_name": "Visual Studio Code", "window_title": "daemon/main.go — ctrluhr", "start_offset_sec": 1212, "duration_sec": 600 }
]
```

Maximum `start_offset_sec + duration_sec` here is 1812 (30 minutes). Loop
forever → repeating 30-min blocks give the dashboard plenty to show.

## 4. Uplink queue (badger-backed)

### `apps/daemon/uplink/queue.go`

```go
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

func (q *Queue) Enqueue(batch []trackerEvent) error {
	return q.db.Update(func(txn *badger.Txn) error {
		for i, ev := range batch {
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

func (q *Queue) Drain(limit int) ([]trackerEvent, []func(), error) {
	var events []trackerEvent
	var releaseKeys [][]byte
	err := q.db.Update(func(txn *badger.Txn) error {
		it := txn.NewIterator(badger.DefaultIterator(badger.IteratorOptions{PrefetchValues: true}))
		defer it.Close()
		for it.Seek(nil); it.Valid() && len(events) < limit; it.Next() {
			item := it.Item()
			err := item.Value(func(v []byte) error {
				var ev trackerEvent
				if err := json.Unmarshal(v, &ev); err == nil {
					events = append(events, ev)
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

Tracker event type is the daemon's internal wire format:

```go
type trackerEvent struct {
	ID          string `json:"id"`
	AppName     string `json:"app_name"`
	WindowTitle string `json:"window_title"`
	StartedAt   time.Time `json:"started_at"`
	EndedAt     time.Time `json:"ended_at"`
}
```

## 5. Uplink HTTP client

### `apps/daemon/uplink/client.go`

```go
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
	HTTP     *http.Client
}

func NewClient(endpoint, jwt string) *Client {
	return &Client{
		Endpoint:  endpoint,
		DeviceJWT: jwt,
		HTTP:     &http.Client{Timeout: 30 * time.Second},
	}
}

// PostBatch sends up to N events. Returns true on success.
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
	if _, err := gz.Write(raw); err != nil { return err }
	if err := gz.Close(); err != nil { return err }

	req, err := http.NewRequestWithContext(ctx, "POST", c.Endpoint+"/events", &buf)
	if err != nil { return err }
	req.Header.Set("Authorization", "Bearer "+c.DeviceJWT)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Content-Encoding", "gzip")

	resp, err := c.HTTP.Do(req)
	if err != nil { return err }
	defer resp.Body.Close()
	io.Copy(io.Discard, resp.Body)
	if resp.StatusCode >= 400 {
		return fmt.Errorf("post events: status %d", resp.StatusCode)
	}
	return nil
}
```

## 6. Enrollment subcommand

### `apps/daemon/auth/enroll.go`

```go
package auth

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"

	"daemon/config"
)

func Enroll(endpoint, token, name, os string) error {
	body, _ := json.Marshal(map[string]string{
		"enrollment_token": token,
		"name":             name,
		"os":               os,
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
		APIToken string `json:"api_token"` // our JWT
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return err
	}

	cfg := &config.Config{
		Endpoint:   endpoint,
		DeviceJWT:  out.APIToken,
		DeviceID:   out.DeviceID,
		DeviceName: name,
		DeviceOS:   os,
	}
	if err := cfg.Save(); err != nil {
		return err
	}
	fmt.Println("Enrolled. Config saved.")
	return nil
}
```

## 7. Main

### `apps/daemon/main.go`

```go
package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"daemon/auth"
	"daemon/config"
	"daemon/tracker"
	"daemon/tray"
	"daemon/uplink"
	"daemon/uplink/loop"
)

func main() {
	if len(os.Args) >= 2 {
		switch os.Args[1] {
		case "enroll":
			if len(os.Args) < 3 {
				fmt.Println("Usage: ctrluhr enroll <token> [name] [os]")
				os.Exit(1)
			}
			token := os.Args[2]
			name := "my-device"
			if len(os.Args) >= 4 { name = os.Args[3] }
			osName := "linux"
			if len(os.Args) >= 5 { osName = os.Args[4] }
			endpoint := os.Getenv("CTRLUHR_ENDPOINT")
			if endpoint == "" { endpoint = "http://localhost:3000" }
			if err := auth.Enroll(endpoint, token, name, osName); err != nil {
				fmt.Println("enroll failed:", err)
				os.Exit(1)
			}
			return
		case "dev":
			// stub tracker run
		default:
			fmt.Println("unknown subcommand:", os.Args[1])
			os.Exit(1)
		}
	}

	cfg, err := config.Load()
	if err != nil {
		fmt.Println("config error:", err)
		os.Exit(1)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Tray (optional; if it fails on Wayland we just ignore)
	go tray.Run(func(action string) {
		switch action {
		case "pause": cancel()
		case "resume":
			// restart pipeline — phase 1 handles this properly via a pause flag
		case "quit": os.Exit(0)
		}
	})

	// Tracker channel
	eventsCh := make(chan tracker.Event, 100)
	stub := &tracker.StubTracker{FixturesPath: cfg.FixturesPath, LoopForever: true}
	go func() {
		if err := stub.Run(ctx, eventsCh); err != nil {
			fmt.Println("tracker error:", err)
		}
	}()

	// Uplink queue (badger) + flusher
	queue, err := uplink.NewQueue(filepath.Join(os.TempDir(), "ctrluhr-queue"))
	if err != nil {
		fmt.Println("queue open:", err)
		os.Exit(1)
	}
	defer queue.Close()

	client := uplink.NewClient(cfg.Endpoint, cfg.DeviceJWT)

	// Flush every 10s
	flushTicker := time.NewTicker(10 * time.Second)
	defer flushTicker.Stop()

	// Collect into local slice, push into queue, flush periodically
	localBatch := make([]tracker.Event, 0, 100)
	go func() {
		for {
			select {
			case ev := <-eventsCh:
				localBatch = append(localBatch, ev)
				if len(localBatch) >= 100 {
					_ = queue.Enqueue(localBatch)
					localBatch = localBatch[:0]
				}
			case <-flushTicker.C:
				if len(localBatch) > 0 {
					_ = queue.Enqueue(localBatch)
					localBatch = localBatch[:0]
				}
			}
		}
	}()
		// Flusher loop (separate goroutine)
	go func() {
		for range time.Tick(10 * time.Second) {
			events, release, err := queue.Drain(100)
			if err != nil {
				fmt.Printf("drain: %v\n", err)
				continue
			}
			if len(events) == 0 {
				continue
			}
			if err := client.PostBatch(ctx, events); err != nil {
				fmt.Printf("uplink: %v\n", err)
			} else {
				release()
			}
		}
	}()

	// Wait for signal
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh
	fmt.Println("shutting down…")
}
```

I've intentionally left a few imports and package boundaries for you to
reconcile (e.g. `daemon/uplink/loop` doesn't exist — remove from imports,
restructure to fit the actual package layout you settle on). This is good
practice: don't copy code without reading each line.

### Tray

### `apps/daemon/tray/tray.go`

```go
package tray

import (
	"github.com/getlantern/systray"
)

func Run(onAction func(string)) {
	systray.Run(func() {
		systray.SetTitle("ctrluhr")
		systray.SetTooltip("ctrluhr daemon")
		mPause := systray.AddMenuItem("Pause", "Pause tracking")
		mResume := systray.AddMenuItem("Resume", "Resume tracking")
		systray.AddSeparator()
		mQuit := systray.AddMenuItem("Quit", "Quit daemon")
		go func() {
			for {
				select {
				case <-mPause.ClickedCh:
					onAction("pause")
				case <-mResume.ClickedCh:
					onAction("resume")
				case <-mQuit.ClickedCh:
					onAction("quit")
					return
				}
			}
		}()
	}, nil)
}
```

If `getlantern/systray` fails to build on your system, stub it:

```go
package tray

func Run(onAction func(string)) {
	// Stub — tray disabled for phase 0.
}
```

Main won't care; the daemon runs headless just fine.

## 8. Build + verify locally

### Build

```sh
cd apps/daemon
go build -o ctrluhr .
```

### Enroll

Get an enrollment token from your web app's `/devices` page (created in
`04-web-setup.md`). Then:

```sh
./ctrluhr enroll <token-from-web-ui> my-laptop linux
```

Expect: "Enrolled. Config saved." Check `~/.config/ctrluhr/config.toml` —
should contain `device_jwt = "ey..."`.

### Run

```sh
./ctrluhr dev
```

Logs (you may want to add a logger; for phase 0 fmt.Println is enough):
- Starts, opens badger queue in `/tmp/ctrluhr-queue`
- Loads fixtures
- After ~2s emits first event
- Every 10s tries to flush; first success prints `uplink: <ok or err>`

If you see `uplink: post events: status 401` — your JWT is wrong or expired.
Check config.toml — paste `device_jwt` into a JWT debugger (jwt.io) to
confirm the claims look right. If the token is fine, check the API's
`verifyDeviceJwt` and make sure `BETTER_AUTH_SECRET` in the API's `.env`
matches the secret used to sign. Wait — we used `BETTER_AUTH_SECRET` as the
JWT secret in both places. If you regenerated `BETTER_AUTH_SECRET` between
creating the device and enrolling, the JWT would be signed with a different
secret. Re-enroll if you changed it.

If `uplink: post events: status 400` — your event batch shape is wrong. Run
the API in verbose mode and check the error details in the response body.

### Watch the dashboard

Have the web app open in a browser. The dashboard auto-refreshes every 15s.
Within ~30s of the daemon starting, you should see time appearing in the
stacked bar chart (in the "current hour" bucket for now).

## 9. Commit `[commit]`

```sh
git add -A
git commit -m "feat(daemon): stub tracker + uplink + tray + enroll subcommand"
```

## Common pitfalls

### `getlantern/systray` fails to build on Linux without GTK dev deps
Install them: `sudo pacman -S gtk3` (Arch) or equivalent. If you can't,
stub the tray file (as shown above) and move on. Re-add later.

### `badger` opens slowly first time
badger needs to initialize a directory. It can take a few seconds on first
run. Use `/tmp/ctrluhr-queue` for development; for production phase-1
consider `~/.local/share/ctrluhr/queue`.

### `json.Unmarshal` panics on `time.Time`
`time.Time` needs a string in RFC3339 format. `time.MarshalJSON` produces
RFC3339, so Go to Go works. If you see parse errors in the API, make sure
`ev.started_at` is sent as an ISO string — `json.Marshal(time.Time)` does
this automatically. Verify by `tail -f` your HTTP requests with a proxy.

### Enroll returns 401 "invalid or expired token"
- Token from web UI has a 30-min window. Re-create if expired.
- API's `vouchers` table lookup found a row but `type !== 'device_enroll'`.
  Check the type column in DB.

### zombie events after kill
If you SIGINT during a flush, badger might keep the events in queue without
releasing them. Next run will re-flush them. Idempotency via the `id` UUID
means no duplicate rows in the DB — just duplicate POSTs that resolve to
`onConflictDoNothing`.

### `go.mod` has `module github.com/btz/ctrluhr/daemon` but imports use `daemon/...`
Go is picky about the module root. You have two options:
1. Use the full module path in imports: `github.com/btz/ctrluhr/daemon/tracker`.
   (Recommended — standard Go style.)
2. Replace with `module daemon` in `go.mod` and keep imports short.

Pick one and be consistent. The code above mixes both — fix it to use the
full path consistently.

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