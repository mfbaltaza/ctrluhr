# 01 — Monorepo Setup

Goal of this file: walk you through scaffolding `ctrluhr/` as an Nx monorepo
with pnpm workspaces, Biome for lint/format, and a Go module for the daemon.

We do **not** hand-type the apps' file trees. We scaffold each app with its
framework's own CLI (TanStack Start, Hono) so we get correct baselines
(`vite.config.ts`, `src/router.tsx`, `src/index.ts`, etc.) for free, then
retrofit the generated apps into the pnpm workspace + Nx project graph.
`packages/schema` is a tiny TS package with no framework CLI — we create it by
hand. `apps/daemon` is Go — `go mod init` is its CLI.

You will end up with:

- A git repo at `/home/btz/Code/ctrluhr`
- `nx.json`, root `package.json`, `pnpm-workspace.yaml`, `biome.json`, `tsconfig.base.json`
- `apps/api` scaffolded by the Hono CLI, renamed to `@ctrluhr/api`
- `apps/web` scaffolded by the TanStack CLI, renamed to `@ctrluhr/web`
- `apps/daemon` with a `go.mod` and a stub `main.go`
- `packages/schema` created by hand as a workspace TS package
- `nx run-many -t build` works (even if builds are the framework defaults)
- `biome check .` passes

## Prerequisites (install once before you begin)

Verify each with the listed command. If a command prints a version good enough
for our purposes, you're set; otherwise install.

```
node --version        # need >= 20 (Bun requires it indirectly; TanStack Start prefers 20+)
pnpm --version        # need >= 11; install: npm i -g pnpm
bun --version         # need >= 1.1; install: curl -fsSL https://bun.sh/install | bash
go version           # need >= 1.22
git --version        # any modern version
```

If `pnpm` is missing: `npm i -g pnpm@11`.
If `bun` is missing: `curl -fsSL https://bun.sh/install | bash`.
If `go` is missing: use your distro's package or https://go.dev/dl/.

## Step 1 — Init git and the pnpm workspace root

From the repo root `/home/btz/Code/ctrluhr`:

```sh
git init
git branch -m main
```

Create `.gitignore` at the repo root:

```gitignore
# deps
node_modules/
.pnpm-store/

# build outputs
dist/
build/
.next/
.output/
*.tsbuildinfo

# env files
.env
.env.local
.env.*.local
!.env.example

# go
*.exe
*.exe~
apps/daemon/ctrluhr*
apps/daemon/daemon*
vendor/

# os/editor
.DS_Store
Thumbs.db
.idea/
.vscode/
*.swp

# logs
*.log
npm-debug.log*

# nx cache
.nx/cache/
.nx/workspace-data/
.nx/migrate-runs
```

Create `package.json` at root (workspace root — not the publishable package): 

```json
{
  "name": "ctrluhr",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "nx run-many -t dev --parallel",
    "build": "nx run-many -t build",
    "lint": "nx run-many -t lint",
    "typecheck": "nx run-many -t typecheck",
    "test": "nx run-many -t test"
  },
  "devEngines": {
    "packageManager": {
      "name": "pnpm",
      "version": "^11.8.0",
      "onFail": "download"
    }
  },
  "devDependencies": {
    "@biomejs/biome": "2.4.5",
    "nx": "23.0.2",
    "typescript": "^5.5.0"
  }
}
```

Do NOT pnpm install yet — we need the workspace file first.

Create `pnpm-workspace.yaml`:

```yaml
packages:
  - apps/*
  - packages/*
```

Note: `apps/daemon` is Go, not pnpm — that's fine, it simply won't match any
package.json. Nx will still treat it as a project via its `project.json`.

## Step 2 — Scaffold the apps

We could pre-create deep `src/{routes,lib,...}` trees by hand and stub every
`package.json` ourselves — the earlier version of this doc did. The trouble:
empty `src/` dirs don't make a runnable app. You still need
`vite.config.ts`, `tsconfig.json`, `src/router.tsx`, `src/routes/__root.tsx`,
`src/index.ts`, `index.html`, etc., and writing those by hand is exactly what
the framework CLIs are for. Each CLI produces a correct, current, runnable
baseline for free; later docs (03/04/05) then add the ctrluhr-specific files on
top. This also avoids the double-source-of-truth where the pre-created tree
goes stale (e.g. the original mkdir never created `apps/daemon/auth/`, which
`05-daemon-setup.md` needs).

If you already stubbed `apps/api` or `apps/web` from an earlier version of this
file, delete them first:

```sh
rm -rf apps/api apps/web
```

