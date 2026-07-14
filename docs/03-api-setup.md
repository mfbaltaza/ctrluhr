# 03 — API Setup

Goal: a running Hono server on Bun that:
- boots on `:3000`
- mounts better-auth `/auth/*` with **magic link** (Resend email)
- exposes `POST /events` (device JWT auth) — validates + persists batches
- exposes `POST /devices` (user session auth) — create a device, return one-time enrollment token
- exposes `POST /devices/enroll` — exchange token for long-lived device JWT
- exposes `GET /analytics/day` (user session auth) — return daily aggregates for the dashboard
- exposes `GET /healthz` (no auth) — for sanity checks

By the end of this file the smoke flow is:
`curl /healthz → 200` + sign in via magic link via API + create device + enroll
and post events.

> Assumes `01-monorepo-setup.md` + `02-database-setup.md` are done.

## Conventions we use

- **TypeScript everywhere**, strict, no `any` for new code (use `unknown` + parse).
- **Files export a single `app` (a Hono instance)**. `index.ts` mounts them.
- **Errors** return JSON `{ error: "..." }` with the right HTTP status. No exceptions leak.
- **Auth setup**: Hono middleware verifies the session cookie or the device
  `Authorization: Bearer <jwt>` — both at the middleware layer, never inline per route.

## 0. Install the API deps

`01-monorepo-setup.md` scaffolded `apps/api` with the Hono CLI (which added
`hono`) but deliberately did **not** pre-bake the domain deps — they land here
with the code that uses them. `02-database-setup.md` already installed
`drizzle-orm` / `drizzle-kit` / `@neondatabase/serverless`. From the repo root:

```sh
pnpm --filter @ctrluhr/api add better-auth resend openai jose @hono/zod-validator
```

Verify `apps/api/node_modules` now contains `hono`, `better-auth`, `resend`,
`openai`, `jose`, `drizzle-orm`, `@neondatabase/serverless`.

## 1. The DB client

### `apps/api/src/lib/db.ts`

```ts
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import * as schema from '../schema';

const connectionString = process.env.DATABASE_URL!;
const sql = neon(connectionString);
export const db = drizzle(sql, { schema });
export type DB = typeof db;
```

Why neon-serverless driver:
- Uses HTTP (or fetch) over Postgres wire — works perfectly in Bun and edge.
- Pool-able via `Pool` from the same package if you need more throughput. For
  dev we use the simple `neon()` query function.

## 2. The schema package (`packages/schema`)

The single source of truth for the wire format. Everything else (Hono
validation, web client types, daemon JSON schema) is generated FROM here.

### `packages/schema/src/event.ts`

