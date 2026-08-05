# 03 — API Setup

Goal: a running Hono server on Bun that:

- boots on `:3000`
- mounts better-auth `/auth/*` with magic link (Resend email)
- exposes `POST /events` (Device Key auth) — validate + idempotently persist batches, return receipts
- exposes `POST /devices` (user session auth) — create an Enrollment Token
- exposes `POST /devices/enroll` (token auth) — exchange the token for a long-lived Device Key
- exposes `GET /analytics/day` (user session auth) — daily aggregates for the dashboard
- exposes `GET /healthz` (no auth) — liveness probe

By the end: `curl /healthz` returns 200, a magic-link login lands a session cookie,
and a Device can enroll and post an event batch that shows up in `/analytics/day`.

## State of this file

This file follows the convention in `docs/README.md` (ADR-0007): every step is
eight fields, Assumes/Produces chain the steps together, Verify blocks are law,
code wins for built phases. The ADRs that constrain this phase:

- **ADR-0006** — auth-managed id columns are `text`; §3.5 schema-sync is mandatory.
- **ADR-0005** — Devices are Revoked, not deleted; device auth is JWT signature +
  a per-batch DB status check; rotation is revoke + re-enroll (no token-hash dance).
- **ADR-0004** — productivity is read live from the Category, never stored on the event.
- **ADR-0003** — analytics day boundaries are the User's local timezone.
- **ADR-0002** — server-side embedding categorization is superseded; phase 0's
  events route is **ingest-only** (validate, idempotent insert, return receipts).

Built vs plan-first, checked against `apps/api/src/`:

| Section | Status | Evidence |
| --- | --- | --- |
| §0 deps | **built** | `apps/api/package.json` |
| §1 DB client | **built** | `apps/api/src/lib/db.ts` |
| §2 schema package | **built** | `packages/schema/src/event.ts` |
| §3 better-auth + schema-sync | **built** | `apps/api/src/auth.ts`, `src/schema/*`, `test-resend.ts` |
| §4 Hono bootstrap | **plan-first** | `apps/api/src/index.ts` is still the bare hello-world scaffold |
| §5 auth middlewares | **plan-first** | `src/lib/` contains only `db.ts`; no `hono-factory.ts`/`session.ts`/`device-jwt.ts`/`device-auth.ts` |
| §6 devices routes | **plan-first** | no `src/routes/` directory at all |
| §7 events route | **plan-first** | no `src/routes/events.ts` |
| §8 analytics route | **plan-first** | no `src/routes/analytics.ts` |
| §9 run + verify | **mixed** | built smoke test exists; boot/curl flow needs §4–8 |

The doc's domain terms come from `CONTEXT.md` — a **Device Key** is the long-lived
JWT, an **Enrollment Token** is the one-time short-lived secret exchanged for it.

## 0. Install the API deps

### Assumes

`01-monorepo-setup.md` produced `apps/api` (Hono scaffold, Bun, TS), and
`02-database-setup.md` produced the Neon DB + `drizzle-orm`/`drizzle-kit`/
`@neondatabase/serverless` in `apps/api`.

### Do

This step is built. The domain deps were deliberately not pre-baked in 01; they
landed here with the code that uses them:

```sh
pnpm --filter @ctrluhr/api add better-auth @better-auth/drizzle-adapter resend jose @hono/zod-validator dotenv
```

`pnpm install` from the root afterwards to link the workspace `@ctrluhr/schema`
package (its `main` points straight at `src/index.ts`, so no build step).

Two deps are present but **inert in phase 0** — don't reach for them:

- `openai` — installed for the original server-side categorizer, superseded by
  ADR-0002. It stays installed (the SDK is used in phase 2's browser-mediated
  work) but phase 0 never calls it. `OPENAI_API_KEY` in `.env.example` is a placeholder.
- `@hono/zod-validator` — a convenience for validating route bodies. Phase 0's
  events route parses with `safeParse` from the schema package instead; the
  validator is there if you want it on other routes.

### Verify

```sh
pnpm --filter @ctrluhr/api typecheck
```

Expected: `tsc --noEmit` exits 0 with no output. If TypeScript can't resolve a
package, `pnpm install` from the root is the fix.

```sh
ls apps/api/node_modules/hono apps/api/node_modules/better-auth apps/api/node_modules/@better-auth/drizzle-adapter apps/api/node_modules/resend apps/api/node_modules/jose apps/api/node_modules/drizzle-orm apps/api/node_modules/@neondatabase/serverless apps/api/node_modules/@hono/zod-validator
```

Expected: eight directory names printed, no `ls: cannot access` lines.

### Produces

`apps/api/package.json` carries the runtime deps; `apps/api/node_modules` is populated.

---

## 1. The DB client

### Assumes

§0's Produces (deps present). `02-database-setup.md` produced the
`apps/api/.env` file with a `DB_URL` connection string.

### Read first

1. **Drizzle — neon-http driver** — https://orm.drizzle.team/docs/get-started/neon-new
   The `drizzle({ client })` constructor shape. The "driver" section shows why
   `neon-http` (HTTP over the Postgres wire) is the right fit for Bun and edge.
2. **Drizzle — schema definition** — https://orm.drizzle.team/docs/sql-schema-declaration
   Skim only: the repo's tables are declared in `src/schema/*` (from 02), and
   `lib/db.ts` just binds the driver to that schema.

### Do

### `apps/api/src/lib/db.ts`

Built in this exact shape — the file is the repo truth, and two details in it
are deliberate:

- **`drizzle-orm/neon-http`, not `neon-serverless`.** In current drizzle-orm the
  HTTP driver lives at `drizzle-orm/neon-http`; the older `neon-serverless`
  subpath was removed. This repo pins `drizzle-orm@1.0.0-rc.4`, so the rc's
  current subpaths are what matter — check `node_modules/drizzle-orm/` if it ever
  changes, the official docs stay the source of truth.
- **No `schema` binding.** drizzle-orm 1.0 dropped the `drizzle(sql, { schema })`
  second argument; `drizzle({ client })` is the whole constructor. better-auth's
  `drizzleAdapter` receives the schema map separately (see §3.4). Don't try to
  re-add the schema argument — it's gone.
- **`DB_URL`, not `DATABASE_URL`.** The repo standardised on `DB_URL` in
  `.env.example`, `lib/db.ts`, and `drizzle.config.ts`. Doc 02 was corrected to
  `DB_URL` in the same pass — see the adjudication list.

#### Reference — what the file is

```ts
// apps/api/src/lib/db.ts — REFERENCE ONLY
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';

const connectionString = process.env.DB_URL!;

const sql = neon(connectionString);
export const db = drizzle({ client: sql });
export type DB = typeof db;
```

### Verify

```sh
bun --env-file=apps/api/.env -e "import { db } from './apps/api/src/lib/db.ts'; console.log('db ok', typeof db.select);"
```

Expected: `db ok function`. If it throws, the driver subpath changed or `DB_URL`
isn't reachable from `.env`.

### Produces

`apps/api/src/lib/db.ts` (exists already) — the shared Drizzle client used by
every route and by §3.4's `drizzleAdapter`.

---

## 2. The schema package

### Assumes

§0's Produces. `packages/schema` is a workspace package (`pnpm-workspace.yaml`
covers `packages/*`), wired as a dependency of `apps/api`.

