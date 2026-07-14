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

better-auth lives in its own instance. The web app talks to it via the
`better-auth/client` (in `04-web-setup.md`). The API mounts its Hono router
at `/auth/*`.

### `apps/api/src/auth.ts`

```ts
import { betterAuth } from 'better-auth';
import { magicLink } from 'better-auth/plugins';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
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
  baseURL: process.env.BETTER_AUTH_BASE_URL!,
  secret: process.env.BETTER_AUTH_SECRET!,
  emailAndPassword: { enabled: false },
  plugins: [
    magicLink({
      sendMagicLink: async ({ email, token, url }, request) => {
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

Notes:
- better-auth's `verification` table maps to our `vouchers` table (we named
  it awkwardly in 02). Once you run this and check the schema, you may want
  to rename `vouchers` to `verifications` — but only if it bothers you. It's
  purely cosmetic.
- `sendMagicLink`'s `url` is the URL the user clicks — better-auth appends
  the token as a query param. We send it via Resend.
  - `baseURL` is where better-auth is hosted (your API), not the web app. In
  dev: `http://localhost:3000`.
- `emailAndPassword: { enabled: false }` because you chose magic link only.

### Sync better-auth schema requirements

better-auth may want a few extra columns on `users`/`sessions`/`verifications`.
Run its CLI to see:

```sh
pnpm exec @better-auth/cli@latest generate --config src/auth.ts
```

The output is a Drizzle schema snippet. Compare with your `users.ts`,
`sessions.ts`, `verifications.ts`. Add any missing columns. Re-run
`drizzle-kit generate` and `drizzle-kit push` to apply.

This step is annoying but one-time — better-auth reads from those columns
forever after, so you won't need to touch them again.

## 4. Hono bootstrap

### `apps/api/src/index.ts`

```ts
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

Bun picks up `export default { port, fetch }` as the entrypoint when you
`bun run src/index.ts`.

## 5. Auth middlewares

### `apps/api/src/lib/session.ts` — verifies the user's browser session

```ts
import { createHono } from '../lib/hono-factory';
import { auth } from '../auth';
import type { User } from 'better-auth';

export const requireUser = createHono();
export type UserCtx = {
  Variables: { user: User; userId: string };
};

requireUser.use('*', async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: 'unauthorized' }, 401);
  c.set('user', session.user);
  c.set('userId', session.user.id);
  await next();
});
```

We reference a `honoFactory` helper — create it:

### `apps/api/src/lib/hono-factory.ts`

```ts
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

### `apps/api/src/lib/device-jwt.ts`

Devices authenticate with a long-lived JWT signed by the API. The JWT
contains `device_id` and `user_id`. The device's enrollment token is *not*
the JWT — it's a one-time token the user gets on device creation, exchanged
*once* for a JWT which then lives in the daemon's config.

```ts
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

`jose` was already installed in §0. If you skipped that, `pnpm --filter @ctrluhr/api add jose` now.

### `apps/api/src/lib/device-auth.ts` — middleware verifying the device JWT

```ts
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

## 6. Devices routes

Two handlers sharing one router:

### `apps/api/src/routes/devices.ts`

```ts
import { createHono } from '../lib/hono-factory';
import { requireUser } from '../lib/session';
import { db } from '../lib/db';
import { devices } from '../schema/devices';
import { vouchers } from '../schema/verifications';
import { eq } from 'drizzle-orm';
import { signDeviceJwt } from '../lib/device-jwt';
import { randomBytes } from 'crypto';

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
  const expires = new Date(Date.now() + 30 * 60 * 1000); // 30 min enrolment window

  await db.insert(vouchers).values({
    userId,
    token,
    type: 'device_enroll',
    expiresAt: expires,
  });

  return c.json({ enrollment_token: token, expires_at: expires.toISOString() });
});
```

Wait — we created the enrollment token but not the actual device record.
The device row gets created on `/devices/enroll` when the daemon exchanges
the token. That way no orphan device rows if the user generates a token and
never uses it.

Add the enroll route:

```ts
app.post('/enroll', async (c) => {
  const body = await c.req.json<{ enrollment_token?: string; name?: string; os?: string }>();
  if (!body?.enrollment_token || !body?.name || !body?.os) {
    return c.json({ error: 'enrollment_token, name, os required' }, 400);
  }

  // Look up an unused, unexpired enrollment token.
  const rows = await db
    .select()
    .from(vouchers)
    .where(eq(vouchers.token, body.enrollment_token))
    .limit(1);
  const row = rows[0];
  if (!row || row.type !== 'device_enroll' || row.expiresAt < new Date()) {
    return c.json({ error: 'invalid or expired token' }, 401);
  }

  // Create device
  const apiToken = randomBytes(48).toString('hex');
  const apiTokenHash = await hashToken(apiToken);
  const [device] = await db
    .insert(devices)
    .values({
      userId: row.userId,
      name: body.name,
      os: body.os,
      apiTokenHash: apiTokenHash ?? '',
    })
    .returning();

  // Delete the enrollment voucher (one-time use)
  await db.delete(vouchers).where(eq(vouchers.id, row.id));

  // Issue the long-lived JWT
  const jwt = await signDeviceJwt({ deviceId: device.id, userId: row.userId });

  return c.json({ device_id: device.id, api_token: jwt });
});

async function hashToken(t: string): Promise<string> {
  const { createHash } = await import('crypto');
  return createHash('sha256').update(t).digest('hex');
}
```