```ts
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

### `packages/schema/src/index.ts`

```ts
export * from './event';
```

### Re-install (pick up the new schema package)

```sh
pnpm install
```

## 3. better-auth setup

better-auth runs as its own module in `apps/api/src/auth.ts`. The web app
talks to it through the `better-auth/client` SDK (covered in `04-web-setup.md`).
The API mounts the handler at `/auth/*` (Hono routes everything else).

The official docs are the source of truth — don't trust this section over
them. This section just decides *which* docs to read and *in what order*,
because the better-auth site is huge and easy to get lost in.

### 3.1 Read these in order

Walk through the docs in this order. Each one is short, and they link to
each other, so ~15 minutes total:

1. **Installation** — https://www.better-auth.com/docs/installation
   Covers the `auth.ts` shape, env vars, database wiring, and the Hono
   handler snippet (which is exactly what we'll use in §4).
2. **Drizzle ORM Adapter** — https://www.better-auth.com/docs/adapters/drizzle
   This is what glues better-auth to your Drizzle schema. Read the
   "Modifying Table Names" and "Schema generation & migration" sections
   — both matter for us.
3. **Magic Link plugin** — https://www.better-auth.com/docs/plugins/magic-link
   This is the auth method. The whole reason for this section. Read the
   "Installation" (server) and "Configuration Options" sections. Ignore
   the client plugin for now — that's `04-web-setup.md`.
4. **CLI** — https://www.better-auth.com/docs/concepts/cli
   Specifically the `generate` command. This is what reconciles better-auth's
   required columns with your Drizzle schema in §3.5.
5. **Basic Usage → Server-Side `getSession`** — https://www.better-auth.com/docs/basic-usage#server-side
   Bookmarks the exact API we use in `lib/session.ts` (§5).

Don't read the rest yet (social providers, 2FA, organizations, etc.) — none
of it applies to phase 0.

### 3.2 Install

The install command in §0 already added `better-auth`. The Drizzle adapter
is a separate package in recent better-auth versions — check which one your
installed `better-auth` version expects by looking at
`node_modules/better-auth/dist/adapters/` (or `@better-auth/drizzle-adapter/`
if that exists):

```sh
# if node_modules/@better-auth/drizzle-adapter exists:
pnpm --filter @ctrluhr/api add @better-auth/drizzle-adapter

# if node_modules/better-auth/dist/adapters/drizzle exists, skip — it's bundled
```

The official docs say `@better-auth/drizzle-adapter` is the way going forward,
but older versions still ship the adapter inline at `better-auth/adapters/drizzle`.
Use whichever import path your version actually exports.

### 3.3 Env vars

The official docs name two required env vars (see Installation page):

- `BETTER_AUTH_SECRET` — random 32+ char string. Generate with
  `openssl rand -base64 32`. The docs also have a "Generate Secret" button.
- `BETTER_AUTH_URL` — base URL of the API (in dev: `http://localhost:3000`).

Add both to `apps/api/.env` (and `apps/api/.env.example` so the team knows).
The Hono mount in §4 doesn't need anything else from better-auth; it picks
up `BETTER_AUTH_URL` automatically via `auth.handler`.

> Heads up: this file's earlier draft used `BETTER_AUTH_BASE_URL`. That's
> wrong — the env var is `BETTER_AUTH_URL`. The `baseURL` *config option*
> on the `betterAuth({...})` call is a different thing; you usually don't
> need to set it because the env var is read automatically.

You'll also need `RESEND_API_KEY` (from https://resend.com/api-keys) and
optionally `RESEND_FROM_EMAIL` (defaults to Resend's sandbox sender, which
only delivers to your Resend-account email — perfect for phase 0 dev).

### 3.4 Create `apps/api/src/auth.ts`

By now you've read the five doc pages above. Write the file by following
them — the structure should fall out naturally:

- Import `betterAuth` and `magicLink` (paths per the docs for your version).
- Import the Drizzle adapter from whichever path your version exposes.
- Pass the adapter with `provider: 'pg'` and the `schema` mapping.
  Because our Drizzle tables are named `users` / `sessions` / `vouchers`
  (plural, and `vouchers` is awkwardly named — see §2 in `02-database-setup.md`),
  use the "Modifying Table Names" pattern from the Drizzle adapter docs to
  map better-auth's default `user` / `session` / `verification` to our
  `users` / `sessions` / `vouchers` tables.
- Set `emailAndPassword: { enabled: false }` — magic link only.
- Add the `magicLink` plugin with a `sendMagicLink` callback that calls
  `resend.emails.send({...})`. The `url` arg is the full link the user
  clicks (better-auth appends the token as a query param) — see the
  Magic Link plugin docs for the exact shape of the callback args.
- `export const auth = betterAuth({...})` and `export type Auth = typeof auth`.

#### Reference — what the end file should look like

This is what the finished file should resemble *after* you write it by
following the steps above. **Do not copy this verbatim** — the import
paths and option names change between better-auth versions, and the docs
are always more current than this snapshot. Use this to sanity-check that
yours has the same shape, options, and side-effects:

```ts
// apps/api/src/auth.ts — REFERENCE ONLY
// Write this by following §3.1 docs, then compare against this.

import { betterAuth } from 'better-auth';
import { magicLink } from 'better-auth/plugins';
import { drizzleAdapter } from '<per-docs-for-your-version>';  // see §3.2
import { db } from './lib/db';
import * as schema from './schema';
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY!);

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema: {
      user: schema.users,
      session: schema.sessions,
      verification: schema.vouchers,
    },
  }),
  emailAndPassword: { enabled: false },       // magic link only
  plugins: [
    magicLink({
      sendMagicLink: async ({ email, url }) => {
        const from = process.env.RESEND_FROM_EMAIL ?? 'ctrluhr <onboarding@resend.dev>';
        await resend.emails.send({
          from,
          to: email,
          subject: 'Sign in to ctrluhr',
          html: `<a href="${url}">Click here to sign in</a>`,
        });
      },
    }),
  ],
});

export type Auth = typeof auth;
```

### 3.5 Sync the schema

better-auth may want a few extra columns on `users` / `sessions` /
`vouchers` (e.g. `emailVerified`, `image`, `expiresAt`, `token`,
`identifier`). Run the CLI's `generate` command (per the CLI docs) to see
what it expects:

```sh
pnpm exec auth@latest generate --config src/auth.ts --output src/schema
```

(That command name and flags change — always check the current CLI docs
at https://www.better-auth.com/docs/concepts/cli. Older docs called the
package `@better-auth/cli`; current docs use the unscoped `auth` package.)

It'll print a Drizzle schema diff. Compare each table to your
`apps/api/src/schema/{users,sessions,verifications}.ts` and add the missing
columns. Then re-run your normal migration flow:

```sh
pnpm --filter @ctrluhr/db drizzle-kit generate
pnpm --filter @ctrluhr/db drizzle-kit push
```

This is a one-time chore. After this, better-auth reads/writes those
columns and you'll rarely touch them again.

### 3.6 What you should be able to do now

Without writing any more code, you can sanity-check the install:

- `bun run apps/api/src/auth.ts` should *not* throw at import time. If it
  does, the error message will tell you what's missing (env var, column,
  import path).
- The CLI in §3.5 should generate a clean diff (i.e. after applying it,
  re-running produces no further changes).

If both pass, you're done with section 3. Move to §4 to mount the handler.

## 4. Hono bootstrap

This is mostly library wiring — the file is small and the only logic in
it is "mount the better-auth handler at `/auth/*`, mount the rest of the
routes, add a couple of middlewares." Read the Hono docs first, then
write it.

### 4.1 Read these in order

1. **Getting Started** — https://hono.dev/docs/getting-started/basic
   Covers the `new Hono()` → `app.get(...)` → `export default app` shape
   and the request/response helpers (`c.json`, `c.text`, `c.req.query`,
   `c.req.param`). All of it applies to us.
2. **Middleware concepts** — https://hono.dev/docs/concepts/middleware
   Specifically the "Writing your own middleware" and `c.set` / `c.get`
   bits — we use those heavily in §5.
3. **CORS middleware** — https://hono.dev/docs/middleware/builtin/cors
   We mount CORS before routes so better-auth's cookie-based auth works
   from the web app on a different origin (`5173` → `3000`). Pay attention
   to the `credentials: true` option — without it, the browser drops the
   session cookie on cross-origin requests.
4. **Logger middleware** — https://hono.dev/docs/middleware/builtin/logger
   Optional but useful in dev. Disable in prod or you'll spam your logs.
5. **Routing — `app.route()` for sub-routers** — https://hono.dev/docs/concepts/routers
   We split the API into per-resource sub-apps (`eventsRoute`,
   `devicesRoute`, `analyticsRoute`) and mount each one with `app.route`.
   The "Grouping routes" section covers the pattern.

### 4.2 Bun's entry point

The Hono docs show `export default app` — that's the Worker/Deno/Cloudflare
shape. **Bun is different**: it expects `{ port, fetch }` so `Bun.serve` can
pick it up. From the Bun docs (https://bun.sh/docs/runtime/http#bun-serve):

```ts
export default {
  port: 3000,
  fetch: app.fetch,
};
```

Don't paste the Hono docs' `export default app` blindly — read the Bun
section too, otherwise `bun run src/index.ts` will silently fail or print
a confusing runtime error.

### 4.3 Write `apps/api/src/index.ts`

By now the shape should be obvious. Walk through the file mentally:

- Import `Hono`, `cors`, `logger`, your `auth` instance from §3, and the
  three sub-routers from §6–§8 (we haven't written them yet — import them
  as you create them; TS will yell at you if you reference a missing
  module).
- Create one `app = new Hono()`.
- `app.use('*', logger())` — dev only; gate it on `NODE_ENV !== 'production'`
  or just live with it for now.
- `app.use('*', cors({ origin, credentials: true }))` — origin defaults to
  the web dev URL; pull from `process.env.WEB_ORIGIN` so prod config doesn't
  require code changes.
- `app.get('/healthz', c => c.json({ ok: true }))` — no auth, no nothing.
  This is your liveness probe.
- `app.route('/auth', auth.handler)` — better-auth's handler is itself a
  Hono-compatible fetch. Mounting it at `/auth` means all of better-auth's
  routes (`/auth/sign-in/magic-link`, `/auth/get-session`, etc.) are
  reachable.
- `app.route('/events', eventsRoute)` / `/devices` / `/analytics` — mount
  each sub-router from §6–§8.
- `export default { port, fetch: app.fetch }` — Bun entry point.

#### Reference — what the end file should look like

```ts
// apps/api/src/index.ts — REFERENCE ONLY
// Write by following §4.1 + §4.2, then compare against this.

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
app.route('/auth', auth.handler);
app.route('/events', eventsRoute);
app.route('/devices', devicesRoute);
app.route('/analytics', analyticsRoute);

const port = Number(process.env.PORT ?? 3000);
export default { port, fetch: app.fetch };
```

### 4.4 Sanity check

Before moving to §5, confirm:

- `bun run apps/api/src/index.ts` boots without error and prints a
  "Listening on http://localhost:3000" line (or similar).
- `curl http://localhost:3000/healthz` returns `{"ok":true}`.
- `curl http://localhost:3000/auth/get-session` returns a JSON session
  object (probably `{ data: null, error: null }` for an unauthenticated
  request). This proves the better-auth mount is wired correctly.

If any of those fail, the bug is in how `auth.handler` is mounted or how
`app.route` was called — re-check the Hono routing docs. Don't move on
to §5 with a broken bootstrap.

## 5. Auth middlewares

Two middlewares do the auth work, plus one tiny helper to keep them
type-safe across the app. This section is mostly our own logic — the
library surface is small (Hono middleware shape, jose for JWT, better-auth
for the session lookup). Read the linked docs for each, then write the
files by reasoning about what each one needs to do.

### 5.1 Read these in order

1. **Hono — typed `Variables` via the generic** — https://hono.dev/docs/concepts/middleware#context
   The `c.set('userId', ...)` / `c.get('userId')` pattern with typed
   `Variables` is what makes the middlewares below type-safe end-to-end.
   Read the "Custom Middleware" section specifically.
2. **jose — `SignJWT` and `jwtVerify`** — https://github.com/panva/jose#jwt-signing-and-verification
   jose is the de-facto JWT lib for TS/Bun. The "JWT signing" section
   shows the `SignJWT` builder, the "Verification" section shows
   `jwtVerify` with issuer/audience checks. We use HS256 (symmetric)
   because we already have a shared secret — no need for asymmetric key
   management in phase 0.
3. **better-auth — `auth.api.getSession`** — https://www.better-auth.com/docs/basic-usage#server-side
   Already linked in §3. Bookmarked here because `lib/session.ts` is where
   you actually call it.

### 5.2 `lib/hono-factory.ts` — typed Hono instances

Every per-resource sub-router (`eventsRoute`, `devicesRoute`,
`analyticsRoute`) is a `Hono` instance that needs the same typed
`Variables` so `c.get('userId')` returns a `string`, not `unknown`. The
factory centralises the generic. One file, ten lines. Read the Hono
middleware docs to understand what the generic controls, then write it
yourself — there's nothing to learn from copying it.

#### Reference — what the end file should look like

```ts
// apps/api/src/lib/hono-factory.ts — REFERENCE ONLY

import { Hono } from 'hono';

/** Hono instance preconfigured with the types we use everywhere. */
export function createHono() {
  return new Hono<{
    Variables: {
      userId: string;
      deviceId?: string;
    };
  }>();
}
```

### 5.3 `lib/session.ts` — browser session middleware

`requireUser` is a Hono sub-app that runs `auth.api.getSession`, populates
`userId` and `user`, and 401s if there's no session. The shape follows
the Hono "Custom Middleware" doc verbatim — the only domain-specific bit
is which `c.set(...)` keys we populate. Use §3.1's better-auth `getSession`
doc to confirm the call shape.

A subtle thing worth getting right the first time: the session is in a
cookie. The cookie was set by better-auth on the API origin (`:3000`).
When the web app on `:5173` calls `:3000`, the browser sends the cookie
because Hono's CORS in §4 set `credentials: true`. If you find `getSession`
returns `null` even after a successful login, the issue is in §4's CORS,
not here. Don't re-derive the session-lookup logic — re-read the better-auth
CORS / cookies section.

#### Reference — what the end file should look like

```ts
// apps/api/src/lib/session.ts — REFERENCE ONLY