### Do

### `packages/schema/src/event.ts`

The single source of truth for the wire format between the daemon and the API.
Everything else — Hono validation, the daemon's JSON, later the web client — is
generated from here. Built exactly as below.

Two things worth understanding:

- **The event `id` is caller-generated.** `z.string().uuid()` because the daemon
  generates event ids at emission time and the API's idempotent insert keys on
  them (ADR-0006: ids are `text` in the DB, supplied by the caller, never
  `gen_random_uuid()`). The DB column is `text`; a UUID string is text.
- **`EventReceiptSchema` is the per-event result** the API returns. In phase 0
  `category_id` is always `null` — nothing categorizes events yet (§7). The
  field stays in the wire type so the daemon's local-state bookkeeping doesn't
  change when categorization lands.

#### Reference — what the files are

```ts
// packages/schema/src/event.ts — REFERENCE ONLY
import { z } from 'zod';

/** A single activity window observed by the daemon. */
export const ActivityEventSchema = z.object({
  id: z.string().uuid(),
  app_name: z.string().min(1).max(200),
  window_title: z.string().min(1).max(500),
  started_at: z.string().datetime(),
  ended_at: z.string().datetime(),
});

/** Batch posted by the daemon. */
export const EventBatchSchema = z.object({
  events: z.array(ActivityEventSchema).max(500),
});

export type ActivityEvent = z.infer<typeof ActivityEventSchema>;
export type EventBatch = z.infer<typeof EventBatchSchema>;

/** The per-event result the API returns. */
export const EventReceiptSchema = z.object({
  id: z.string().uuid(),
  category_id: z.string().uuid().nullable(),
});

export type EventReceipt = z.infer<typeof EventReceiptSchema>;
```

```ts
// packages/schema/src/index.ts — REFERENCE ONLY
export * from './event';
```

### Verify

```sh
bun -e "import { ActivityEventSchema, EventBatchSchema, EventReceiptSchema } from './packages/schema/src/index.ts'; const ok = EventBatchSchema.safeParse({ events: [{ id: crypto.randomUUID(), app_name: 'Code', window_title: 'writing docs', started_at: new Date().toISOString(), ended_at: new Date().toISOString() }] }); console.log('schema ok', ok.success);"
```

Expected: `schema ok true`. A batch with a valid event parses.

### Pitfalls

- `pnpm --filter @ctrluhr/schema typecheck` **fails** — `packages/schema` has no
  `tsconfig.json`, so its own `tsc --noEmit` script can't run (tsc prints help
  and exits 1). The package is consumed as raw TS by Bun, which doesn't need one.
  Adding a `tsconfig.json` is a code-fix ticket, not a doc change (adjudication list).

### Produces

`packages/schema/src/event.ts` + `src/index.ts` (exist already) — `ActivityEventSchema`,
`EventBatchSchema`, `EventReceiptSchema` and their types.

---

## 3. better-auth magic link