### Step 2a — Scaffold `apps/web` with the TanStack CLI

Run from the repo root:

```sh
pnpm dlx @tanstack/cli@latest create
```

Point the CLI at `apps/web`. Pick the Vite-based Start template (the default).
This generates `apps/web/package.json`, `vite.config.ts`, `tsconfig.json`,
`src/router.tsx`, `src/routeTree.gen.ts` (after first dev run),
`src/routes/__root.tsx`, `index.html`, etc.

> The CLI prompts change between releases. If `pnpm dlx @tanstack/cli` errors
> or its flags look different, follow the current Quickstart:
> https://tanstack.com/start/latest/docs/framework/react/getting-started

We do **not** pre-bake `echarts`, `@tanstack/react-query`, `better-auth/react`,
the `@ctrluhr/schema` workspace dep, or the `lint`/`typecheck` scripts here.
Those land in `04-web-setup.md` as each feature gets built. Right now we keep
the CLI's output untouched except for the retrofit tweaks in Step 5.

### Step 2b — Scaffold `apps/api` with the Hono CLI

```sh
pnpm create hono@latest apps/api
```

Pick the `bun` template when prompted (we serve the API with Bun). This
generates `apps/api/package.json`, `src/index.ts`, `tsconfig.json`,
`bunfig.toml` if needed. Run `pnpm install` only after Step 2c so pnpm hoists
across the whole workspace.

As with the web app, we do **not** pre-bake `drizzle-orm`, `better-auth`,
`@hono/zod-validator`, `@neondatabase/serverless`, `resend`, `openai`, etc.
here. Those land in `03-api-setup.md` with the code that uses them.

### Step 2c — Create `packages/schema` by hand

No CLI matches a tiny workspace-only TS package, so create it directly:

```sh
mkdir -p packages/schema/src
```

`packages/schema/package.json` — the only `package.json` in this repo we write
by hand end-to-end:

```json
{
  "name": "@ctrluhr/schema",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "build": "tsc --noEmit",
    "lint": "biome check src",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": { "zod": "^3.23.0" },
  "devDependencies": { "typescript": "^5.5.0" }
}
```

Add a stub `packages/schema/src/index.ts` so the `main` resolves:

```ts
export {};
```

### Step 2d — `apps/daemon`

`apps/daemon` has no `package.json` — it's Go-only. Create the module and a
stub `main.go` in **Step 6** below. For now just `mkdir -p apps/daemon`. Nx
will discover it later via `apps/daemon/project.json` (Step 5).

## Step 3 — TypeScript base config