import { createHono } from './hono-factory';
import { auth } from '../auth';

export const requireUser = createHono();

requireUser.use('*', async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: 'unauthorized' }, 401);
  c.set('user', session.user);
  c.set('userId', session.user.id);
  await next();
});
```

### 5.4 `lib/device-jwt.ts` — sign + verify the device JWT

Devices authenticate with a long-lived JWT signed by the API. The JWT
carries `device_id` and `user_id`. The *enrollment* token (a one-time
hex string the user copies to the daemon machine, see §6) is **not** the
JWT — it's exchanged exactly once for a JWT, which then lives in the
daemon's `~/.config/ctrluhr/config.toml` and is sent on every `/events`
POST.

We reuse `BETTER_AUTH_SECRET` as the HMAC secret. That's intentional:
it's already a high-entropy random 32+ byte string in `.env`, so we don't
need a second secret to manage. Reuse the env var; don't generate a new
one. The `iss` and `aud` claims distinguish a device JWT from a better-auth
session cookie in case anything ever tries to verify the wrong one.

Read the jose docs linked in §5.1 — specifically the `SignJWT` builder
method chain and the `jwtVerify` options. The interesting knobs:
- `alg: 'HS256'` — symmetric, same secret for sign and verify.
- `iss: 'ctrluhr'`, `aud: 'ctrluhr-device'` — you must verify both
  on the read side or you accept any JWT signed with your secret.
- `iat` only — no `exp`. Phase 0 doesn't expire device JWTs (revocation
  is via `devices.api_token_hash` mismatch in a later phase). If you
  want an expiry, set it; but then you need a refresh flow, which
  isn't worth the complexity yet.

#### Reference — what the end file should look like

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

`jose` was already installed in §0. If you skipped that,
`pnpm --filter @ctrluhr/api add jose` now.

### 5.5 `lib/device-auth.ts` — middleware verifying the device JWT

`requireDevice` is the device-side equivalent of `requireUser`. Same
shape: a Hono sub-app, middleware that validates the bearer token, sets
`userId` + `deviceId`, and 401s on any failure.

The only domain-specific bit is the `Authorization: Bearer <jwt>` header
parsing — there's no library magic here, it's a string slice. The
verification call is `verifyDeviceJwt()` from §5.4. After §5.4 reads the
jose docs, this file should be obvious.

#### Reference — what the end file should look like

```ts
// apps/api/src/lib/device-auth.ts — REFERENCE ONLY

