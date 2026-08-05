# 01 — Monorepo Setup

Goal of this file: scaffold `ctrluhr/` as an Nx monorepo with pnpm
workspaces, Biome for lint/format, a TypeScript base config, and a Go module
for the daemon.

**This phase is built** (ADR-0007). The repo at the workspace root is
the truth; each step's Verify is an idempotent state check you can run to
confirm the repo is where the step expects — which doubles as the entry check.
Run a step's Assumes first; if they fail, the missing Produces belongs to an
earlier step.

You will end up with:

- A git repo at the workspace root (`ctrluhr/`), branch `master`
- Root `package.json`, `pnpm-workspace.yaml`, `nx.json`, `biome.json`,
  `tsconfig.base.json`, `.gitignore`
- `apps/web` scaffolded by the TanStack CLI, renamed to `@ctrluhr/web`
- `apps/api` scaffolded by the Hono CLI, renamed to `@ctrluhr/api`
- `apps/daemon` with a `go.mod` and a stub `main.go`, discovered by Nx via
  `apps/daemon/project.json`
- `packages/schema` created by hand as workspace package `@ctrluhr/schema`
- `pnpm exec nx show projects` lists four projects
- `pnpm exec biome check` is green for the config files 01 owns

Two known gates are currently **not** fully green and are flagged in the
adjudication list (see Pitfalls on Steps 3 and 9): `@ctrluhr/schema:build`
fails (no `packages/schema/tsconfig.json`), and `pnpm exec biome check .` is
red repo-wide because of files built by docs 02–04.

## Prerequisites (install once before you begin)

Verify each with the listed command. If a command prints a version at or above
the floor, you're set; otherwise install. This repo was built with
Node 25.7.0 / pnpm 11.13.0 / Bun 1.3.10 / Go 1.26.5.

```sh
node --version   # >= 20.19 (Vite 8 requires ^20.19.0 || >=22.12.0)
pnpm --version   # >= 11.8 (root devEngines pins ^11.8.0)
bun --version    # >= 1.1
go version       # >= 1.22 (go.mod here was written by go 1.26.5)
git --version    # any modern version
```

If `pnpm` is missing: `npm i -g pnpm`.
If `bun` is missing: `curl -fsSL https://bun.sh/install | bash`.
If `go` is missing: use your distro's package or https://go.dev/dl/.

## Step 1 — Git repo and pnpm workspace root

### Assumes
Prerequisites pass (above). This is the entry step of the whole build.

### Read first
- pnpm workspaces — https://pnpm.io/workspaces — the `pnpm-workspace.yaml`
  file and how workspace packages are discovered (`apps/*`, `packages/*`).
- pnpm install — https://pnpm.io/cli/install — what the first `pnpm install`
  does and how `allowBuilds` gates postinstall build scripts.

### Do
From the repo root:

```sh
git init
```

Keep the default branch (`master` in this repo) — `nx.json`'s `defaultBase`
must match it. Create `.gitignore` (below), then the root `package.json` and
`pnpm-workspace.yaml`. The root `package.json` is the **workspace root**, not
a publishable package: `private: true`, the Nx orchestration scripts
(`nx run-many`), and pinned devDependencies (`@biomejs/biome`, `nx`,
`typescript`). `devEngines` tells pnpm which package manager version to use.
`allowBuilds` in `pnpm-workspace.yaml` approves the postinstall build scripts
pnpm blocks by default — Biome, esbuild, and Nx all need their approval or
`pnpm install` ignores their build scripts and the toolchains break at runtime.

Do **not** `pnpm install` yet — we need the workspace file in place first so
the install hoists across the whole monorepo rather than a single package.

`apps/daemon` is Go, not pnpm: it has no `package.json`, so it never matches
the workspace glob. Nx still treats it as a project via
`apps/daemon/project.json` (Step 6).

### Reference (REFERENCE ONLY — sanity-check target, not copy-paste)

