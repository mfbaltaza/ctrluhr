# 02 — Database Setup

Goal: provision Neon, enable pgvector, write the Drizzle schema, generate and
apply your first migration. By end of this file you can run a SQL query
against your DB and see the empty tables.

> Assumes you have done `01-monorepo-setup.md` and your pnpm workspace is
> installed.

## 1. Provision the external services

### Neon (Postgres + pgvector)

1. Sign in at https://neon.tech (GitHub OAuth is fastest).
2. Create a project called `ctrluhr`.
3. Pick region closest to you for development.
4. On the project dashboard, find the **Connection string** for the
   `main` branch, `psql` variant. It looks like:
   `postgresql://user:password@ep-xxx.region.aws.neon.tech/ctrluhr?sslmode=require`
5. Save it locally to `apps/api/.env` (we'll use this in step 4):

```sh
# apps/api/.env
DATABASE_URL="postgresql://...neon.tech/ctrluhr?sslmode=require"
```

ADD `apps/api/.env` to your `.gitignore` — actually it's already there from
Step 1. Keep it out of git. We'll commit only `.env.example`.

6. **Enable pgvector**: in Neon dashboard → choose your project → "SQL Editor"
   or use psql. Run:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

Confirm with:
```sql
SELECT extname FROM pg_extension WHERE extname = 'vector';
```

It should return one row. If it doesn't, your Neon plan doesn't support
extensions — every free-tier region I've tried does. Try a different region
or open a support chat.

### Copy your `.env.example`

Create `apps/api/.env.example` (this one is committed):

```sh
# apps/api/.env.example
# Database — Neon Postgres w/ pgvector
DATABASE_URL="postgresql://user:password@ep-xxx.region.aws.neon.tech/ctrluhr?sslmode=require"

# Auth — better-auth
BETTER_AUTH_SECRET="change-me-32-bytes-of-random-string"
BETTER_AUTH_BASE_URL="http://localhost:3001"
API_BASE_URL="http://localhost:3001"

# Resend (magic link emails)
RESEND_API_KEY="re_xxxxxxxxxxxx"
RESEND_FROM_EMAIL="ctrluhr <noreply@yourdomain.dev>"
# For dev without a domain: use Resend's on sandbox domain: onboarding@resend.dev

# OpenAI (embeddings)
OPENAI_API_KEY="sk-..."

# CORS
WEB_ORIGIN="http://localhost:3000"
```

### Resend

1. Sign in at https://resend.com
2. API Keys → "Create API Key", name it `ctrluhr-dev`
3. Save the `re_xxx...` to your `.env` as `RESEND_API_KEY`
4. For development you don't need a verified domain — Resend lets you send
   from `onboarding@resend.dev` to YOUR account email only. That's enough for
   phase 0. Magic links to other accounts won't deliver until you verify a
   domain (do that later if you want to demo to others).

### OpenAI

1. Sign in at https://platform.openai.com
2. API Keys → Create new secret key → name `ctrluhr-dev`
3. Add $5 of credit if you haven't (covers development for months)
4. Save to `.env` as `OPENAI_API_KEY`

### `BETTER_AUTH_SECRET`

Generate a random 32-byte string:

```sh
openssl rand -base64 32
```

Put it in your `.env` as `BETTER_AUTH_SECRET`. This signs session cookies —
never commit it.

## 2. Install Drizzle deps in `apps/api`

Drizzle comes in two packages: `drizzle-orm` (runtime) and `drizzle-kit` (CLI
for migrations). You already added them to `apps/api/package.json` in Step
01 — re-run `pnpm install` to be sure:

```sh
pnpm install
```

Add the Neon serverless driver too (already in deps):
`@neondatabase/serverless`. This is a fetch-based driver — perfect for Bun
and edge environments.

### `apps/api/tsconfig.json`

Create it (extending our base):

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "types": ["bun-types"],
    "paths": {
      "@ctrluhr/schema": ["../../packages/schema/src/index.ts"],
      "@ctrluhr/schema/*": ["../../packages/schema/src/*"]
    },
    "baseUrl": "."
  },
  "include": ["src/**/*", "migrations/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

Installing `@types/bun` (already in deps) gives you `bun-types`. The `paths`
aliases let `import { ActivityEventSchema } from '@ctrluhr/schema'` resolve
in TS land. Bun itself resolves the workspace package by `name` from
`package.json`, so it works at runtime too.

## 3. Drizzle schema files

This is the **source of truth** for your database shape. Any change here →
`drizzle-kit generate` → migration SQL checked into git → `drizzle-kit push`
or `migrate`.

Create `apps/api/src/schema/index.ts` that re-exports everything:

```ts
export * from './users';
export * from './sessions';
export * from './verifications';
export * from './devices';
export * from './categories';
export * from './category-rules';
export * from './activity-events';
export * from './habits';
export * from './habit-checkins';
```

### `apps/api/src/schema/users.ts`

```ts
import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * better-auth's user table. We define it here so Drizzle manages migrations;
 * better-auth reads/writes via its own client (which uses our Drizzle pool).
 */
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  emailVerified: timestamp('email_verified').defaultNow(),
  name: text('name'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
```

Note: better-auth will define its own schema requirements, which may include
a few extra columns (`image`, `emailVerificationToken`). When you install
better-auth in 03-api-setup.md and run its CLI, you may need to add columns
here. Plan for one migration after that step.

### `apps/api/src/schema/sessions.ts`

```ts
import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core';
import { users } from './users';

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(),
  expiresAt: timestamp('expires_at').notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
```

### `apps/api/src/schema/verifications.ts`

```ts
import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core';
import { users } from './users';

export const vouchers = pgTable('verifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  token: text('token').notNull(),
  type: text('type').notNull(),           // 'magic_link' | 'device_enroll' | ...
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
```

### `apps/api/src/schema/devices.ts`

```ts
import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';
import { users } from './users';

export const devices = pgTable(
  'devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    os: text('os').notNull(), // 'linux' | 'windows' | 'darwin'
    apiTokenHash: text('api_token_hash').notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userIdx: index('devices_user_id_idx').on(t.userId),
  }),
);
```

### `apps/api/src/schema/categories.ts`

This is the first table using pgvector. Drizzle needs the `vector` type which
comes from `drizzle-orm/pg-core` (since v0.32+). The export name we use:
`vector`.

```ts
import { pgTable, uuid, text, timestamp, integer, index } from 'drizzle-orm/pg-core';
import { vector } from 'drizzle-orm/pg-core';
import { users } from './users';

export const categories = pgTable(
  'categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color').notNull().default('#6b7280'),
    // -1 distracting, 0 neutral, 1 productive
    isProductive: integer('is_productive').notNull().default(0),
    // category centroid; vector(1536) matches text-embedding-3-small
    embedding: vector('embedding', { dimensions: 1536 }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userUniqueName: uniqueIndex('categories_user_name_uniq').on(t.userId, t.name),
    userIdx: index('categories_user_id_idx').on(t.userId),
  }),
);
```

Note: `vector` was added to `drizzle-orm/pg-core` recently; if it's not
exported in your installed version, bump `drizzle-orm` to `^0.33.0` or
later. (We pinned that in 01.)

### `apps/api/src/schema/category-rules.ts`

```ts
import { pgTable, uuid, text, index, primaryKey } from 'drizzle-orm/pg-core';
import { categories } from './categories';

export const categoryRules = pgTable(
  'category_rules',
  {
    categoryId: uuid('category_id').notNull().references(() => categories.id, { onDelete: 'cascade' }),
    patternType: text('pattern_type').notNull(), // 'app_name' | 'title_regex'
    pattern: text('pattern').notNull(),
    priority: integer('priority').default(0),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.categoryId, t.pattern] }),
    categoryIdx: index('category_rules_category_idx').on(t.categoryId),
  }),
);
```

Need to import `integer` — add it to the imports at the top.

### `apps/api/src/schema/activity-events.ts`

```ts
import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  index,
  vector,
} from 'drizzle-orm/pg-core';
import { users } from './users';
import { devices } from './devices';
import { categories } from './categories';

export const activityEvents = pgTable(
  'activity_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
    appName: text('app_name').notNull(),
    windowTitle: text('window_title').notNull(),
    categoryId: uuid('category_id').references(() => categories.id),
    // Snapshot of category.is_productive at event time
    productive: integer('productive'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }).notNull(),
    // Cached embedding of (app || '' || window_title). Used for retroactive
    // reclassification without re-paying OpenAI.
    rawEmbedding: vector('raw_embedding', { dimensions: 1536 }),
  },
  (t) => ({
    userStartedIdx: index('activity_events_user_started_idx').on(t.userId, t.startedAt),
    userCatIdx: index('activity_events_user_cat_idx').on(t.userId, t.categoryId, t.startedAt),
  }),
);
```

Two notes:
1. **Duration column**: We skipped `duration_sec` in Drizzle because Drizzle
   does not yet support generated columns cleanly. Compute duration in SQL
   queries (`EXTRACT(EPOCH FROM ended_at - started_at)`) or in app code.
   Phase 2 can add a generated column via raw SQL migration.
2. **HNSW index on `raw_embedding`**: defer for phase 2. Adding HNSW on an
   empty table is instant; adding it later on a big one needs `CONCURRENTLY`.

### `apps/api/src/schema/habits.ts`

```ts
import { pgTable, uuid, text, integer, timestamp } from 'drizzle-orm/pg-core';
import { users } from './users';
import { categories } from './categories';

export const habits = pgTable('habits', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  targetMinutesPerDay: integer('target_minutes_per_day').notNull().default(60),
  color: text('color').notNull().default('#22c55e'),
  cadence: text('cadence').notNull().default('daily'),
  linkedCategoryId: uuid('linked_category_id').references(() => categories.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
```

### `apps/api/src/schema/habit-checkins.ts`

```ts
import { pgTable, uuid, date, integer, boolean, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { habits } from './habits';
import { users } from './users';

export const habitCheckins = pgTable(
  'habit_checkins',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    habitId: uuid('habit_id').notNull().references(() => habits.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    day: date('day').notNull(),
    minutesActual: integer('minutes_actual').notNull().default(0),
    achieved: boolean('achieved').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    habitDayUniq: uniqueIndex('habit_checkins_habit_day_uniq').on(t.habitId, t.day),
  }),
);
```

### Re-export `integer` in `category-rules.ts` (fix forward)

Earlier in that file we used `integer` without importing it. Edit the import
line to:

```ts
import { pgTable, uuid, text, integer, index, primaryKey } from 'drizzle-orm/pg-core';
```

## 4. `drizzle.config.ts`

In `apps/api/`:

```ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/schema/index.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  schemaFilter: 'public',
  verbose: true,
  strict: true,
});
```

## 5. Generate the first migration

From `apps/api/`:

```sh
DATABASE_URL="your-neon-connection-string" pnpm exec drizzle-kit generate
```

(`pnpm exec` because we want the workspace-local drizzle-kit.)

Alternatively, create `apps/api/.env` and use `bun --env-file=.env` to load
it. The exact invocation depends on your shell. Use whatever you prefer —
the key thing is the env var must be available when drizzle-kit runs.

Result: a new folder `apps/api/migrations/0000_<timestamp>_<hash>.sql` with
the SQL for all tables. Open and read it — make sure every table you
defined is there. Look for:
- `CREATE TABLE activity_events ...` with a `vector(1536)` column.
- `CREATE INDEX` statements at the bottom.
- `CREATE EXTENSION IF NOT EXISTS vector;` is NOT in the migration (Drizzle
  assumes it's already enabled — which we did manually).

Read every line of that SQL file. You're learning what Drizzle emits, which
is the first thing to check when the DB misbehaves later.

## 6. Apply the migration

Two options:

### Option A (recommended for dev): `drizzle-kit push`

Applies the schema directly to the DB without creating a migration file. Use
this while iterating on schema shape.

```sh
DATABASE_URL="..." pnpm exec drizzle-kit push
```

If it prompts about new tables/vectors/columns, answer yes.

### Option B (more production-like): `drizzle-kit migrate`

Runs existing migration files sequentially. Steps: generate then migrate.

```sh
DATABASE_URL="..." pnpm exec drizzle-kit migrate
```

For phase 0 use option A. Switch to option B once you start versioning
migrations for real (phase 1+).

## 7. Verify with SQL

Neon's dashboard SQL editor is the fastest way to verify. Connect (or use
`psql` locally with your connection string) and run:

```sql
\dt                                     -- list tables
SELECT count(*) FROM users;             -- should be 0
SELECT column_name, data_type FROM information_schema.columns
  WHERE table_name = 'activity_events' ORDER BY ordinal_position;
SELECT * FROM pg_extension WHERE extname = 'vector';
```

You should see all 9 tables (users, sessions, verifications, devices,
categories, category_rules, activity_events, habits, habit_checkins), and
the `activity_events` columns including `raw_embedding vector(1536)`.

## 8. Commit `[commit]`

```sh
git add -A
git commit -m "feat(db): drizzle schema + initial migration for all tables"
```

## Common pitfalls

### `drizzle-kit generate` says `No schema found`
Your `drizzle.config.ts` `schema` path is wrong. It should point to the file
that re-exports all tables (`./src/schema/index.ts`). Double-check.

### `vector` type not recognized
Several possible causes:
1. pgvector extension not enabled on Neon — run `CREATE EXTENSION vector` again.
2. `drizzle-orm` version too old — bump to `^0.33.0` or later.
3. The `vector()` import not exposed from `drizzle-orm/pg-core` — check
   `node_modules/drizzle-orm/pg-core/index.d.ts` for `vector`.

### `drizzle-kit push` refuses due to data loss
This happens when a column or table would be dropped. It's normally safe to
confirm because the DB is empty during phase 0, but inspect the diff before
confirming.

### `pnpm exec drizzle-kit` says module not found
You didn't `pnpm install` from the workspace root recently. Re-run it.

### `DATABASE_URL` not loaded
Drizzle-kit doesn't auto-load `.env` files. Two solutions:
1. Prefix the command inline: `DATABASE_URL="..." pnpm exec drizzle-kit ...`
2. Install `dotenv` (or `bun --env-file`) and add a script in
   `apps/api/package.json`: `"db:push": "bun --env-file=.env node_modules/.bin/drizzle-kit push"`.

## Done criteria

- [ ] Neon project created, connection string saved to `.env` (not committed)
- [ ] pgvector extension enabled (verified via `pg_extension` query)
- [ ] Resend API key saved to `.env`
- [ ] OpenAI API key saved to `.env`
- [ ] `BETTER_AUTH_SECRET` generated and saved to `.env`
- [ ] `.env.example` committed with placeholders
- [ ] All 9 Drizzle schema files written and exports re-exported
- [ ] `drizzle.config.ts` configured
- [ ] First migration generated (or push applied) — all tables exist in DB
- [ ] SQL verification confirms `activity_events.raw_embedding` is `vector(1536)`
- [ ] One commit: "feat(db): drizzle schema + initial migration"

Next file: `03-api-setup.md` — Hono server bootstrap, better-auth magic link
flow, device enrollment, `/events` ingest route, `/analytics/day` route.