Decision: we return `api_token` as the JWT directly (not the random `apiToken`
we hashed). The hash stored is for the raw random, used as a secondary
identifier later if you want to support rotating keys. For phase 0 the JWT
alone is sufficient. The `apiTokenHash` column stores the SHA-256 of the
random — corresponds to "this device was provisioned from this enrollment",
lets you later add the raw-token comparison flow if you want the ability to
send the raw token instead of a JWT.

Simplification: if you find this confusing, just store the JWT's `kid` or
hash of the JWT itself. The point is: daemon has the JWT, server can verify
the JWT without a DB lookup. The `api_token_hash` becomes a permanent
identifier you can compare if you ever want to revoke without JWT exp.

For phase 0 keep it as written. You can refine in phase 1.

## 7. Events route

### `apps/api/src/lib/embeddings.ts`

```ts
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

For phase 0 we won't actually call `embed()` on every event — the categorizer
is rules-only. But the function is defined so phase 2 is a one-liner swap.

### `apps/api/src/lib/categorizer.ts` — rules-only for phase 0

```ts
import { db } from './db';
import { categories, categoryRules } from '../schema';
import { eq, and } from 'drizzle-orm';

export async function categorizeEvent(
  userId: string,
  appName: string,
  windowTitle: string,
): Promise<{ categoryId: string | null; productive: number | null }> {
  // For phase 0: rule match by app_name only. Title_regex matching comes in phase 2.
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
    return {
      categoryId: hit.categoryId,
      productive: hit.isProductive,
    };
  }
  return { categoryId: null, productive: null };
}
```

### `apps/api/src/routes/events.ts`

```ts
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

  // Update last_seen_at on the device.
  await db.update(devices).set({ lastSeenAt: new Date() }).where(eq(devices.id, deviceId));

  return c.json({ receipts });
});

export { app as eventsRoute };
```

Notes:
- We use `.onConflictDoNothing({ target: activityEvents.id })` so replays are
  safe. Drizzle compiles to `INSERT ... ON CONFLICT (id) DO NOTHING`.
- We loop and insert one-by-one for simplicity. Phase 1 can batch the inserts
  in a single SQL query for performance. Phase 0 throughput is plenty.
- The `id` is provided by the daemon (UUID generated client-side). Critical
  for idempotency.

## 8. Analytics route

For the dashboard, you need one endpoint that returns the day's breakdown.

### `apps/api/src/routes/analytics.ts`

```ts
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

Notes:
- `sql<number>` tells Drizzle the expression is a number; the `::int` cast
  makes Postgres agree.
- We group by `category_id, category_name, productive` so uncategorized
  events (all NULLs) collapse into one row.
- For phase 0 this is enough. Phase 1 will add an hourly breakdown for the
  ECharts timeline.

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

```sh
curl -X POST http://localhost:3000/auth/...
```

Better-auth's magic-link endpoint is a POST to `/auth/magic-link/send`. Body:
`{ email: "you@youremail.dev" }`. Run it, then check Resend's dashboard →
"Logs" — should show your email. Click the link in your inbox → you should
land at your web app's `/` (we haven't built that yet, so it'll 404 — that's
fine, the *email* mechanism working is the goal).

If Resend is sending to `onboarding@resend.dev` sandbox, it ONLY delivers to
your Resend-account email. Use that email as the recipient for phase 0.

## 10. Commit `[commit]`

```sh
git add -A
git commit -m "feat(api): hono server, better-auth magic link, /events + /devices + /analytics"
```

## Common pitfalls

### better-auth `drizzleAdapter` rejects our `vouchers` table name
The `verification: schema.vouchers` mapping works because better-auth's
adapter accepts any Drizzle table the shape matches. If the column set
differs, see `pnpm exec @better-auth/cli generate` for the shape it expects
and add the missing columns.

### `import { magicLink } from 'better-auth/plugins'` fails
The path may differ in your installed version. Try
`from 'better-auth/plugins/magic-link'`. Check `node_modules/better-auth/dist/plugins/`.

### `getSession` returns null even after click
Cookie domain mismatch. `BETTER_AUTH_BASE_URL` must match the URL your
browser sees. If you're testing in a browser at `http://localhost:5173`
calling `http://localhost:3000`, the fetch calls to the API need
`credentials: 'include'` AND `cors({ credentials: true })` on Hono (we set
both). In better-auth's session cookie options, ensure the cookie is scoped
to be readable cross-origin — see better-auth docs on "Clinton" (their
CORS section).

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
- [ ] `POST /auth/magic-link/send` sends an email (visible in Resend logs)
- [ ] Session cookie set with a real login (you can verify by hitting an
  endpoint protected by `requireUser`)
- [ ] `POST /devices` with the session returns an enrollment token
- [ ] `POST /devices/enroll` with the token returns a JWT
- [ ] `POST /events` with the JWT and a batch inserts events; `GET /analytics/day` returns them
- [ ] One commit: "feat(api): hono server, better-auth magic link, /events + /devices + /analytics"

Next file: `04-web-setup.md` — TanStack Start app, auth gate, dashboard
with ECharts, devices page.