`.gitignore`:

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
```

`package.json` (workspace root). The empty `description`/`main`/`keywords`/
`author`/`license` fields are npm-init defaults the repo still carries; they
are never read because this package is private and never imported:

```json
{
  "name": "ctrluhr",
  "version": "0.0.0",
  "description": "",
  "main": "index.js",
  "scripts": {
    "dev": "nx run-many -t dev --parallel",
    "build": "nx run-many -t build",
    "lint": "nx run-many -t lint",
    "typecheck": "nx run-many -t typecheck",
    "test": "nx run-many -t test"
  },
  "keywords": [],
  "author": "",
  "license": "ISC",
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
  },
  "type": "module"
}
```

`pnpm-workspace.yaml`:

```yaml
packages:
  - apps/*
  - packages/*
allowBuilds:
  '@biomejs/biome': true
  esbuild: true
  nx: true
```

### Verify
```sh
test -f .gitignore package.json pnpm-workspace.yaml && echo OK
git rev-parse --is-inside-work-tree      # true
git branch --show-current                # master
node -p "require('./package.json').devDependencies.nx"
# 23.0.2
node -p "require('./package.json').devEngines.packageManager.version"
# ^11.8.0
```

### Produces
Git repo on `master`; root `.gitignore`, `package.json`,
`pnpm-workspace.yaml`. These are the Assumes of every later step.

## Step 2 — Scaffold `apps/web` and `apps/api` with their CLIs

### Assumes
Step 1 complete (root workspace files exist and verify).

### Read first
- TanStack Start quickstart — https://tanstack.com/start/latest/docs/framework/react/getting-started — the scaffold produces this baseline; later docs (04) layer auth/routes/charts on top of whatever the CLI emits.
- Hono — https://hono.dev/docs/getting-started/install — the `create-hono` scaffold and the Bun template we pick.

### Do
We do **not** hand-type the apps' file trees. Scaffolding with each
framework's own CLI buys a correct, current, runnable baseline for free —
`vite.config.ts`, `src/router.tsx`, `src/index.ts`, etc. —
and avoids the double-source-of-truth that bit the earlier hand-rolled tree
(which, for example, never created the `apps/daemon/auth/` dir later docs
need).

If you stubbed `apps/api` or `apps/web` by hand from an earlier version of
this file, delete them first:

```sh
rm -rf apps/api apps/web
```

Run from the repo root:

```sh
pnpm dlx @tanstack/cli@latest create
```

Point the CLI at `apps/web` and pick the Vite-based Start template (the
default). This generates `apps/web/package.json`, `vite.config.ts`,
`tsconfig.json`, `src/router.tsx`, `src/routes/__root.tsx`, and (after the
first `pnpm dev` run) `src/routeTree.gen.ts`. (No `index.html` — TanStack
Start serves the HTML shell from the router; the current repo has none.) The current
repo baseline also carries `devtools()`/`nitro()`/`tailwindcss()` plugins in
`vite.config.ts` and a nested `apps/web/biome.json` (see Step 5).

```sh
pnpm create hono@latest apps/api
```

Pick the `bun` template (we serve the API with Bun). This generates
`apps/api/package.json`, `src/index.ts`, `tsconfig.json`, `README.md`.

Do **not** `pnpm install` after scaffolding — run it only after Step 6 so
pnpm hoists across the whole workspace.

Do **not** pre-bake domain dependencies yet. `echarts`,
`@tanstack/react-query`, `better-auth`, `drizzle-orm`,
`@neondatabase/serverless`, `resend`, `openai`, and the `@ctrluhr/schema`
workspace dep all land in docs 03/04 alongside the code that uses them. Right
now we keep the CLI output untouched except for the retrofit tweaks in Step 6.

The CLI prompts change between releases. If `pnpm dlx @tanstack/cli` errors
or its flags look different, follow the current Quickstart (Read first).

### Verify
```sh
test -f apps/web/package.json apps/web/vite.config.ts apps/web/tsr.config.json apps/web/src/router.tsx && echo OK
# OK
test -f apps/api/package.json apps/api/src/index.ts && echo OK
# OK
node -p "require('./apps/web/package.json').dependencies['@tanstack/react-start']"
# latest
```

### Produces
Runnable CLI baselines for `apps/web` (TanStack Start) and `apps/api`
(Hono on Bun).

## Step 3 — Create `packages/schema` by hand

### Assumes
Step 2 complete (both apps scaffolded).

### Do
No framework CLI matches a tiny workspace-only TS package, so create it
directly. It will hold the shared event schema and zod validation the API
and web app both import; the real content lands in docs 02/03.

```sh
mkdir -p packages/schema/src
```

Write `packages/schema/package.json` (the only `package.json` in this repo
written by hand end-to-end) and a stub `src/index.ts` so the `main` field
resolves. `build` and `typecheck` are the same `tsc --noEmit` because this
package never emits — its consumers bundle the source directly.

### Reference (REFERENCE ONLY — sanity-check target, not copy-paste)

`packages/schema/package.json`:

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
  "dependencies": {
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "typescript": "^5.5.0"
  }
}
```

`packages/schema/src/index.ts` (stub for now — docs 02/03 replace it with the
real schema; the live file today re-exports `./event`):

```ts
export {};
```

### Pitfalls
`pnpm exec nx build @ctrluhr/schema` (and `nx typecheck @ctrluhr/schema`)
**fail in the repo as it stands**. `tsc --noEmit` is run with no input and
prints its help text, then exits 1:

```
Command failed with exit code 1.
ELIFECYCLE  Command failed with exit code 1.
```

Cause: `packages/schema` has no `tsconfig.json`, so `tsc` finds no project
and no input files. The fix is a one-file code fix — add
`packages/schema/tsconfig.json` extending `../../tsconfig.base.json` — which
belongs on the adjudication list (code-fix ticket), not in this doc, because
a fresh builder must land exactly where the repo is. Until then, `nx
run-many -t build` and `-t typecheck` stay red on schema only.

### Verify
```sh
test -f packages/schema/package.json packages/schema/src/index.ts && echo OK
# OK
node -p "require('./packages/schema/package.json').name"
# @ctrluhr/schema
```

### Produces
The `@ctrluhr/schema` workspace package with a stub entry point.

## Step 4 — TypeScript base config

### Assumes
Step 1 complete (root workspace files in place).

### Read first
- TypeScript tsconfig reference — https://www.typescriptlang.org/tsconfig — skim `strict`, `noUncheckedIndexedAccess`, `moduleResolution: "bundler"`, `jsx`.

### Do
Create `tsconfig.base.json` at the repo root. Every TS project in the
monorepo extends from it; per-package `tsconfig.json` files are created in
the docs that build those packages (02/03/04), not here. The flags that
matter: `strict` plus `noUncheckedIndexedAccess` (the array-access guard we
lean on in event/device code), `moduleResolution: "bundler"` (so source
`.ts` files can be imported directly, which is how the `@ctrluhr/schema`
package is consumed), and `jsx: "react-jsx"` for the React app.

### Reference (REFERENCE ONLY — sanity-check target, not copy-paste)

`tsconfig.base.json`:

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

### Verify
```sh
test -f tsconfig.base.json && node -e "const c=require('./tsconfig.base.json').compilerOptions; console.log(c.strict, c.moduleResolution, c.jsx)"
# true bundler react-jsx
```

### Produces
Root `tsconfig.base.json` — the base every per-package `tsconfig.json`
extends.

## Step 5 — Configure Biome and Nx

### Assumes
Steps 1 and 4 complete (root workspace files and `tsconfig.base.json` in
place). Biome and Nx are pinned as devDependencies in the root
`package.json` but not installed until Step 8 — this step only writes their
config files.

### Read first
- Biome configuration reference — https://biomejs.dev/reference/configuration/ — the `files.includes` (v2 replacement for v1's `files.ignore`), `vcs`, `formatter`, `linter`, and `javascript.formatter` sections.
- Nx nx.json reference — https://nx.dev/reference/nx-json — `defaultBase` and `analytics`.

### Do
Write `biome.json` and `nx.json` at the repo root. Nothing runs yet; both
tools are invoked later via `pnpm exec`.

Biome 2.x notes, from real behavior here:

- `files.includes` replaces v1.x `files.ignore`. The leading `**` includes
  everything, then each `!`-prefixed entry subtracts a path — the way to do
  monorepo-wide excludes.
- A sub-package's own `biome.json` is a **nested** config: biome 2.x treats
  it as authoritative for the files under it and the root config only
  applies where no nested config exists. `apps/web` ships one with
  `"root": false` already set — `indentStyle: "tab"` and
  `quoteStyle: "double"` for the web app come from it. Do **not** delete it.
- `apps/daemon/vendor` and `migrations/*.sql` are excluded so Biome doesn't
  reformat generated Go deps or Drizzle's emitted SQL.

Lint ownership: we do **not** ask Nx to lint. Biome owns lint and format;
Nx owns task orchestration, caching, and the project graph.

`nx.json` is deliberately minimal. `defaultBase` must match the git default
branch (`master` here). `analytics: false` opts out of Nx Cloud telemetry —
we do not register the workspace with Nx Cloud in this phase.

### Reference (REFERENCE ONLY — sanity-check target, not copy-paste)

`biome.json`:

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

`nx.json`:

```json
{
  "$schema": "./node_modules/nx/schemas/nx-schema.json",
  "defaultBase": "master",
  "analytics": false
}
```

### Verify
Config files exist and carry the fields that matter. Biome itself isn't
installed until Step 8, so no `pnpm exec` here:

```sh
test -f biome.json nx.json && echo OK
# OK
node -e "const n=require('./nx.json'); console.log(n.defaultBase, n.analytics)"
# master false
node -e "const b=require('./biome.json'); console.log(b.formatter.indentStyle, b.javascript.formatter.quoteStyle)"
# space single
```

### Produces
Root `biome.json` and `nx.json`.

## Step 6 — Retrofit the generated apps into the monorepo

### Assumes
Steps 2, 3, and 5 complete (apps scaffolded, schema package created, Biome
and Nx configured).

### Read first
- Nx project configuration — https://nx.dev/reference/project-configuration — how Nx discovers projects via `package.json` (scripts become targets) or an explicit `project.json`, and the `nx:run-commands` executor for non-native tooling.

### Do
The CLIs produced real, runnable apps with their own naming and script
conventions. We bend them into shape for the Nx + pnpm workspace. Leave the
dependencies the CLI chose alone; domain deps land in docs 03/04.

**`apps/web/package.json`** — the TanStack CLI already writes `dev`/`build`/
`preview`/`test` scripts that match our expectations (Vite + Nitro). Edit:

- `"name"` → `"@ctrluhr/web"`
- `"version"` → `"0.0.0"` (CLIs may use `1.0.0`)
- ensure `"private": true`
- ensure `lint` and `typecheck` scripts exist so `nx run-many -t lint typecheck` finds them: `"lint": "biome check src"`, `"typecheck": "tsc --noEmit"`

**`apps/api/package.json`** — the Hono `bun` template writes `dev` around
`bun run src/index.ts`. The repo's current `dev` is `bun run --hot src/index.ts`
(adjusted later); keep whatever the template wrote for now and tighten it in
`03-api-setup.md`. Edit:

- `"name"` → `"@ctrluhr/api"`
- `"version"` → `"0.0.0"`
- ensure `"private": true`. We do **not** need `"type": "module"` here — Bun
  defaults to ESM, so the template leaves it off.
- ensure `build` and the two lint/typecheck scripts exist: `"build": "bun build src/index.ts --target bun --outdir dist"`, `"lint": "biome check src"`, `"typecheck": "tsc --noEmit"`

Do **not** add `"@ctrluhr/schema": "workspace:*"` yet — the package exists but
has no exports worth importing. That dep lands in `03-api-setup.md` and
`04-web-setup.md` when the first real import lands.

**`apps/daemon/project.json`** — this is the only explicit `project.json` in
the repo. Nx discovers `apps/api` and `apps/web` via their `package.json`
scripts, so they don't need one; `apps/daemon` has no `package.json` (it's
Go), so Nx can't see it without an explicit project file. It also carries the
cross-compile targets that `package.json` discovery can't express:

```sh
mkdir -p apps/daemon
```

Write `apps/daemon/project.json`. `build` cross-compiles Linux + Windows
binaries into `dist/` (`nx:run-commands` with `cache: true`); `dev`, `test`,
`lint`, `typecheck` wrap `go run`, `go test`, `golangci-lint`, and `go vet`.
This is the only `nx:run-commands` use for Go — Go's tooling doesn't plug
into Nx natively, and that's fine.

### Reference (REFERENCE ONLY — sanity-check target, not copy-paste)

Target shape for the two `package.json` edits (deps omitted — they are
whatever the CLI wrote plus later docs):

`apps/web/package.json` — scripts block:

```json
{
  "name": "@ctrluhr/web",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "dev": "vite dev --port 5173",
    "build": "vite build",
    "lint": "biome check src",
    "typecheck": "tsc --noEmit"
  }
}
```

`apps/api/package.json` — scripts block:

```json
{
  "name": "@ctrluhr/api",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "dev": "bun run --hot src/index.ts",
    "build": "bun build src/index.ts --target bun --outdir dist",
    "lint": "biome check src",
    "typecheck": "tsc --noEmit"
  }
}
```

`apps/daemon/project.json`:

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

### Verify
```sh
node -p "require('./apps/web/package.json').name"
# @ctrluhr/web
node -p "require('./apps/web/package.json').scripts.typecheck"
# tsc --noEmit
node -p "require('./apps/api/package.json').name"
# @ctrluhr/api
node -p "require('./apps/api/package.json').scripts.build"
# bun build src/index.ts --target bun --outdir dist
test -f apps/daemon/project.json && node -p "require('./apps/daemon/project.json').name"
# @ctrluhr/daemon
test ! -f apps/api/project.json && test ! -f apps/web/project.json && echo NO_PROJECT_JSON_EXPECTED
# NO_PROJECT_JSON_EXPECTED  (Nx discovers these two via package.json)
```

### Produces
`@ctrluhr/web`, `@ctrluhr/api`, and the `@ctrluhr/daemon` Nx project with
its cross-compile targets.

## Step 7 — Initialize the Go module

### Assumes
Step 6 complete (`apps/daemon` exists with a `project.json`).

### Read first
- Go modules reference — https://go.dev/doc/modules/gomod-ref — `go mod init` and what the `module` directive means for future imports.

### Do
The daemon is Go-only. Initialize its module from inside `apps/daemon`, then
write a stub `main.go` so `go build ./...` has something to build. The
module path is your GitHub username/path — the repo uses
`github.com/btz/ctrluhr/daemon`. It does not need to be a real GitHub repo
yet; it only needs to be consistent, because it is the path every future
import inside the daemon resolves against. `go mod init` writes the `go`
directive from whatever toolchain you have installed (here: `1.26.5`).

```sh
go mod init github.com/btz/ctrluhr/daemon
```

### Reference (REFERENCE ONLY — sanity-check target, not copy-paste)

`apps/daemon/go.mod`:

```
module github.com/btz/ctrluhr/daemon

go 1.26.5
```

`apps/daemon/main.go` (stub tracker; the real trackers land in
`05-daemon-setup.md`):

```go
package main

import (
	"fmt"
	"os"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "dev" {
		fmt.Println("ctrluhr daemon dev mode (stub tracker)")
		fmt.Println("noop - fill me in during 05-daemon-setup.md")
		return
	}
	fmt.Println("ctrluhr daemon - no args provided. Use 'ctrluhr dev' for stub tracker.")
}
```

### Verify
```sh
cd apps/daemon && go build ./... && echo OK
# OK
```

### Produces
`apps/daemon/go.mod` and a stub `apps/daemon/main.go` that builds.

## Step 8 — First install and the Nx project graph

### Assumes
Steps 1–7 complete.

### Read first
- pnpm install — https://pnpm.io/cli/install — flags and lockfile behavior. Nothing to change here; reading confirms what the first install does.

### Do
From the repo root:

```sh
pnpm install
```

This pulls Biome, Nx, TypeScript, and every workspace dependency. Expect a
delay; pnpm caches for next time. The first install writes the root
`pnpm-lock.yaml`, and `allowBuilds` (Step 1) lets Biome/esbuild/Nx run their
postinstall build scripts.

Once it's done, confirm the project graph. In nx 23, `nx show projects`
prints a JSON array of project names — the scoped names come from each
project's `package.json` `name` (`@ctrluhr/api`, `@ctrluhr/web`) or its
`project.json` `name` (`@ctrluhr/daemon`, and schema via `@ctrluhr/schema`).
If a name is missing, that project's `package.json` (or `project.json`) is
missing or malformed.

### Verify
```sh
pnpm exec nx show projects
# ["@ctrluhr/schema","@ctrluhr/daemon","@ctrluhr/api","@ctrluhr/web"]
```

### Produces
`node_modules`, the root `pnpm-lock.yaml`, and a working Nx project graph
listing all four projects.

## Step 9 — Biome sanity check and per-project builds

### Assumes
Step 8 complete (install done, Nx graph green).

### Do
The TanStack and Hono CLIs emit code with their own formatting (double
quotes, no semicolons) that doesn't match the root `biome.json` (single
quotes, semicolons). Reformat the generated files to our style:

```sh
pnpm exec biome check --write .
```

Skim `git diff` afterwards — it should be purely cosmetic
(quotes/semicolons/commas). Note: `--write` mutates files, so it is a Do
command, not part of the Verify below.

### Pitfalls
**`pnpm exec biome check .` is currently red repo-wide** — 7 errors and 4
warnings, all in files created by docs 02–04, none of them this phase's
config files:

- `apps/api/src/auth.ts` — `lint/correctness/noUnusedFunctionParameters`
  (unused `metadata` and `ctx` in the magic-link handler)
- `apps/web/src/routes/_auth/dashboard.tsx` — `lint/style/noNonNullAssertion`
- `apps/web/src/routes/_auth/devices.tsx` — `lint/a11y/useButtonType`
- format diffs in `apps/api/drizzle.config.ts`,
  `apps/api/migrations/*/snapshot.json`, `apps/api/test-resend.ts`,
  `packages/schema/src/event.ts`, `packages/schema/src/index.ts`

This is lint/format debt from later phases, not a 01 regression. It belongs
on the adjudication list (run `biome check --write .` once 02–04 are rebuilt,
or file a code-fix ticket). Until then the green gate for this phase is the
scoped check below, not `biome check .`.

**`@ctrluhr/schema:build` fails** (see Pitfalls on Step 3): `nx run-many -t
build` is red on schema only; `@ctrluhr/api`, `@ctrluhr/web`, and
`@ctrluhr/daemon` build cleanly.

### Verify
Biome loads and the config files this phase owns are clean (the web's
nested `biome.json`, YAML, and JSONC files are skipped by design — a clean
exit is the signal):

```sh
pnpm exec biome --version
# Version: 2.4.5
pnpm exec biome check biome.json package.json nx.json tsconfig.base.json apps/web/vite.config.ts apps/web/tsr.config.json apps/web/tsconfig.json apps/web/package.json apps/api/tsconfig.json apps/api/package.json
# Checked 7 files ... No fixes applied.
```

Each runnable project builds (schema is the known exception, above):

```sh
pnpm exec nx build @ctrluhr/api --skip-nx-cache
# NX  Successfully ran target build for project @ctrluhr/api
pnpm exec nx build @ctrluhr/web --skip-nx-cache
# NX  Successfully ran target build for project @ctrluhr/web
pnpm exec nx build @ctrluhr/daemon --skip-nx-cache
# NX  Successfully ran target build for project @ctrluhr/daemon
```

### Produces
CLI-generated code reformatted to the repo style; api, web, and daemon
builds passing; a working lint/format baseline for docs 02–06.

## Step 10 — Commit `[commit]`

### Assumes
Steps 1–9 done and verified.

### Do
This is the first checkpoint. Everything committed up to here should: live
on `master`, list all four projects in the Nx graph, pass the Step 9 biome
checks, and build for api/web/daemon.

```sh
git add -A
git commit -m "scaffold: nx + pnpm + biome + go monorepo skeleton"
```

### Verify
```sh
git status --short            # empty (nothing uncommitted)
git log --oneline | rg 'scaffold: nx'
# ada08fb scaffold: nx + pnpm + biome + go monorepo skeleton
```

### Produces
The `scaffold: nx + pnpm + biome + go monorepo skeleton` commit — the
Assumes for `02-database-setup.md`.

## Next file

`02-database-setup.md` — Neon project, enable pgvector, write the Drizzle
schema, push the first migration.