import { createHono } from './hono-factory';
import { verifyDeviceJwt } from './device-jwt';

export const requireDevice = createHono();

requireDevice.use('*', async (c, next) => {
  const header = c.req.header('Authorization');
  if (!header?.startsWith('Bearer ')) {
    return c.json({ error: 'missing bearer token' }, 401);
  }
  const token = header.slice('Bearer '.length);
  try {
    const { deviceId, userId } = await verifyDeviceJwt(token);
    c.set('userId', userId);
    c.set('deviceId', deviceId);
    await next();
  } catch {
    return c.json({ error: 'invalid device token' }, 401);
  }
});
```

### 5.6 How the two middlewares are used

This is a good moment to read the Hono "Custom Middleware" doc end-to-end
if you haven't already — specifically the part about chaining
middlewares on a sub-app. Each per-resource router (§6, §7, §8) calls
`app.use('*', requireUser)` or `app.use('*', requireDevice)` as its
first line, then `c.get('userId')` / `c.get('deviceId')` in the handlers
is fully typed and never undefined (the middleware 401s first if the
caller isn't authed).

If you find yourself writing `if (!userId) return c.json({ error: ... }, 401)`
inside a handler, the middleware isn't wired right — fix that first.

## 6. Devices routes

This section is almost entirely our own business logic. The only library
surface is Drizzle's query builder — read the docs for the few operations
we use, then write the file by reasoning about the enrollment flow.

### 6.1 Read these in order

1. **Drizzle — Query Builder** — https://orm.drizzle.team/docs/select
   Specifically: `db.select({...projection...}).from(table).where(predicate)`,
   and `.insert(table).values(obj).returning()`. The `returning()` shape
   is what gives us the inserted row back.
2. **Drizzle — Insert / Delete** — https://orm.drizzle.team/docs/insert
   and https://orm.drizzle.team/docs/delete
   Just to confirm the `.values({...})` and `.where(eq(...))` shapes.
   If you used Prisma before, Drizzle's insert is less ceremonious and
   doesn't auto-generate types the same way.
3. **Node `crypto.randomBytes` and `createHash`** — https://nodejs.org/api/crypto.html
   For the enrollment token (random 32 bytes → 64 hex chars) and the
   `apiTokenHash` (sha256 of the same). The dynamic `await import('crypto')`
   is just a stylistic choice — `import { randomBytes, createHash } from 'crypto'`
   at the top of the file works too, pick whichever you prefer.

### 6.2 The enrollment flow — read this before writing

There are three routes in this file and they exist in this order for a
specific reason. Read the flow end-to-end, then write the handlers.

1. **`POST /devices`** (auth: user session) — user creates an enrollment
   token. We do **not** create a `devices` row yet — only a row in
   `vouchers` with `type='device_enroll'`. This avoids orphan device rows
   when the user generates a token and never uses it. The token expires
   in 30 minutes.

2. **User copies the token to the daemon machine** and runs
   `./ctrluhr enroll <token> <name> <os>` (that's `05-daemon-setup.md`).

3. **`POST /devices/enroll`** (auth: none — the token IS the auth) —
   daemon exchanges the token. We look up the voucher, validate it's
   unexpired and of type `device_enroll`, then *now* create the `devices`
   row. The voucher is deleted (one-time use). The daemon receives a
   long-lived device JWT, which it stores in `~/.config/ctrluhr/config.toml`.

The asymmetry — token-only auth on `/enroll` but user-session auth on
`/devices` — is intentional. The enrollment endpoint is the *only* place
in the system where something proves its identity with a pre-shared
token instead of a session or JWT. Everywhere else, the caller is
already identified.

### 6.3 Design decision: what is `api_token_hash` storing?

This part of the original draft confused me, so I'll write down what's
actually happening. Read carefully.

- We generate `apiToken = randomBytes(48).toString('hex')` (a 96-char
  hex string). This is **not** what we return to the daemon.
- We hash it: `apiTokenHash = sha256(apiToken)`. We store this in
  `devices.api_token_hash`. The raw `apiToken` is discarded.
- We sign and return a **JWT** (via `signDeviceJwt` from §5.4) that
  carries the device id and user id. The daemon stores the JWT in its
  config and sends it on every `/events` POST.
- On every `/events` POST, the API verifies the JWT signature (via
  `verifyDeviceJwt` from §5.4) — no DB lookup required for auth.

So what is `api_token_hash` for? **It's a permanent identifier for the
device that was provisioned from this enrollment.** Right now we don't
use it. In phase 5+ you might want to:
- Add a `/devices/:id/rotate` endpoint that issues a new JWT, hashes it,
  updates `api_token_hash`, and signals the daemon to re-enroll.
- Revoke a specific device without rotating the JWT secret.

If this dual-thing (raw random + JWT + hash of raw random) feels like
overkill, it is. For phase 0 you can simplify to: drop `api_token_hash`
entirely, return only the JWT, and skip the random/hash dance. The
trade-off is that rotation becomes harder later. Keep the column in
the schema either way (it's already in `02-database-setup.md`); the
question is just whether to populate it. The reference below populates
it; you decide.

### 6.4 Write `apps/api/src/routes/devices.ts`

By now the structure should be obvious. The file has three handlers:
`GET /` (list), `POST /` (create enrollment token), `POST /enroll`
(exchange token for JWT).

For each handler, the steps are:
- `c.get('userId')` is already typed (from §5.2's `Variables`).
- `c.req.json()` parses the body; you can pass a generic to type the
  shape, or use Zod (overkill for two fields).
- Drizzle's query builder is the main library call — keep the docs
  page open while you write.
- Use `randomBytes` for the token, `createHash` for the hash.
- `signDeviceJwt` from §5.4 produces the JWT.
- Return JSON with `c.json({...})`.

#### Reference — what the end file should look like

```ts
// apps/api/src/routes/devices.ts — REFERENCE ONLY

