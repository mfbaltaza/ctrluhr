# 01 — Monorepo Setup

Goal of this file: walk you through scaffolding `ctrluhr/` as an Nx monorepo
with pnpm workspaces, Biome for lint/format, and a Go module for the daemon.

You will end up with:

- A git repo at `/home/btz/Code/ctrluhr`
- `nx.json`, root `package.json`, `pnpm-workspace.yaml`, `biome.json`, `tsconfig.base.json`
- Empty `apps/api`, `apps/web`, `apps/daemon`, `packages/schema`, `infra/`
- A Go module at `apps/daemon/go.mod`
- `nx run-many -t build` works (even if builds do nothing yet)
- `biome check .` passes

## Prerequisites (install once before you begin)

Verify each with the listed command. If a command prints a version good enough
for our purposes, you're set; otherwise install.

```
node --version        # need >= 20 (Bun requires it indirectly; TanStack Start prefers 20+)
pnpm --version        # need >= 9; install: npm i -g pnpm
bun --version         # need >= 1.1; install: curl -fsSL https://bun.sh/install | bash
go version           # need >= 1.22
git --version        # any modern version
```

If `pnpm` is missing: `npm i -g pnpm@9`.
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
.vinxi/
*.tsbuildinfo

# env files
.env
.env.local
.env.*.local
!.env.example

# go
*.exe
*.exe~
daemon/ctrluhr
daemon/ctrluhr-*
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
```

Create `package.json` at root (workspace root — not the publishable package):

```json
{
  "name": "ctrluhr",
  "private": true,
  "version": "0.0.0",
  "packageManager": "pnpm@9.0.0",
  "scripts": {
    "dev": "nx run-many -t dev --parallel",
    "build": "nx run-many -t build",
    "lint": "nx run-many -t lint",
    "typecheck": "nx run-many -t typecheck",
    "test": "nx run-many -t test"
  },
  "devDependencies": {
    "@biomejs/biome": "^1.9.0",
    "nx": "^19.7.0",
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

## Step 2 — Create the directory skeleton

```sh
mkdir -p apps/api/src/{routes,lib,schema}
mkdir -p apps/api/migrations
mkdir -p apps/web/src/{routes/_auth,lib/charts,components}
mkdir -p apps/daemon/{tracker,uplink,config,tray}
mkdir -p packages/schema/src
mkdir -p infra/docker
```

Place a stub `package.json` in each TS app/package so pnpm/Nx can see them.
We'll fill them in properly in later steps; for now they're shells.

### `packages/schema/package.json`
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

### `apps/api/package.json`
```json
{
  "name": "@ctrluhr/api",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "bun --watch src/index.ts",
    "build": "bun build src/index.ts --target bun --outdir dist",
    "start": "bun dist/index.js",
    "lint": "biome check src",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@ctrluhr/schema": "workspace:*",
    "hono": "^4.6.0",
    "@hono/zod-validator": "^0.4.0",
    "drizzle-orm": "^0.33.0",
    "better-auth": "^1.0.0",
    "@better-auth/magic-link": "^1.0.0",
    "resend": "^4.0.0",
    "openai": "^4.70.0",
    "@neondatabase/serverless": "^0.10.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/bun": "^1.1.0",
    "drizzle-kit": "^0.25.0",
    "typescript": "^5.5.0"
  }
}
```

Note: the exact package versions above are starting points. Run `pnpm install`
once and let pnpm resolve; if `better-auth` plugins have a different import
path (see their docs), adjust. Anthropic SDK not needed until phase 4.

### `apps/web/package.json`
```json
{
  "name": "@ctrluhr/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vinxi dev --port 3000",
    "build": "vinxi build",
    "start": "vinxi start --port 3000",
    "lint": "biome check src",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@ctrluhr/schema": "workspace:*",
    "@tanstack/react-start": "^1.0.0",
    "@tanstack/react-router": "^1.90.0",
    "@tanstack/react-query": "^5.60.0",
    "@tanstack/react-query-devtools": "^5.60.0",
    "echarts": "^5.5.0",
    "echarts-for-react": "^3.0.2",
       "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "hono": "^4.6.0"
  },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "typescript": "^5.5.0",
    "vinxi": "^0.5.0"
  }
}
```

Note: TanStack Start bundles `@tanstack/react-router` — the explicit dep is
belt-and-braces; remove if duplicated during pnpm install.

### `apps/daemon` — leave without `package.json`. It's Go-only.
Create `apps/daemon/go.mod` directly (Step 4 below).

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

## Step 4 — Install Biome and the Nx config

### `biome.json` (repo root)

```json
{
  "$schema": "./node_modules/@biomejs/biome/configuration_schema.json",
  "vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true },
  "files": {
    "ignoreUnknown": true,
    "ignore": [
      "node_modules",
      "dist",
      "build",
      ".nx",
      "apps/daemon/vendor",
      "**/migrations/*.sql"
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

### `nx.json` (repo root)

```json
{
  "$schema": "./node_modules/nx/schemas/nx-schema.json",
  "targetDefaults": {
    "build": { "dependsOn": ["^build"], "cache": true },
    "lint": { "cache": true },
    "typecheck": { "cache": true }
  },
  "namedInputs": {
    "default": ["{projectRoot}/**/*", "sharedGlobals"],
    "production": ["default"],
    "sharedGlobals": ["{workspaceRoot}/tsconfig.base.json"]
  }
}
```

### `nx-ignore`

Biome and Nx coexist nicely. We do not ask Nx to lint — Biome owns lint.
Nx owns task orchestration, caching, and the project graph.

## Step 5 — Add `project.json` per app

Nx discovers projects via `package.json` OR `project.json`. For TS apps, the
`package.json` is enough (Nx reads its `scripts`). But explicit `project.json`
gives us per-project control over cross-project targets (like Go cross-compile).
Add them:

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
  "name": "daemon",
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
pnpm exec biome check .
```

Expect: a few warnings on empty source files (none yet), but no errors. If
Biome complains about the config itself, fix the schema path.

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
The `vinxi`, `@tanstack/react-start` versions are moving targets. When you
actually scaffold `apps/web` in Step 04, run their CLI initializer instead of
relying on the versions in the package.json above — it will install the
latest compatible versions. Update `apps/web/package.json` accordingly.

## Done criteria for this file

- [ ] Git repo initialized, `.gitignore` committed
- [ ] `package.json`, `pnpm-workspace.yaml`, `nx.json`, `biome.json`,
  `tsconfig.base.json` at root
- [ ] `apps/{api,web,daemon}` and `packages/schema` directories exist with
  stub `package.json` (Go module for daemon)
- [ ] `apps/daemon/go.mod` initialized and `go build ./...` works
- [ ] `pnpm install` succeeds
- [ ] `pnpm exec nx show projects` lists 4 projects
- [ ] `pnpm exec biome check .` passes
- [ ] One commit: "scaffold: nx + pnpm + biome + go monorepo skeleton"

Next file: `02-database-setup.md` — Neon project, enable pgvector, write
Drizzle schema, push your first migration.