better-auth runs as its own module, `apps/api/src/auth.ts`. The web app talks to
it through the `better-auth/client` SDK (that's `04-web-setup.md`); the API
mounts its handler at `/auth/*` (that's §4). Sections 3.1–3.5 are built —
read them to learn the shape, then check §3.6's Verify to confirm your checkout
matches.

### Assumes

- §0's Produces: `better-auth`, `@better-auth/drizzle-adapter`, `resend`,
  `jose`, and `dotenv` are installed in `apps/api`.
- §1's Produces: `lib/db.ts` exists and the §1 import check passes.
- §2's Produces: `packages/schema` is wired as an `apps/api` dependency.
- `02-database-setup.md` produced `apps/api/.env` / `.env.example` (with
  `DB_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`) and the hand-written
  `src/schema/{index,users,sessions,verifications}.ts`.

### 3.1 Read these in order

Walk these in order; each is short and they link to each other (~20 minutes total):

1. **Installation** — https://www.better-auth.com/docs/installation
   The `auth.ts` shape, env vars, database wiring, and the Hono handler snippet
   (the mount pattern we use in §4).
2. **Drizzle ORM Adapter** — https://www.better-auth.com/docs/adapters/drizzle
   Read the "Modifying Table Names" and "Schema generation & migration" sections
   — both matter here.
3. **Magic Link plugin** — https://www.better-auth.com/docs/plugins/magic-link
   The auth method. Read "Installation" (server) and "Configuration Options"
   (especially `sendMagicLink`'s callback args). Ignore the client plugin — that's 04.
4. **CLI** — https://www.better-auth.com/docs/concepts/cli
   The `generate` command — what reconciles better-auth's required columns with
   our Drizzle schema in §3.5.
5. **Basic Usage → Server-side `getSession`** — https://www.better-auth.com/docs/basic-usage
   The exact API `lib/session.ts` calls in §5.3.

Don't read social providers, 2FA, organizations — none of it applies to phase 0.

### 3.2 Install the Drizzle adapter

The adapter is a separate package for current better-auth versions:

```sh
pnpm --filter @ctrluhr/api add @better-auth/drizzle-adapter
```

Verify it landed: `ls apps/api/node_modules/@better-auth/drizzle-adapter`.
(If your version ships the adapter bundled instead, the official adapter docs
show the correct import path — code wins.)

### 3.3 Env vars

The official Installation docs name two required env vars; both are already in
`apps/api/.env.example` and `apps/api/.env`:

- `BETTER_AUTH_SECRET` — random 32+ char string (`openssl rand -base64 32`). We
  also reuse it as the Device Key HMAC secret in §5.4 — one high-entropy secret,
  don't mint a second.
- `BETTER_AUTH_URL` — base URL of the API: `http://localhost:3000` in dev.
  The handler reads it automatically. (An earlier draft used `BETTER_AUTH_BASE_URL`
  — that var is wrong; it's `BETTER_AUTH_URL`.)

Plus Resend:

- `RESEND_API_KEY` — from https://resend.com/api-keys.
- `RESEND_FROM_EMAIL` — required here (the built `auth.ts` non-null-asserts it).
  In dev use Resend's sandbox sender `onboarding@resend.dev`, which only
  delivers to the email on your Resend account — that's fine, that's your test inbox.

### 3.4 Create `apps/api/src/auth.ts`

By now you've read the five pages in 3.1. The file exists — read it and confirm
you understand each choice, then compare against the reference:

- `drizzleAdapter(db, { provider: 'pg', schema: { user, session, verification } })`
  — maps better-auth's singular table names to our plural Drizzle tables via the
  "Modifying Table Names" pattern. The schema map goes **here**, not in `lib/db.ts`
  (§1), because drizzle-orm 1.0 removed schema binding from the constructor.
- `emailAndPassword: { enabled: false }` — magic link only.
- `magicLink({ sendMagicLink })` — the callback sends the URL via Resend. Note
  it returns without awaiting `resend.emails.send(...)`: the email is fire-and-
  forget from better-auth's perspective; the magic-link *token row* is what the
  schema-sync regression test in §3.5 asserts on.

#### Reference — what the file is

```ts
// apps/api/src/auth.ts — REFERENCE ONLY
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { betterAuth } from 'better-auth';
import { magicLink } from 'better-auth/plugins';
import { Resend } from 'resend';
import { db } from './lib/db';
import * as schema from './schema';

const resend = new Resend(process.env.RESEND_API_KEY!);

export const auth = betterAuth({
  emailAndPassword: { enabled: false },
  plugins: [
    magicLink({
      sendMagicLink: async ({ email, token, url, metadata }, ctx) => {
        const from = process.env.RESEND_FROM_EMAIL!;
        resend.emails.send({
          from,
          to: email,
          subject: 'Sign in to ctrluhr',
          html: `<a href="${url}">Click here to sign in</a>`,
        });
      },
    }),
  ],
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema: {
      user: schema.users,
      session: schema.sessions,
      verification: schema.verifications,
    },
  }),
});

export type Auth = typeof auth;
```

### 3.5 Sync the schema — mandatory (ADR-0006)

**This step is not optional.** Its Verify is the project's regression test for
"auth and schema are in sync." Skipping it is how ADR-0006 happened.

better-auth expects specific columns on `users` / `sessions` / `verifications`
(e.g. `image` on users, `identifier`/`value`/`expires_at` on verifications).
The repo's hand-written schema files were already reconciled to that shape — this
step is the *mechanism*, so you know how to re-run it when the library changes.

**Do**

1. Run the CLI's `generate` to a scratch file and diff it against our hand-written
   schema. The CLI writes its own `auth-schema.ts` — a throwaway reference, never
   part of our tree:

   ```sh
   cd apps/api
   pnpm dlx auth@latest generate --config src/auth.ts --output /tmp/auth-schema.ts --yes
   ```

   `pnpm dlx`, not `pnpm exec` — `pnpm exec` resolves a *local* package and won't
   find the on-demand CLI (real error below). The flags change between versions;
   always check the CLI page in 3.1.

2. Compare the generated columns to `src/schema/{users,sessions,verifications}.ts`
   and reconcile **our** files, adding anything better-auth now needs. Do not keep
   the generated file — delete it after the diff. (ADR-0006: it's re-generated
   for diffs, not kept in the tree.)
3. If anything changed, run the migration flow from 02. Note the commands target
   `@ctrluhr/api` (where `drizzle.config.ts` and `drizzle-kit` live), not a
   non-existent `@ctrluhr/db`:

   ```sh
   cd apps/api
   pnpm exec drizzle-kit generate
   pnpm exec drizzle-kit push
   ```

   (`pnpm exec drizzle-kit` is right here — drizzle-kit IS a local package.)

**Why it matters:** better-auth writes `sessions`/`verifications` rows on every
login. If our columns drift from what better-auth's client emits, the magic link
fails at the database — not with a friendly error, but with Postgres's raw type
error. That's exactly the class of bug this Verify exists to catch.

**Verify**

```sh
cd apps/api
bun test-resend.ts
```

This is `apps/api/test-resend.ts` — the magic-link smoke test. It calls
`auth.api.signInMagicLink` and compares `verifications` row counts before and
after. It needs a working `.env` (DB + Resend + `SMOKE_TEST_EMAIL`), which is
why it lives outside `src/` with the `SMOKE_TEST_EMAIL` placeholder in
`.env.example`.

Expected: it logs an object like `{ status: ..., rows: { before: 0, after: 1, latest: {...} } }` —
`rows.after` greater than `rows.before`, and `latest` is a new `verifications` row.
If the schema drifted, this throws with the `22P02` error below.

**Pitfalls**

- `22P02 invalid input syntax for type uuid: <32-char hex>` — the ADR-0006
  failure. A uuid column is receiving better-auth's text id. Fix: the column is
  `text` (the migration in 02's §3 applied `ALTER COLUMN ... TYPE text`), never
  `uuid`. If this error reappears after a schema regen, §3.5 was skipped.
- `pnpm exec auth@latest generate` fails to find the CLI — expected: `exec`
  resolves local packages. Use `pnpm dlx auth@latest generate` (or `npx …`).
- The generated `auth-schema.ts` must not be committed — it's a diff target.
  ADR-0006 dropped it from the tree after the migration applied.

### 3.6 What you should be able to do now

**Verify**

```sh
bun --env-file=apps/api/.env -e "import { auth } from './apps/api/src/auth.ts'; console.log('auth ok', typeof auth.handler);"
```

Expected: `auth ok function`. A thrown error at import time tells you what's
missing (env var, column, import path).

```sh
cd apps/api && pnpm dlx auth@latest generate --config src/auth.ts --output /tmp/auth-schema.ts --yes
rg -n "image" src/schema/users.ts
rg -n "token|type" src/schema/verifications.ts
```

Expected: the generate succeeds; `users.ts` shows an `image` column; the
`verifications.ts` check prints nothing (the `token`/`type` columns were dropped
by the ADR-0006 migration). A match on the second `rg` is the drift ADR-0006
caught — don't proceed until it's gone. The real end-to-end signal is the §3.5
smoke test.

### Produces

`apps/api/src/auth.ts` and `src/schema/{users,sessions,verifications}.ts` (exist
already), plus `apps/api/test-resend.ts` as the auth↔schema regression test.

---

## 4. Hono bootstrap

This is the first plan-first step. `src/index.ts` is still the hello-world
scaffold from 01. Everything from here is verified against official docs and the
ADRs, not against code.

### Assumes

- §3's Produces: `src/auth.ts` exists and the §3.6 import check passes.
- §0's Produces: `hono` and friends are installed.
- `bun run dev` from `apps/api` currently boots the hello-world app (the script
  is `bun run --hot src/index.ts`).

### Read first

1. **Hono — Getting Started** — https://hono.dev/docs/getting-started/basic
   The `new Hono()` → `app.get()` shape and request/response helpers. All of it applies.
2. **Hono — Custom Middleware** — https://hono.dev/docs/guides/middleware
   "Writing your own middleware" and `c.set`/`c.get` typed `Variables` (`set()`/`get()`
   also on https://hono.dev/docs/api/context) — used heavily in §5.
3. **Hono — CORS middleware** — https://hono.dev/docs/middleware/builtin/cors
   Cross-origin cookies: `credentials: true` is what lets the web app on `:5173`
   hold the session cookie set by the API on `:3000`. Without it the browser
   drops the cookie and `getSession` always returns null.
4. **Hono — the `app.route()` method** — https://hono.dev/docs/api/hono
   "Grouping routes" — how `eventsRoute`/`devicesRoute`/`analyticsRoute` mount
   (`concepts/routers` is the internal router engines, not this).
5. **better-auth — Hono integration** — https://www.better-auth.com/docs/integrations/hono
   The correct way to mount the auth handler — read before writing, see below.
6. **Bun — HTTP server** — https://bun.sh/docs/runtime/http
   The "export default syntax" section. Hono's docs show `export default app`
   (Worker/Deno shape); **Bun is different** — it wants `{ port, fetch }` so
   `Bun.serve` picks it up. Don't paste the Worker default export blindly.

### Do

### Write `apps/api/src/index.ts`

Walk the file mentally before writing:

- One `app = new Hono()`.
- `app.use('*', logger())` — dev only; fine as-is for phase 0.
- `app.use('*', cors({ origin: process.env.WEB_ORIGIN ?? 'http://localhost:5173', credentials: true }))`
  — origin from `WEB_ORIGIN` so prod config never needs a code change.
- `app.get('/healthz', c => c.json({ ok: true }))` — liveness, no auth.
- **Mount better-auth with `app.on`, not `app.route`.** The handler is a plain
  fetch handler, not a Hono app; per the integration docs:

  ```ts
  app.on(['POST', 'GET'], '/auth/*', (c) => auth.handler(c.req.raw));
  ```

  This reaches better-auth's routes as `/auth/sign-in/magic-link`, `/auth/get-session`, etc.
- Mount the three sub-routers with `app.route('/events', eventsRoute)` (etc.).
  You haven't written them yet (§6–§8) — add each import as you create the file,
  TS will yell at you until the module exists.
- `export default { port, fetch: app.fetch }` — the Bun entry point.

#### Reference — the target shape

```ts
// apps/api/src/index.ts — REFERENCE ONLY
// Write by following the Read first list, then compare against this.

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { auth } from './auth';
import { eventsRoute } from './routes/events';
import { devicesRoute } from './routes/devices';
import { analyticsRoute } from './routes/analytics';

const app = new Hono();

app.use('*', logger());
app.use(
  '*',
  cors({
    origin: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
    credentials: true,
  }),
);

app.get('/healthz', (c) => c.json({ ok: true }));

app.on(['POST', 'GET'], '/auth/*', (c) => auth.handler(c.req.raw));

app.route('/events', eventsRoute);
app.route('/devices', devicesRoute);
app.route('/analytics', analyticsRoute);

const port = Number(process.env.PORT ?? 3000);
export default { port, fetch: app.fetch };
```

### Verify

```sh
cd apps/api && bun run dev
```

In another terminal:

```sh
curl -s http://localhost:3000/healthz
```

Expected: `{"ok":true}`.

```sh
curl -s http://localhost:3000/auth/get-session
```

Expected: `{"data":null,"error":null}` for an unauthenticated request. A different
shape (or a 404) means the handler mount is wrong — re-read the better-auth Hono
page and the `app.on` pattern. Don't move to §5 with a broken bootstrap.

### Produces

`apps/api/src/index.ts` — boots Hono on `:3000` with healthz + auth mounted.

---

## 5. Auth middlewares

Two middlewares do the auth work, plus one tiny factory for typed Hono instances.
This section is mostly our own business logic — the library surface is small
(Hono middleware shape, jose, better-auth `getSession`).

### Assumes

§4's Produces (the server boots). §0's Produces (`jose` installed). No routes
exist yet — that's fine, these are libraries waiting to be consumed.

### Read first

1. **Hono — typed `Variables` via the generic** — https://hono.dev/docs/guides/middleware
   (`set()`/`get()` on https://hono.dev/docs/api/context)
   The `c.set('userId', ...)` / `c.get('userId')` pattern with typed `Variables`
   is what makes the middlewares type-safe end-to-end.
2. **jose — JWT signing and verification** — https://github.com/panva/jose
   The `SignJWT` builder chain and `jwtVerify` with `issuer`/`audience` options.
   We use HS256 (symmetric) because we already share a secret — no asymmetric
   key management in phase 0.
3. **better-auth — `getSession`** — https://www.better-auth.com/docs/basic-usage
   Bookmarked from §3.1; `lib/session.ts` is where you actually call it.

### 5.1 `lib/hono-factory.ts` — typed Hono instances

Every per-resource router needs the same typed `Variables` so `c.get('userId')`
returns `string`, not `unknown`. The factory centralises the generic. Write it
yourself after reading the middleware doc — it's ten lines and copying teaches you nothing.

#### Reference — target shape

```ts
// apps/api/src/lib/hono-factory.ts — REFERENCE ONLY
import { Hono } from 'hono';

export function createHono() {
  return new Hono<{
    Variables: {
      userId: string;
      deviceId?: string;
    };
  }>();
}
```

### 5.2 `lib/session.ts` — browser session middleware

`requireUser` is a Hono sub-app whose middleware runs `auth.api.getSession`,
sets `userId`, and 401s on a missing session. The shape follows the Hono
"Custom Middleware" doc verbatim; the only domain bit is which keys we set.

The subtle part to get right the first time: the session is a cookie set by
better-auth on the API origin (`:3000`). When the web app on `:5173` calls
`:3000`, the browser sends it only because §4's CORS has `credentials: true`.
If `getSession` returns null after a successful login, the bug is in §4's CORS,
not here — don't re-derive the session logic.

#### Reference — target shape

```ts
// apps/api/src/lib/session.ts — REFERENCE ONLY
import { createHono } from './hono-factory';
import { auth } from '../auth';

export const requireUser = createHono();

requireUser.use('*', async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: 'unauthorized' }, 401);
  c.set('userId', session.user.id);
  await next();
});
```

### 5.3 `lib/device-jwt.ts` — sign + verify the Device Key

Devices authenticate with a long-lived JWT (the **Device Key**) signed by the
API. It carries `device_id` and `user_id`. The Enrollment Token (§6) is a
different thing — a one-time hex string exchanged exactly once for this JWT,
which then lives in the daemon's config and is sent on every `/events` POST.

Design points:

- **Reuse `BETTER_AUTH_SECRET` as the HMAC secret** — it's already a high-entropy
  32+ byte string; don't mint a second secret to manage.
- **No `exp`.** Revocation is not token-based: `requireDevice` (§5.4) checks the
  Device's status in the DB on every batch (ADR-0005), so a Revoked Device's key
  dies immediately. An expiry would only add a refresh flow nobody needs.
- **`iss`/`aud` claims distinguish a Device Key from anything else** signed with
  the same secret — verify both on the read side or you accept any JWT.

#### Reference — target shape

```ts
// apps/api/src/lib/device-jwt.ts — REFERENCE ONLY
import { SignJWT, jwtVerify } from 'jose';

const secret = new TextEncoder().encode(process.env.BETTER_AUTH_SECRET!);
const ISSUER = 'ctrluhr';
const AUDIENCE = 'ctrluhr-device';

export async function signDeviceJwt(payload: { deviceId: string; userId: string }) {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .sign(secret);
}

export async function verifyDeviceJwt(token: string): Promise<{ deviceId: string; userId: string }> {
  const { payload } = await jwtVerify(token, secret, {
    issuer: ISSUER,
    audience: AUDIENCE,
  });
  return { deviceId: payload.deviceId as string, userId: payload.userId as string };
}
```

### 5.4 `lib/device-auth.ts` — Device Key middleware

`requireDevice` is the device-side equivalent of `requireUser`: same shape, but
it parses `Authorization: Bearer <jwt>`, verifies the signature, **and does one
indexed DB read to check the Device's status** — a Revoked Device gets 401 on
the very next batch (ADR-0005). That read is the whole point; it's what makes
doc 00's "daemon gets 401 and halts" promise true.

#### Reference — target shape

```ts
// apps/api/src/lib/device-auth.ts — REFERENCE ONLY
import { eq } from 'drizzle-orm';
import { createHono } from './hono-factory';
import { verifyDeviceJwt } from './device-jwt';
import { db } from './db';
import { devices } from '../schema/devices';

export const requireDevice = createHono();

requireDevice.use('*', async (c, next) => {
  const header = c.req.header('Authorization');
  if (!header?.startsWith('Bearer ')) {
    return c.json({ error: 'missing bearer token' }, 401);
  }
  const token = header.slice('Bearer '.length);
  try {
    const { deviceId, userId } = await verifyDeviceJwt(token);
    // Revocation is real: one indexed status read per batch (ADR-0005).
    const [device] = await db
      .select({ status: devices.status })
      .from(devices)
      .where(eq(devices.id, deviceId))
      .limit(1);
    if (!device || device.status !== 'active') {
      return c.json({ error: 'device revoked' }, 401);
    }
    c.set('userId', userId);
    c.set('deviceId', deviceId);
    await next();
  } catch {
    return c.json({ error: 'invalid device token' }, 401);
  }
});
```

### 5.5 How the two middlewares are used

Each per-resource router (§6, §7, §8) calls `app.use('*', requireUser)` or
`app.use('*', requireDevice)` as its first line. Handlers then read
`c.get('userId')` / `c.get('deviceId')` fully typed — the middleware 401s first,
so the value is never undefined when a handler runs.

If you find yourself writing `if (!userId) return c.json({ error: ... }, 401)`
inside a handler, the middleware isn't wired right — fix that, don't patch the handler.

### Verify

```sh
pnpm --filter @ctrluhr/api typecheck
```

Expected: `tsc --noEmit` exits 0 — the four new files type-check against the
installed Hono/jose/better-auth versions. The 401 semantics get exercised once
routes mount in §6/§7.

### Produces

`apps/api/src/lib/hono-factory.ts`, `session.ts`, `device-jwt.ts`,
`device-auth.ts` — the typed factory and both auth middlewares.

---

## 6. Devices routes

Almost entirely our own business logic. The only library surface is Drizzle's
query builder and Node's `crypto`.

### Assumes

- §5's Produces: the middlewares compile.
- **The ADR-0005 schema migration has been applied.** The `devices` table as
  built in 02 still has `api_token_hash text NOT NULL` and no `status` column.
  The routes below can't work until it changes (an insert that supplies no
  `api_token_hash` violates `NOT NULL`). Check:

  ```sh
  rg -n "apiTokenHash|status" apps/api/src/schema/devices.ts
  ```

  Expected: `apiTokenHash` absent, `status` present. If not, apply the ADR-0005
  migration first (drop `api_token_hash`, add `devices.status`, and create the
  `enrollment_tokens` table — see §6.2) — flagged in the adjudication list.

### Read first

1. **Drizzle — select** — https://orm.drizzle.team/docs/select
   `db.select({...projection}).from(table).where(predicate)`.
2. **Drizzle — insert / delete** — https://orm.drizzle.team/docs/insert and
   https://orm.drizzle.team/docs/delete
   `.values({...})` and `.where(eq(...))` shapes, and `.returning()`.
3. **Node crypto** — https://nodejs.org/api/crypto.html
   `randomBytes` for the Enrollment Token (32 bytes → 64 hex chars).

### 6.1 The enrollment flow — read this before writing

Three routes, in this order, for a reason:

1. **`POST /devices`** (auth: user session) — user creates an Enrollment Token.
   We do **not** create a `devices` row yet. We write a row to an
   `enrollment_tokens` table with the requested `name`/`os` and a 30-minute
   expiry. No orphan device rows when a token goes unused.
2. **User copies the token to the daemon machine** and runs
   `ctrluhr auth enroll <token>` (that's `05-daemon-setup.md`).
3. **`POST /devices/enroll`** (auth: none — the token IS the auth) — the daemon
   exchanges the token. We look up the row, check it's unexpired, **now** create
   the `devices` row (status `active`) from the token row's name/os, delete the
   token row (one-time use), and return a long-lived Device Key (`signDeviceJwt`).

The asymmetry is intentional: `/devices` needs a session, `/devices/enroll`
needs only the pre-shared token — the single place in the system where identity
is proven with a token instead of a session or JWT.

**Design decision to confirm (flagged in the adjudication list):** the old draft
stored enrollment tokens in the `verifications` table with `type='device_enroll'`
and a `token` column. The ADR-0006 migration **dropped those columns** —
`verifications` is now `id, identifier, value, user_id, expires_at, created_at,
updated_at` and is better-auth-owned. Storing enrollment rows there is no longer
possible without colliding with better-auth's magic-link rows. The recommended
replacement is a small dedicated table:

```sql
-- migration target (REFERENCE ONLY — a decision point, see adjudication list)
CREATE TABLE enrollment_tokens (
  id          text PRIMARY KEY,          -- caller-generated text id (ADR-0006)
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        text NOT NULL,
  os          text NOT NULL,
  token       text NOT NULL,             -- 64 hex chars, randomBytes(32)
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
```

And per ADR-0005, `devices` gains `status text NOT NULL DEFAULT 'active'`
(`'active' | 'revoked'`) and drops `api_token_hash`.

### 6.2 Write `apps/api/src/routes/devices.ts`

For each handler: `c.get('userId')` is already typed; `c.req.json()` parses the
body (two fields — skip Zod); Drizzle is the main call; `signDeviceJwt` issues
the key. The response field for the key is `device_key` — the glossary's term
(`api_token` is an avoided alias, see `CONTEXT.md`).

#### Reference — target shape

```ts
// apps/api/src/routes/devices.ts — REFERENCE ONLY
import { randomBytes } from 'crypto';
import { eq } from 'drizzle-orm';
import { createHono } from '../lib/hono-factory';
import { requireUser } from '../lib/session';
import { requireDevice } from '../lib/device-auth';
import { signDeviceJwt } from '../lib/device-jwt';
import { db } from '../lib/db';
import { devices } from '../schema/devices';
import { enrollmentTokens } from '../schema/enrollment-tokens';

const app = createHono();

/** List my devices (browser session). */
app.get('/', requireUser, async (c) => {
  const userId = c.get('userId');
  const rows = await db
    .select({
      id: devices.id,
      name: devices.name,
      os: devices.os,
      last_seen_at: devices.lastSeenAt,
    })
    .from(devices)
    .where(eq(devices.userId, userId));
  return c.json({ devices: rows });
});

/** Create an Enrollment Token (no devices row yet). */
app.post('/', requireUser, async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json<{ name?: string; os?: string }>();
  if (!body?.name || !body?.os) {
    return c.json({ error: 'name and os required' }, 400);
  }

  const token = randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 30 * 60 * 1000);

  await db.insert(enrollmentTokens).values({
    userId,
    name: body.name,
    os: body.os,
    token,
    expiresAt: expires,
  });

  return c.json({ enrollment_token: token, expires_at: expires.toISOString() });
});

/** Exchange an Enrollment Token for a long-lived Device Key. */
app.post('/enroll', async (c) => {
  const body = await c.req.json<{ enrollment_token?: string }>();
  if (!body?.enrollment_token) {
    return c.json({ error: 'enrollment_token required' }, 400);
  }

  const rows = await db
    .select()
    .from(enrollmentTokens)
    .where(eq(enrollmentTokens.token, body.enrollment_token))
    .limit(1);
  const row = rows[0];
  if (!row || row.expiresAt < new Date()) {
    return c.json({ error: 'invalid or expired token' }, 401);
  }

  const [device] = await db
    .insert(devices)
    .values({
      userId: row.userId,
      name: row.name,
      os: row.os,
      status: 'active',
    })
    .returning();

  // One-time use.
  await db.delete(enrollmentTokens).where(eq(enrollmentTokens.id, row.id));

  const deviceKey = await signDeviceJwt({ deviceId: device.id, userId: row.userId });

  return c.json({
    device_id: device.id,
    device_key: deviceKey,
    name: row.name,
    os: row.os,
  });
});

export { app as devicesRoute };
```

### Verify

Sign in via the web app (04) or the §3.5 magic link, export the session cookie
to `cookies.txt` (browser devtools), then:

```sh
# no session → 401
curl -s -i -X POST http://localhost:3000/devices
# → HTTP/1.1 401 Unauthorized

# list devices — snake_case, the shape the web app (04 §6.2) reads
curl -s http://localhost:3000/devices -b cookies.txt
# → {"devices":[{"id":"<id>","name":"my-laptop","os":"linux","last_seen_at":"..."}]}

# with session → Enrollment Token
curl -s -X POST http://localhost:3000/devices -b cookies.txt \
  -H 'Content-Type: application/json' -d '{"name":"my-laptop","os":"linux"}'
# → {"enrollment_token":"<64 hex chars>","expires_at":"..."}

# exchange the token → Device Key
curl -s -X POST http://localhost:3000/devices/enroll \
  -H 'Content-Type: application/json' -d '{"enrollment_token":"<token>"}'
# → {"device_id":"<id>","device_key":"eyJ...","name":"my-laptop","os":"linux"}

# the token is one-time use — replay fails
curl -s -X POST http://localhost:3000/devices/enroll \
  -H 'Content-Type: application/json' -d '{"enrollment_token":"<same token>"}'
# → 401 {"error":"invalid or expired token"}
```

### Produces

`apps/api/src/routes/devices.ts` — the enrollment flow end-to-end.

---

## 7. Events route — ingest only

The hot path, and deliberately the smallest design in this doc. ADR-0002 removed
everything that used to live here: no server-side embeddings, no categorizer
(none of `embeddings.ts` / `categorizer.ts` exist or will exist in phase 0).
Rules run in the daemon and embedding matching is browser-mediated in phase 2 —
the API's only job is to *accept and persist* events safely.

### Assumes

§5's Produces (`requireDevice`). §2's Produces (`EventBatchSchema`). A Device
Key from §6 to call it with.

### Read first

1. **Drizzle — insert with `onConflictDoNothing`** — https://orm.drizzle.team/docs/insert
   The "on conflict do nothing" section. This compiles to
   `INSERT ... ON CONFLICT (id) DO NOTHING` and is what makes ingestion
   idempotent: the daemon generates ids client-side, so a replayed batch hits
   the same rows and inserts nothing.
2. **Zod — `safeParse` and `flatten`** — https://zod.dev/error-formatting
   `safeParse` returns `{ success, data, error }` instead of throwing;
   `error.flatten()` produces a structured 400 body the daemon can read.
   (zod.dev now documents Zod 4; the repo runs Zod 3 — `safeParse`/`flatten()`
   are identical in both, so this section is unaffected.)

### Do

Per-event flow:

1. `c.get('userId')` and `c.get('deviceId')` — typed from `requireDevice`.
2. Parse the body with `EventBatchSchema.safeParse(...)`. On failure return 400
   with `parsed.error.flatten()` so the daemon can see which fields were wrong.
3. Insert each event with `.onConflictDoNothing({ target: activityEvents.id })`
   and `.returning()`. A replay is a no-op rather than a duplicate.
4. After the loop, touch `devices.lastSeenAt` — one update per batch, not per event.
5. Return `{ receipts: [...] }` — one receipt per *inserted* event (the
   conflict rows return nothing), shaped by `EventReceiptSchema`.

Three things this route must **not** do, all ADR-driven:

- **No `productive` insert** (ADR-0004). The `activity_events.productive` column
  still physically exists (its drop is scheduled before phase 1) but nothing
  writes or reads it — productivity is always joined live from the Category.
- **No `raw_embedding`** (ADR-0002). Same column story; server-side role suspended.
- **No `category_id` assignment** — every insert carries `categoryId: null`
  until phase 2. Receipts report `category_id: null`; the daemon's bookkeeping
  is built for the field, not the value.

Perf note: one insert per event is fine — phase 0 sees single-digit events per
minute from the stub tracker. Phase 1+ can swap to a single multi-row
`db.insert(table).values([...])`; the wire doesn't change.

#### Reference — target shape

```ts
// apps/api/src/routes/events.ts — REFERENCE ONLY
import { eq } from 'drizzle-orm';
import { createHono } from '../lib/hono-factory';
import { requireDevice } from '../lib/device-auth';
import { db } from '../lib/db';
import { activityEvents } from '../schema/activity-events';
import { devices } from '../schema/devices';
import { EventBatchSchema } from '@ctrluhr/schema';

const app = createHono();

app.use('*', requireDevice);

app.post('/', async (c) => {
  const userId = c.get('userId');
  const deviceId = c.get('deviceId')!;

  const parsed = EventBatchSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: 'invalid batch', details: parsed.error.flatten() }, 400);
  }

  const receipts = [];
  for (const ev of parsed.data.events) {
    // Ingest only: no categorizer, no embed, no productive (ADR-0002, ADR-0004).
    const [row] = await db
      .insert(activityEvents)
      .values({
        id: ev.id,
        userId,
        deviceId,
        appName: ev.app_name,
        windowTitle: ev.window_title,
        categoryId: null,
        startedAt: new Date(ev.started_at),
        endedAt: new Date(ev.ended_at),
      })
      .onConflictDoNothing({ target: activityEvents.id })
      .returning({ id: activityEvents.id });

    if (row) receipts.push({ id: row.id, category_id: null });
  }

  // One last_seen_at touch per batch, not per event.
  await db.update(devices).set({ lastSeenAt: new Date() }).where(eq(devices.id, deviceId));

  return c.json({ receipts });
});

export { app as eventsRoute };
```

### Verify

With `JWT` set to the `device_key` from §6:

```sh
export JWT="<device_key from §6>"
curl -s -X POST http://localhost:3000/events \
  -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' \
  -d '{"events":[{"id":"11111111-1111-4111-8111-111111111111","app_name":"Code","window_title":"writing docs","started_at":"2026-08-05T09:00:00Z","ended_at":"2026-08-05T09:10:00Z"}]}'
# → {"receipts":[{"id":"11111111-1111-4111-8111-111111111111","category_id":null}]}

# replay the identical batch — idempotent, nothing new
curl -s -X POST http://localhost:3000/events \
  -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' \
  -d '{"events":[{"id":"11111111-1111-4111-8111-111111111111","app_name":"Code","window_title":"writing docs","started_at":"2026-08-05T09:00:00Z","ended_at":"2026-08-05T09:10:00Z"}]}'
# → {"receipts":[]}

# no Device Key → 401
curl -s -i -X POST http://localhost:3000/events -H 'Content-Type: application/json' -d '{"events":[]}'
# → HTTP/1.1 401 Unauthorized

# invalid body → 400 with flatten() details
curl -s -X POST http://localhost:3000/events \
  -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' \
  -d '{"events":[{"id":"not-a-uuid"}]}'
# → 400 {"error":"invalid batch","details":{...}}
```

The empty-`receipts` replay is the check that idempotency actually works; a
non-idempotent insert would return two receipts and a doubled row.

### Produces

`apps/api/src/routes/events.ts` — the ingest-only endpoint.

---

## 8. Analytics route

One endpoint, the day's breakdown. The dashboard polls it on a 15-second
interval, so it's a hot read path. Most of the file is one Drizzle query with a
`sql` template.

### Assumes

§5's Produces (`requireUser`). §7's Produces (there are events to aggregate).
**The `users.timezone` column exists** — it doesn't yet (ADR-0003 scheduled it;
see the adjudication list). Check:

```sh
rg -n "timezone" apps/api/src/schema/users.ts
```

Expected: a `timezone` column. If absent, add it (default `'UTC'`, IANA string,
set from the browser at first login in 04) before this step — user-local day
boundaries are non-negotiable (ADR-0003).

### Read first

1. **Drizzle — `sql` template tag** — https://orm.drizzle.team/docs/sql
   The `sql<number>\`...\`` pattern for dropping down to raw SQL inside a query;
   the generic tells TypeScript the result type.
2. **Drizzle — select with groupBy** — https://orm.drizzle.team/docs/select
   Grouping keys are chosen so uncategorized events (all NULLs) collapse into a
   single row.

### Do

For the requested day, per category the User has events in: total seconds.
One row per category, with uncategorized events collapsing to one all-NULL row.

The query:

```sql
SELECT
  activity_events.category_id,
  categories.name AS category_name,
  categories.is_productive,
  sum(extract(epoch from activity_events.ended_at - activity_events.started_at))::int
    AS total_seconds
FROM activity_events
LEFT JOIN categories ON categories.id = activity_events.category_id
WHERE activity_events.user_id = $1
  AND activity_events.started_at >= $2
  AND activity_events.started_at < $3
GROUP BY activity_events.category_id, categories.name, categories.is_productive
```

Two ADR requirements land here:

- **Productivity is live** (ADR-0004): the `LEFT JOIN` pulls `categories.is_productive`
  at query time. Never read `activity_events.productive`.
- **Day boundaries are user-local** (ADR-0003): `$2`/`$3` are the User-local
  midnights converted to UTC instants, a half-open interval `[day, day+1)` —
  no `23:59:59.999` hack. Event storage stays UTC.

`date` comes in as `YYYY-MM-DD` (default: today in the User's timezone). The
`/^\d{4}-\d{2}-\d{2}$/` regex is a quick sanity check; it accepts
`2026-02-30`, which Postgres handles gracefully (zero rows). If you want a real
calendar check, add one.

#### Reference — target shape

```ts
// apps/api/src/routes/analytics.ts — REFERENCE ONLY
import { createHono } from '../lib/hono-factory';
import { requireUser } from '../lib/session';
import { db } from '../lib/db';
import { activityEvents, categories, users } from '../schema';
import { and, eq, sql } from 'drizzle-orm';

const app = createHono();

app.use('*', requireUser);

app.get('/day', async (c) => {
  const userId = c.get('userId');
  // The web app always sends an explicit user-local date; the UTC fallback
  // below only serves bare API calls (curl) where UTC-today is fine.
  const date = c.req.query('date') ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json({ error: 'date must be YYYY-MM-DD' }, 400);
  }

  // Day boundaries are user-local (ADR-0003): fetch the User's IANA tz.
  const [me] = await db
    .select({ tz: users.timezone })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const userTz = me?.tz ?? 'UTC';

  const rows = await db
    .select({
      categoryId: activityEvents.categoryId,
      categoryName: categories.name,
      productive: categories.isProductive,
      totalSeconds: sql<number>`sum(extract(epoch from ${activityEvents.endedAt} - ${activityEvents.startedAt}))::int`,
    })
    .from(activityEvents)
    .leftJoin(categories, eq(categories.id, activityEvents.categoryId))
    .where(
      and(
        eq(activityEvents.userId, userId),
        sql`${activityEvents.startedAt} >= (${date}::date)::timestamp AT TIME ZONE ${userTz}`,
        sql`${activityEvents.startedAt} < ((${date}::date + 1)::timestamp AT TIME ZONE ${userTz})`,
      ),
    )
    .groupBy(activityEvents.categoryId, categories.name, categories.isProductive);

  return c.json({
    date,
    buckets: rows.map((r) => ({
      category_id: r.categoryId,
      category_name: r.categoryName ?? 'Uncategorized',
      productive: r.productive,
      total_seconds: Number(r.totalSeconds),
    })),
  });
});

export { app as analyticsRoute };
```

### Verify

With `cookies.txt` from §6 and an ingested event from §7 (adjust the date to
your ingest):

```sh
curl -s 'http://localhost:3000/analytics/day?date=2026-08-05' -b cookies.txt
# → {"date":"2026-08-05","buckets":[{"category_id":null,"category_name":"Uncategorized","productive":null,"total_seconds":600}]}

# no session → 401
curl -s -i 'http://localhost:3000/analytics/day?date=2026-08-05'
# → HTTP/1.1 401 Unauthorized

# malformed date → 400
curl -s -i 'http://localhost:3000/analytics/day?date=2026-13-99' -b cookies.txt
# → HTTP/1.1 400 Bad Request  {"error":"date must be YYYY-MM-DD"}
```

If buckets come back empty, check the date range — UTC vs your local timezone
shifts events across the boundary by design.

### Produces

`apps/api/src/routes/analytics.ts` — the daily breakdown endpoint.

---

## 9. Run + verify — the smoke flow

### Verify

The built regression plus the plan-first curl flow, in order:

```sh
# built: auth ↔ schema sync regression (ADR-0006)
cd apps/api && bun test-resend.ts

# plan-first, once §4–8 land:
cd apps/api && bun run dev
```

Then, in another terminal:

```sh
curl -s http://localhost:3000/healthz                      # {"ok":true}
curl -s http://localhost:3000/auth/get-session             # {"data":null,"error":null}
# §6: POST /devices (with cookie) → enrollment token; POST /devices/enroll → device_key
# §7: POST /events with the device_key → receipts; replay → empty receipts
# §8: GET /analytics/day → buckets
```

Expected: `bun test-resend.ts` logs a `verifications` row delta (as §3.5), and
every curl matches its section's Verify — `/healthz` → `{"ok":true}`,
`/auth/get-session` → `{"data":null,"error":null}` unauthenticated, the §6
enrollment exchange yields a Device Key, §7 posts receipts then empty on
replay, §8 returns buckets. A step that 401s or 400s where its section said it
should succeed means that section isn't done — go back to it, don't paper over
it here.

A fuller end-to-end gate (sign in → enroll → ingest → dashboard) is
`06-phase0-smoke-test.md`; the goal to hold in your head from the README: *you
log in via magic link, create a Device, enroll a daemon with that Device's key,
and watch synthetic events appear on the dashboard — all wired by you.*

### Produces

The smoke flow verified by hand end-to-end: the `test-resend.ts` regression
green and every plan-first route from §4–8 answering as its section promises.
This is the Assumes for `04-web-setup.md` and `06-phase0-smoke-test.md`.

## 10. Commit `[commit]`

### Assumes

§9's Verify passed — the smoke flow is green and there's nothing uncommitted
you don't intend to put in these two commits.

### Do

The built API surface (§0–§3) is already committed. Make **two** commits on the
plan-first work so rollback stays cheap:

```sh
git add apps/api/src/index.ts apps/api/src/lib apps/api/src/routes
git commit -m "feat(api): hono bootstrap, auth middlewares, /devices + /events + /analytics"
```

```sh
# after any schema migration (enrollment_tokens, devices.status, users.timezone)
git add apps/api/src/schema apps/api/migrations
git commit -m "feat(db): enrollment tokens, device status, user timezone"
```

Small commits make rollbacks painless.

### Verify

```sh
git status --short            # empty (nothing uncommitted)
git log --oneline -2
# feat(db): enrollment tokens, device status, user timezone
# feat(api): hono bootstrap, auth middlewares, /devices + /events + /analytics
```

Expected: both commits on top in that order and a clean working tree.

### Produces

The two plan-first commits (`feat(api): …` and `feat(db): …`) — the state
`04-web-setup.md` and `06-phase0-smoke-test.md` assume.

## Common pitfalls

### `22P02 invalid input syntax for type uuid: <32-char hex>`
The ADR-0006 failure: a `uuid` column is receiving a `text` id. Auth-managed
columns and everything that references them are `text` — check §3.5 re-ran clean.

### `pnpm exec auth@latest generate` can't find the CLI
`exec` resolves local packages; the auth CLI is downloaded on demand. Use
`pnpm dlx auth@latest generate` (or `npx …`). Note this is the opposite of
`drizzle-kit`, which IS local — that one uses `pnpm exec`.

### `drizzle-orm/neon-serverless` not found
Use `drizzle-orm/neon-http` — the subpath changed, and this repo pins
`drizzle-orm@1.0.0-rc.4`. Check `node_modules/drizzle-orm/` for which subpath
your version exports. Also: don't try `drizzle(sql, { schema })` — 1.0 dropped
schema binding; the schema map goes to `drizzleAdapter` in `auth.ts`.

### `DATABASE_URL` undefined when drizzle-kit or the DB client runs
The env var is `DB_URL` in this repo (`.env.example`, `lib/db.ts`,
`drizzle.config.ts`). If a doc or snippet says `DATABASE_URL`, it's stale — see
the adjudication list.

### `getSession` returns null even after a successful login
Cookie domain mismatch. `BETTER_AUTH_URL` must match the URL the browser sees,
the web app's fetches need `credentials: 'include'`, and Hono's CORS needs
`credentials: true` (§4). Re-read the better-auth Hono/CORS pages; don't guess.

### `import { magicLink } from 'better-auth/plugins'` fails
The path differs between versions — check `node_modules/better-auth/dist/plugins/`
and the magic-link docs. The built `auth.ts` uses the `better-auth/plugins` path.

### `@ctrluhr/schema` cannot be resolved by Bun
Bun resolves workspace packages through root `pnpm-workspace.yaml` symlinks.
Run `pnpm install` from the root. If it still fails, the package needs wiring in
`apps/api/package.json` — that's a code-fix ticket.

### The §6 enroll insert violates `devices.api_token_hash NOT NULL`
Expected until the ADR-0005 migration lands (drop the hash, add `status`) — see
§6's Assumes and the adjudication list. Don't "fix" it by inventing a hash.

## Done criteria

Built parts (already true — the Verify for each is in its section):

- [x] Deps installed, DB client, schema package, better-auth + magic link
- [x] §3.5 schema-sync: `bun test-resend.ts` passes (auth ↔ schema in sync)

Plan-first parts (each goes green only after its section is built):

- [ ] `bun run dev` boots Hono on `:3000`; `/healthz` → `{ ok: true }`
- [ ] `/auth/get-session` answers; magic link sends email (Resend logs)
- [ ] Session cookie set; `requireUser`-guarded routes 401 without it
- [ ] Device Key signed/verified; `requireDevice` 401s a Revoked Device's key
- [ ] `POST /devices` + `/devices/enroll` yield a Device Key; token is one-time
- [ ] `POST /events` inserts idempotently and returns receipts
- [ ] `GET /analytics/day` returns user-local buckets; replay adds no duplicate

Next file: `04-web-setup.md` — TanStack Start app, auth gate, dashboard with
ECharts, devices page.

## Adjudication list

One line per doc↔code disagreement, with a recommendation. These are your calls:

1. **README says "03 §0–5 committed" but §4–5 aren't built** — `index.ts` is bare
   and `lib/` has only `db.ts`. Recommendation: fix README to "03 §0–3" (the
   better-auth bootstrap), keep §4–8 as the next work. *(Resolved — README now
   says §0–3.)*
2. **Old doc used `DATABASE_URL`; repo uses `DB_URL`** (db.ts, .env.example,
   drizzle.config.ts). Recommendation: fix doc (this file uses `DB_URL`);
   separately flag 02-database-setup.md, which still shows `DATABASE_URL`.
   *(Resolved — 02 corrected to `DB_URL` in the same pass.)*
3. **Old doc §1: `neon-serverless` + `{ schema }` binding** — repo built
   `neon-http` + `drizzle({ client })`. Recommendation: fix doc (done here);
   note drizzle-orm is pinned at `1.0.0-rc.4`.
4. **Old doc §6 stored enrollment tokens in `verifications`** — the ADR-0006
   migration dropped `verifications.token`/`type`. Recommendation: fix doc —
   dedicated `enrollment_tokens` table (design decision §6.1, confirm shape).
5. **`devices.api_token_hash` still `NOT NULL`, no `status` column** — scheduled
   for change by ADR-0005 but not applied. Recommendation: code-fix ticket to
   apply the migration (drop hash, add `status`) before §6.
6. **`users.timezone` missing** — scheduled by ADR-0003, needed by §8.
   Recommendation: code-fix ticket to add the column (default `'UTC'`).
7. **`activity_events.productive` + `raw_embedding` columns still exist** —
   ADR-0004/0002 suspend them; drop scheduled before phase 1. Recommendation:
   doc wording only (this file never reads/writes them); drops stay code-fix tickets.
8. **`packages/schema` has no tsconfig.json** — its `typecheck`/`build` scripts
   can't run. Recommendation: code-fix ticket to add one (extends
   `tsconfig.base.json`).
9. **`RESEND_FROM_EMAIL` required in built `auth.ts`** (non-null asserted), while
   old doc said optional with a sandbox default. Recommendation: fix doc to match
   (required; use `onboarding@resend.dev` in dev); if the hard requirement is
   regretted, that's a code-fix ticket, not a doc edit.
10. **Old doc §4 mounted auth with `app.route('/auth', auth.handler)`** — the
    current better-auth Hono docs use `app.on([...], '/auth/*', c => auth.handler(c.req.raw))`.
    Recommendation: fix doc (done here); verify against the official page when building.
11. **Old doc migration commands targeted `@ctrluhr/db`** — no such package;
    drizzle-kit lives in `@ctrluhr/api`. Recommendation: fix doc (done here).
12. **Old doc §7 planned a server-side categorizer + embeddings** — superseded by
    ADR-0002; `openai` is installed but inert in phase 0. Recommendation: fix doc
    (done here — ingest-only); optionally a code-fix ticket to drop the unused dep.