import { createHono } from '../lib/hono-factory';
import { requireUser } from '../lib/session';
import { db } from '../lib/db';
import { devices } from '../schema/devices';
import { vouchers } from '../schema/verifications';
import { eq } from 'drizzle-orm';
import { signDeviceJwt } from '../lib/device-jwt';
import { randomBytes, createHash } from 'crypto';

const app = createHono();

/** List my devices (browser session). */
app.get('/', requireUser, async (c) => {
  const userId = c.get('userId');
  const rows = await db
    .select({
      id: devices.id,
      name: devices.name,
      os: devices.os,
      lastSeenAt: devices.lastSeenAt,
      createdAt: devices.createdAt,
    })
    .from(devices)
    .where(eq(devices.userId, userId));
  return c.json({ devices: rows });
});

/** Create a device and get a one-time enrollment token. */
app.post('/', requireUser, async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json<{ name?: string; os?: string }>();
  if (!body?.name || !body?.os) {
    return c.json({ error: 'name and os required' }, 400);
  }

  const token = randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 30 * 60 * 1000); // 30-min window

  await db.insert(vouchers).values({
    userId,
    token,
    type: 'device_enroll',
    expiresAt: expires,
  });

  return c.json({ enrollment_token: token, expires_at: expires.toISOString() });
});

/** Exchange an enrollment token for a long-lived device JWT. */
app.post('/enroll', async (c) => {
  const body = await c.req.json<{
    enrollment_token?: string;
    name?: string;
    os?: string;
  }>();
  if (!body?.enrollment_token || !body?.name || !body?.os) {
    return c.json({ error: 'enrollment_token, name, os required' }, 400);
  }

  // Look up the unused, unexpired enrollment voucher.
  const rows = await db
    .select()
    .from(vouchers)
    .where(eq(vouchers.token, body.enrollment_token))
    .limit(1);
  const row = rows[0];
  if (!row || row.type !== 'device_enroll' || row.expiresAt < new Date()) {
    return c.json({ error: 'invalid or expired token' }, 401);
  }

  // Create the device. api_token_hash is the SHA-256 of a separate random
  // string — see §6.3 for why we keep this even though we return a JWT.
  const apiToken = randomBytes(48).toString('hex');
  const apiTokenHash = createHash('sha256').update(apiToken).digest('hex');
  const [device] = await db
    .insert(devices)
    .values({
      userId: row.userId,
      name: body.name,
      os: body.os,
      apiTokenHash,
    })
    .returning();

  // Voucher is one-time-use; delete it.
  await db.delete(vouchers).where(eq(vouchers.id, row.id));

  // Issue the long-lived JWT the daemon will actually use.
  const jwt = await signDeviceJwt({ deviceId: device.id, userId: row.userId });

  return c.json({ device_id: device.id, api_token: jwt });
});