Create `tsconfig.base.json` at repo root — all TS projects extend from this:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "moduleResolution": "bundler",
    "module": "ESNext",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "resolveJsonModule": true,
    "verbatimModuleSyntax": false,
    "forceConsistentCasingInFileNames": true,
    "jsx": "react-jsx"
  }
}
```

Then per-package `tsconfig.json` extends from this — created in later setup
docs (02/03/04). Don't create them now.

## Step 4 — Configure Biome and Nx

These are config files only — no install command runs here. Biome and Nx are
pinned as devDependencies in the root `package.json` (Step 1) and pulled in by
`pnpm install` in Step 7. Invoke them via `pnpm exec biome ...` / `pnpm exec nx ...`.

### `biome.json` (repo root)

```json
{
  "$schema": "./node_modules/@biomejs/biome/configuration_schema.json",
  "vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true },
  "files": {
    "ignoreUnknown": true,
    "includes": [
      "**",
      "!**/node_modules",
      "!**/dist",
      "!**/build",
      "!**/.nx",
      "!**/apps/daemon/vendor",
      "!**/migrations/*.sql"
    ]
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "style": { "noNonNullAssertion": "off" }
    }
  },
  "javascript": {
    "formatter": {
      "quoteStyle": "single",
      "trailingCommas": "all",
      "semicolons": "always"
    }
  }
}
```

We are on biome 2.x. Two things to know:

- `files.includes` replaces the v1.x `files.ignore`. The leading `**` includes
  everything, then each `!`-prefixed entry subtracts a path. Use this for
  monorepo-wide excludes.
- If `apps/web` (or any sub-package) ships its own `biome.json`, biome 2.x
  treats it as a **nested** config and the root one only applies where the
  nested one doesn't. The TanStack CLI emits a nested `apps/web/biome.json`
  with `"root": false` already set after the first `pnpm exec biome migrate --write`.
  Do not delete that nested file — the web's `indentStyle: "tab"` and
  `quoteStyle: "double"` come from it.

### `nx.json` (repo root)

```json
{
  "$schema": "./node_modules/nx/schemas/nx-schema.json",
  "defaultBase": "master",
  "analytics": false
}
```

`defaultBase` lives at the top level in nx 23; the older `affected.defaultBase`
form is deprecated. `analytics: false` opts out of Nx Cloud telemetry — we
do not register the workspace with Nx Cloud in this phase.

### Lint ownership

Biome and Nx coexist nicely. We do not ask Nx to lint — Biome owns lint.
Nx owns task orchestration, caching, and the project graph.

## Step 5 — Retrofit the generated apps into the monorepo

The CLIs in Step 2 produced real, runnable apps but with their own naming and
script conventions. We now bend them into shape for the Nx + pnpm workspace.

### 5a — Rename the packages and standardize scripts

Open each CLI-generated `package.json` and make these edits. Leave the
dependencies the CLI chose alone (we'll add domain deps in docs 03/04).

**`apps/web/package.json`** — the TanStack CLI already wrote `dev`/`build`/
`start` scripts that match our expectations (Vite + Nitro). Only edit:

- `"name"` → `"@ctrluhr/web"`
- `"version"` → `"0.0.0"` (CLIs may use `1.0.0`)
- Ensure `"private": true`
- Ensure these two scripts exist so `nx run-many -t lint typecheck` finds them:

```json
"lint": "biome check src",
"typecheck": "tsc --noEmit"
```

**`apps/api/package.json`** — the Hono `bun` template wrote `dev`/`start`
around `bun run --watch src/index.ts` and `bun run src/index.ts`. Keep those
for now (we'll tighten them in `03-api-setup.md`). Edit:

- `"name"` → `"@ctrluhr/api"`
- `"version"` → `"0.0.0"`
- Ensure `"private": true`. We do **not** need `"type": "module"` here — Bun
  defaults to ESM, so the Hono `bun` template leaves it off.
- Ensure a `build` script and the two lint/typecheck scripts exist:

```json
"build": "bun build src/index.ts --target bun --outdir dist",
"lint": "biome check src",
"typecheck": "tsc --noEmit"
```

Do **not** add `"@ctrluhr/schema": "workspace:*"` yet — the schema package
exists but has no exports worth importing. We'll add that dep in `03-api-setup.md`
and `04-web-setup.md` when the first real import lands.

### 5b — Add `project.json` per app

Nx discovers projects via `package.json` OR `project.json`. For TS apps, the
`package.json` is enough (Nx reads its `scripts`). But explicit `project.json`
gives us per-project control over cross-project targets (like Go cross-compile)
and a place for tags. Add them:

### `apps/api/project.json`
```json
{
  "$schema": "../../node_modules/nx/schemas/project-schema.json",
  "name": "api",
  "tags": ["scope:api", "type:service"]
}
```

### `apps/web/project.json`
```json
{
  "$schema": "../../node_modules/nx/schemas/project-schema.json",
  "name": "web",
  "tags": ["scope:web", "type:app"]
}
```

### `apps/daemon/project.json` (Go project — no package.json)
```json
{
  "$schema": "../../node_modules/nx/schemas/project-schema.json",
  "name": "@ctrluhr/daemon",
  "tags": ["scope:daemon", "type:binary"],
  "targets": {
    "build": {
      "executor": "nx:run-commands",
      "cache": true,
      "options": {
        "cwd": "apps/daemon",
        "commands": [
          "GOOS=linux GOARCH=amd64 go build -o ../../dist/ctrluhr-linux-amd64 ./...",
          "GOOS=windows GOARCH=amd64 go build -o ../../dist/ctrluhr-windows-amd64.exe ./..."
        ]
      }
    },
    "dev": {
      "executor": "nx:run-commands",
      "options": { "cwd": "apps/daemon", "command": "go run . dev" }
    },
    "test": {
      "executor": "nx:run-commands",
      "options": { "cwd": "apps/daemon", "command": "go test ./..." }
    },
    "lint": {
      "executor": "nx:run-commands",
      "options": { "cwd": "apps/daemon", "command": "golangci-lint run ./..." }
    },
    "typecheck": {
      "executor": "nx:run-commands",
      "options": { "cwd": "apps/daemon", "command": "go vet ./..." }
    }
  }
}
```

This is the only place we use `nx:run-commands` for Go — fine, since Go's
tooling doesn't plug into Nx natively.

## Step 6 — Initialize the Go module

```sh
cd apps/daemon
go mod init github.com/btz/ctrluhr/daemon
cd ../..
```

Replace `github.com/btz/ctrluhr` with your actual GitHub username/path. This
is the module path other Go imports will use.

Create `apps/daemon/main.go` as a stub:

```go
package main