export { app as devicesRoute };
```

### 6.5 Sanity check

Before moving to §7, confirm the flow end-to-end via curl:

```sh
# After logging in via the web UI (or directly with better-auth's
# session cookie), then:
curl -X POST http://localhost:3000/devices \
  -H 'Content-Type: application/json' \
  -b cookies.txt \
  -d '{"name":"my-laptop","os":"linux"}'
# → { "enrollment_token": "<64 hex chars>", "expires_at": "..." }

# Then, with the token:
curl -X POST http://localhost:3000/devices/enroll \
  -H 'Content-Type: application/json' \
  -d '{"enrollment_token":"<token>","name":"my-laptop","os":"linux"}'
# → { "device_id": "<uuid>", "api_token": "ey..." }
```

If `POST /devices` returns 401, your session cookie isn't reaching the
API. If `POST /devices/enroll` returns "invalid or expired token" on a
fresh token, the `vouchers.type` check is failing — re-check the insert
in `POST /devices` and the type string in the `where` clause match.

## 7. Events route + categorizer + embeddings

Three files work together: `embeddings.ts` is the OpenAI wrapper,
`categorizer.ts` is the business logic that decides which category an
event belongs to, and `routes/events.ts` is the HTTP handler that
ingests batches from the daemon. The first two are short; the handler
is where most of the design lives.

### 7.1 Read these in order

1. **OpenAI Node SDK — embeddings** — https://github.com/openai/openai-node#embeddings
   The `openai.embeddings.create({ model, input })` shape. We use
   `text-embedding-3-small` (1536 dimensions, matches the `vector(1536)`
   column in our schema). Read the "Embeddings" section — that's all we
   need; the rest of the SDK isn't used in phase 0.
2. **Drizzle — `onConflictDoNothing`** — https://orm.drizzle.team/docs/insert#on-conflict-do-nothing
   This compiles to `INSERT ... ON CONFLICT (id) DO NOTHING`, which is
   what makes event ingestion idempotent. The daemon generates UUIDs
   client-side; if a batch is retried, the same UUIDs hit the same rows
   and nothing duplicates. Read this doc — it's short and explains the
   target column behavior.
3. **Drizzle — `update` with `.set()` and `.where()`** — https://orm.drizzle.team/docs/update
   Just to confirm the shape. We use this once, for the `last_seen_at`
   touch on the device row.
4. **Zod — `safeParse` and `flatten`** — https://zod.dev/?id=safeparse
   We use `safeParse` (returns `{ success, data, error }` rather than
   throwing) and `error.flatten()` to produce a structured 400 response.
   The `02-database-setup.md` schema package already exports
   `EventBatchSchema`; we just consume it.

### 7.2 `lib/embeddings.ts` — define the function, don't call it (yet)

We write the `embed()` function now but **don't call it in phase 0**.
The categorizer (§7.3) is rules-only, so no embeddings happen on
ingest. Why define the function then?

- Phase 2 is a one-liner swap inside the categorizer — `import { embed } from './embeddings'` and you're done.
- It surfaces the OpenAI dep early so the env var check at import time
  fires immediately if `OPENAI_API_KEY` is missing.
- It establishes the function signature (`(text: string) => Promise<number[]>`)
  that the phase 2 categorizer will call.

Read the OpenAI SDK doc, write the function, move on. The body is five
lines.

#### Reference — what the end file should look like

```ts
// apps/api/src/lib/embeddings.ts — REFERENCE ONLY

import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

export async function embed(text: string): Promise<number[]> {
  const res = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text,
  });
  return res.data[0].embedding;
}
```

### 7.3 `lib/categorizer.ts` — rules-only for phase 0

The categorizer is what turns `(appName, windowTitle)` into
`(categoryId, productive)`. Phase 0 implements one rule type: exact
match of `appName` against `category_rules.pattern` (case-insensitive).
Phase 2 adds `title_regex` rules and an embedding-fallback when no rule
matches — both are described in `07-future-phases.md`.

Read the Drizzle query builder doc to confirm the `select` + `innerJoin`
+ `where(and(...))` shape. The function is small; the only design
question is whether to do the rule match in SQL or in app code after
loading. We load + match in app code because:

- The rule set is tiny (a few dozen rows per user). Loading them is
  cheap.
- Title-regex matching in phase 2 is awkward in SQL (`~*` works but
  debugging is harder in app code).
- Phase 2's "embed + nearest neighbor" step isn't a SQL-side match
  anyway, so the categorizer is going to grow logic; might as well
  centralize it.

#### Reference — what the end file should look like

```ts
// apps/api/src/lib/categorizer.ts — REFERENCE ONLY

import { db } from './db';
import { categories, categoryRules } from '../schema';
import { eq, and } from 'drizzle-orm';

export async function categorizeEvent(
  userId: string,
  appName: string,
  windowTitle: string,
): Promise<{ categoryId: string | null; productive: number | null }> {
  const rules = await db
    .select({
      categoryId: categoryRules.categoryId,
      isProductive: categories.isProductive,
      pattern: categoryRules.pattern,
    })
    .from(categoryRules)
    .innerJoin(categories, eq(categories.id, categoryRules.categoryId))
    .where(and(eq(categories.userId, userId), eq(categoryRules.patternType, 'app_name')));

  const hit = rules.find((r) => r.pattern.toLowerCase() === appName.toLowerCase());

  if (hit) {
    return { categoryId: hit.categoryId, productive: hit.isProductive };
  }
  return { categoryId: null, productive: null };
}
```

### 7.4 `routes/events.ts` — the ingest handler

This is the hot path. Read the Drizzle `onConflictDoNothing` doc carefully
— that one operator is what makes the whole ingestion safe to retry, and
it's worth understanding why before you paste the code.

Per-event flow:
1. `c.get('userId')` and `c.get('deviceId')` — typed from the
   `requireDevice` middleware in §5.5.
2. Parse the body with `EventBatchSchema.safeParse(...)` from the
   `packages/schema` package. On failure return 400 with
   `parsed.error.flatten()` so the daemon can see which fields were wrong.
3. For each event, call `categorizeEvent()` to get a category.
4. Insert with `.onConflictDoNothing({ target: activityEvents.id })`.
   The daemon-generated UUID is the conflict target, so a replay is a
   no-op rather than a duplicate.
5. After the loop, touch `devices.lastSeenAt = new Date()`. Single
   `update` per batch, not per event.
6. Return `{ receipts: [{ id, category_id }, ...] }` so the daemon can
   track which events the server actually inserted (the `if (row)` guard
   skips events that hit the conflict).

Performance note: we loop and insert one event at a time. Phase 0
throughput doesn't need batching (you'll see single-digit events per
minute from the stub tracker). Phase 1+ can swap to a single multi-row
insert with `db.insert(table).values([...])` — the API surface doesn't
change.

#### Reference — what the end file should look like

```ts
// apps/api/src/routes/events.ts — REFERENCE ONLY

import { createHono } from '../lib/hono-factory';
import { requireDevice } from '../lib/device-auth';
import { db } from '../lib/db';
import { activityEvents } from '../schema/activity-events';
import { devices } from '../schema/devices';
import { EventBatchSchema } from '@ctrluhr/schema';
import { categorizeEvent } from '../lib/categorizer';
import { eq } from 'drizzle-orm';

const app = createHono();

app.use('*', requireDevice);

app.post('/', async (c) => {
  const userId = c.get('userId');
  const deviceId = c.get('deviceId')!;

  const body = await c.req.json();
  const parsed = EventBatchSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid batch', details: parsed.error.flatten() }, 400);
  }

  const events = parsed.data.events;
  const receipts = [];
  for (const ev of events) {
    const { categoryId, productive } = await categorizeEvent(
      userId,
      ev.app_name,
      ev.window_title,
    );

    const [row] = await db
      .insert(activityEvents)
      .values({
        id: ev.id,
        userId,
        deviceId,
        appName: ev.app_name,
        windowTitle: ev.window_title,
        categoryId,
        productive,
        startedAt: new Date(ev.started_at),
        endedAt: new Date(ev.ended_at),
      })
      .onConflictDoNothing({ target: activityEvents.id })
      .returning({ id: activityEvents.id, categoryId: activityEvents.categoryId });

    if (row) receipts.push({ id: row.id, category_id: row.categoryId });
  }

  // Update last_seen_at on the device. One update per batch, not per event.
  await db.update(devices).set({ lastSeenAt: new Date() }).where(eq(devices.id, deviceId));

  return c.json({ receipts });
});

export { app as eventsRoute };
```

## 8. Analytics route

One endpoint, the day's breakdown. The dashboard calls it on a 15-second
interval, so this is a hot read path. Most of the file is one Drizzle
query with a SQL `extract(epoch from ...)` expression; the only library
surface is Drizzle's `sql` template tag.

### 8.1 Read these in order

1. **Drizzle — `sql` template tag** — https://orm.drizzle.team/docs/sql
   The `sql<number>\`sum(extract(epoch from ${col1} - ${col2}))::int\``
   pattern is how you drop down to raw SQL inside a Drizzle query. The
   `sql<T>` generic tells TypeScript the result type. Read the whole
   page — it's short and there's nothing else in the file that needs
   Drizzle docs.
2. **Drizzle — `groupBy`** — https://orm.drizzle.team/docs/select#group-by
   The grouping keys (category_id, category_name, productive) are
   chosen so uncategorized events (all NULLs) collapse into a single
   row. This is the only design subtlety in the file.

### 8.2 The query — read this before writing

For the day, we want: for each category the user has events in, the
total seconds spent in that category. One row per (category, productive)
combination, with uncategorized events collapsing to a single row with
all NULLs.

```sql
SELECT
  activity_events.category_id,
  categories.name AS category_name,
  activity_events.productive,
  sum(extract(epoch from activity_events.ended_at - activity_events.started_at))::int
    AS total_seconds
FROM activity_events
LEFT JOIN categories ON categories.id = activity_events.category_id
WHERE activity_events.user_id = $1
  AND activity_events.started_at >= $2
  AND activity_events.started_at <= $3
GROUP BY activity_events.category_id, categories.name, activity_events.productive
```

The Drizzle version of this query is mechanical: project the columns,
`.leftJoin(categories, ...)`, `.where(and(eq(userId), sql\`started_at >= ${start}\`, ...))`,
`.groupBy(...)`. The only Drizzle-specific thing is the `sql<number>`
template inside the `select` projection — read the doc for that.

### 8.3 Date handling

`date` comes in as a `YYYY-MM-DD` query param (default: today UTC). We
parse it to a UTC midnight start and a UTC end-of-day end, then filter
on `started_at`. The two ends are passed as JS `Date` objects; Drizzle
serializes them to Postgres `timestamptz` correctly.

The `/^\d{4}-\d{2}-\d{2}$/` regex is a quick sanity check. It accepts
"2026-02-30" which isn't a real day, but Postgres returns zero rows for
non-existent dates — graceful. If you want a real date check, use Zod
or a `Date.parse(...)` check.

### 8.4 Write `apps/api/src/routes/analytics.ts`