import (
	"fmt"
	"os"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "dev" {
		fmt.Println("ctrluhr daemon dev mode (stub tracker)")
		fmt.Println("noop — fill me in during 05-daemon-setup.md")
		return
	}
	fmt.Println("ctrluhr daemon — no args provided. Use 'ctrluhr dev' for stub tracker.")
}
```

Now verify the Go toolchain is happy:

```sh
cd apps/daemon && go build ./... && echo OK
```

## Step 7 — First install + verify Nx sees everything

From the repo root:

```sh
pnpm install
```

This pulls Biome, Nx, TS, all workspace deps. Expect a delay here; pnpm caches
for next time.

Once it's done, verify the project graph:

```sh
pnpm exec nx show projects
```

Expected output (order may differ):

```
api
web
daemon
schema
```

If `daemon` is missing, your `apps/daemon/project.json` is wrong. If `api` or
`web` or `schema` are missing, the matching `package.json` is missing or
malformed.

## Step 8 — Biome sanity check

```sh
pnpm exec biome --version
pnpm exec biome check --write .
pnpm exec biome check .
```

The TanStack and Hono CLIs emit code with their own formatting (double quotes,
no semicolons, etc.) that doesn't match our `biome.json` (single quotes,
semicolons). The `--write` run rewrites the generated files to our style;
the second run should be clean. Skim the diff `git diff` afterwards — it
should be purely cosmetic (quotes/semicolons/commas). If Biome complains about
the config itself, fix the schema path.

## Step 9 — Optional initial docs commit `[commit]`

This is your first checkpoint. Everything committed up to here should:

- `git init` runs
- `pnpm exec nx show projects` lists `api`, `web`, `daemon`, `schema`
- `pnpm exec biome check .` passes
- `cd apps/daemon && go build ./...` succeeds

```sh
git add -A
git commit -m "scaffold: nx + pnpm + biome + go monorepo skeleton"
```

## Common pitfalls

### `pnpm install` reports peer dep warnings
If it's peer deps mismatch (e.g. React 19 vs something asking for 18), write
down the warning and move on. Resolve only if pnpm actually refuses to
install.

### `nx show projects` doesn't list daemon
Check that `apps/daemon/project.json` exists, is valid JSON, has a `name`. Nx
also requires at least one target or a package.json — we have both.

### `go mod init` complains the path is not yours
The module path doesn't have to be a real GitHub repo. Use
`github.com/<your-username>/ctrluhr/daemon` even if you haven't created the
GitHub repo yet. Just be consistent.

### `bun --version` works but `pnpm exec` doesn't find bun
Our setup uses pnpm for orchestration and Bun only inside `@ctrluhr/api` for
serving. That's intentional. `bun` should be available on PATH globally for
Step 7+ (api dev).

### TanStack Start versions
The `@tanstack/react-start` and `vite` / `@vitejs/plugin-react` / `nitro`
versions are moving targets. We scaffold `apps/web` with
`pnpm dlx @tanstack/cli@latest create` in Step 2a so we always get the latest
compatible versions. If the CLI's prompts or output differ from what's
described here, follow the current Quickstart:
https://tanstack.com/start/latest/docs/framework/react/getting-started
`04-web-setup.md` then layers auth/routes/charts on top of whatever the CLI
produced. The setup above drops the older `vinxi` runtime in favour of the
current Vite + Nitro plugin stack.

## Done criteria for this file

- [X] Git repo initialized, `.gitignore` committed
- [X] `package.json`, `pnpm-workspace.yaml`, `nx.json`, `biome.json`,
  `tsconfig.base.json` at root
- [x] `apps/web` scaffolded by the TanStack CLI and renamed to `@ctrluhr/web`
- [x] `apps/api` scaffolded by the Hono CLI and renamed to `@ctrluhr/api`
- [X] `apps/daemon` exists with `go.mod` and a stub `main.go`; `go build ./...` works
- [x] `packages/schema` created by hand as `@ctrluhr/schema`
- [ ] Each app has a `project.json` with tags
- [X] `pnpm install` succeeds
- [X] `pnpm exec nx show projects` lists 4 projects
- [ ] `pnpm exec biome check .` passes
- [ ] One commit: "scaffold: nx + pnpm + biome + go monorepo skeleton"

Next file: `02-database-setup.md` — Neon project, enable pgvector, write
Drizzle schema, push your first migration.