#### Reference — what the end file should look like

```ts
// apps/api/src/routes/analytics.ts — REFERENCE ONLY

import { createHono } from '../lib/hono-factory';
import { requireUser } from '../lib/session';
import { db } from '../lib/db';
import { activityEvents, categories } from '../schema';
import { and, eq, sql } from 'drizzle-orm';

const app = createHono();

app.use('*', requireUser);

app.get('/day', async (c) => {
  const userId = c.get('userId');
  const date = c.req.query('date') ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json({ error: 'date must be YYYY-MM-DD' }, 400);
  }

  const start = new Date(`${date}T00:00:00Z`);
  const end = new Date(`${date}T23:59:59.999Z`);

  const rows = await db
    .select({
      categoryId: activityEvents.categoryId,
      categoryName: categories.name,
      productive: activityEvents.productive,
      totalSeconds: sql<number>`sum(extract(epoch from ${activityEvents.endedAt} - ${activityEvents.startedAt}))::int`,
    })
    .from(activityEvents)
    .leftJoin(categories, eq(categories.id, activityEvents.categoryId))
    .where(
      and(
        eq(activityEvents.userId, userId),
        sql`${activityEvents.startedAt} >= ${start}`,
        sql`${activityEvents.startedAt} <= ${end}`,
      ),
    )
    .groupBy(activityEvents.categoryId, categories.name, activityEvents.productive);

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

### 8.5 Sanity check

```sh
# After ingesting some events via §7, with the session cookie:
curl 'http://localhost:3000/analytics/day?date=2026-07-14' \
  -b cookies.txt
```

Expected: `{ "date": "2026-07-14", "buckets": [...] }` with at least
one bucket if you have any ingested events for that day. If the buckets
array is empty, check the date range — UTC vs your local timezone can
shift events into the previous/next day.

## 9. Run + verify

From `apps/api/`:

```sh
bun run src/index.ts
```

In another terminal:

```sh
curl http://localhost:3000/healthz
# {"ok":true}
```

If that works, the server boots. Next, check the auth flow:

### Manual magic-link smoke

Per the magic link plugin docs (https://www.better-auth.com/docs/plugins/magic-link#sign-in-with-magic-link),
the server endpoint is `POST /auth/sign-in/magic-link` (with the handler
mounted at `/auth/*` as in §4):

```sh
curl -X POST http://localhost:3000/auth/sign-in/magic-link \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@youremail.dev"}'
```

Then check the Resend dashboard → "Logs" — your email should appear. Click
the link in your inbox → you'll land at the `callbackURL` (we default to
`/` on the web app, which 404s until `04-web-setup.md` — that's fine; the
*email mechanism* working is the goal here).

If you're sending from `onboarding@resend.dev` (the Resend sandbox sender),
it ONLY delivers to the email tied to your Resend account. Use that email
as the recipient for phase 0.

## 10. Commit `[commit]`

```sh
git add -A
git commit -m "feat(api): hono server, better-auth magic link, /events + /devices + /analytics"
```

## Common pitfalls

### better-auth `drizzleAdapter` rejects our `vouchers` table name
The `verification: schema.vouchers` mapping works because better-auth's
adapter accepts any Drizzle table whose shape matches. If the column set
differs, re-run the `auth generate` CLI (per the Drizzle adapter docs'
"Schema generation & migration" section) for the shape it expects and add
the missing columns. Note: the CLI package is now the unscoped `auth`
(`pnpm exec auth@latest generate ...`), not the older `@better-auth/cli`.

### `import { magicLink } from 'better-auth/plugins'` fails
The path may differ in your installed version. Check
`node_modules/better-auth/dist/plugins/` for the actual filename, and
verify against the Magic Link plugin docs (the docs always show the
correct import for the current version).

### `getSession` returns null even after click
Cookie domain mismatch. `BETTER_AUTH_URL` must match the URL your browser
sees for the API. If you're testing in a browser at `http://localhost:5173`
calling `http://localhost:3000`, the fetch calls to the API need
`credentials: 'include'` AND `cors({ credentials: true })` on Hono (we
set both in §4). The better-auth docs have a CORS / cookies section
under Integrations — read that if you hit issues, don't guess.

### `drizzle-orm/neon-serverless` not found
Use `drizzle-orm/neon-http` instead — the package name changed. Or bump
`drizzle-orm` to >= 0.33.0. Both work; check `node_modules/drizzle-orm/` for
which subpath exists.

### `@ctrluhr/schema` cannot be resolved by Bun
Bun resolves workspace packages through the root `pnpm-workspace.yaml` via
symlinks in `node_modules`. Run `pnpm install` from the root. If Bun still
fails, add the package to `imports` in `apps/api/package.json`:
`"imports": { "@ctrluhr/schema": "../../packages/schema/src/index.ts" }`.

### `jose` not installed
Run `pnpm add jose` in `apps/api`.

## Done criteria

- [ ] `bun run src/index.ts` boots Hono on `:3000`
- [ ] `curl /healthz` returns `{ ok: true }`
- [ ] `POST /auth/sign-in/magic-link` sends an email (visible in Resend logs)
- [ ] Session cookie set with a real login (you can verify by hitting an
  endpoint protected by `requireUser`)
- [ ] `POST /devices` with the session returns an enrollment token
- [ ] `POST /devices/enroll` with the token returns a JWT
- [ ] `POST /events` with the JWT and a batch inserts events; `GET /analytics/day` returns them
- [ ] One commit: "feat(api): hono server, better-auth magic link, /events + /devices + /analytics"

Next file: `04-web-setup.md` — TanStack Start app, auth gate, dashboard
with ECharts, devices page.