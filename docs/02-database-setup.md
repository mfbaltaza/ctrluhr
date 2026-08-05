# 02 — Database Setup

Goal: provision Neon, enable pgvector, write the Drizzle schema, generate and
apply your first migration. By the end of this file you can run a SQL query
against your DB and see the empty tables.

> **This phase is built.** Every step below already exists in the repo. The
> Verify blocks are idempotent state checks — they double as entry checks, so
> you can start at any step whose Assumes pass. Assumes/Produces chain the
> steps together; start at the first step whose Assumes checks succeed.

## 1. Provision the external services

### Step 1 — Create the Neon project and save the connection string

**Assumes**

- `01-monorepo-setup.md` done: pnpm workspace installed, `apps/api` exists.
  Check: `test -d apps/api && pnpm exec nx show projects 2>/dev/null | grep -q api && echo ok`

**Read first**

- https://neon.tech/docs/connect/connect-from-any-app — where the connection
  string lives on the dashboard (the `psql` variant is what you save).

**Do**

Sign in at https://neon.tech (GitHub OAuth is fastest), create a project named
`ctrluhr`, pick a region close to you, and copy the connection string for the
`main` branch, `psql` variant. It looks like:

```
postgresql://user:password@ep-xxx.region.aws.neon.tech/ctrluhr?sslmode=require
```

Save it to `apps/api/.env` as `DB_URL`. Note the variable is **`DB_URL`**, not
`DATABASE_URL` — that is what `drizzle.config.ts` and `lib/db.ts` read (the
older docs and ADR-0006-era commits used the other name; the repo uses `DB_URL`
everywhere now).

```sh
# apps/api/.env (gitignored — see Step 2)
DB_URL="postgresql://user:password@ep-xxx.region.aws.neon.tech/ctrluhr?sslmode=require"
```

**Verify**

```sh
test -f apps/api/.env && grep -q '^DB_URL=' apps/api/.env && echo ok
# → ok
```

The DB-backed checks (extension, tables) come in Steps 4 and 11 and need this
connection string to exist.

**Produces**

- `apps/api/.env` containing `DB_URL` (not committed).

### Step 2 — Commit the `.env.example`, ignore `.env`

**Assumes**

- Step 1: `apps/api/.env` exists with `DB_URL`.

**Read first**

None — this is our own env contract.

**Do**

The root `.gitignore` (from 01) already excludes `.env` and `.env.*.local` but
re-includes `!.env.example`, so only the example is committable. Create
`apps/api/.env.example` — the committed template that documents every variable
the API reads. It must stay in sync with what the code actually reads:
`DB_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `API_BASE_URL`,
`RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `OPENAI_API_KEY`, `WEB_ORIGIN`,
`SMOKE_TEST_EMAIL`.

Generate the auth secret with:

```sh
openssl rand -base64 32
```

and put it in `apps/api/.env` as `BETTER_AUTH_SECRET`. This signs session
cookies — never commit it. (better-auth reads `BETTER_AUTH_URL`, the URL of
the API; an older draft used `BETTER_AUTH_BASE_URL`, renamed to match the
library.)

**Reference** (REFERENCE ONLY — the committed shape, not a copy-paste source)

```sh
# apps/api/.env.example
# Database — Neon Postgres w/ pgvector
DB_URL="postgresql://user:password@ep-xxx.region.aws.neon.tech/ctrluhr?sslmode=require"

# Auth — better-auth
BETTER_AUTH_SECRET="change-me-32-bytes-of-random-string"
BETTER_AUTH_URL="http://localhost:3000"
API_BASE_URL="http://localhost:3000"

# Resend (magic link emails)
RESEND_API_KEY="re_xxxxxxxxxxxx"
RESEND_FROM_EMAIL="ctrluhr <noreply@yourdomain.dev>"
# For dev without a domain: use Resend's on sandbox domain: onboarding@resend.dev

# OpenAI (embeddings)
OPENAI_API_KEY="sk-..."

# CORS
WEB_ORIGIN="http://localhost:5173"

# Smoke test — apps/api/test-resend.ts (magic-link end-to-end)
SMOKE_TEST_EMAIL="you@example.com"
```

**Verify**

```sh
git check-ignore apps/api/.env          # must print apps/api/.env (ignored)
git ls-files apps/api/.env.example      # must print apps/api/.env.example (tracked)
```

**Produces**

- `apps/api/.env` with real values (ignored), `apps/api/.env.example`
  (committed, placeholders).

### Step 3 — Enable pgvector on Neon

**Assumes**

- Step 1: connection string saved to `apps/api/.env`.

**Read first**

- https://neon.tech/docs/extensions/pgvector — pgvector availability on Neon.

**Do**

In the Neon dashboard, open the SQL editor for the project (or connect with
`psql`) and run:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

The initial Drizzle migration also carries a `CREATE EXTENSION IF NOT EXISTS
vector;` guard at the top (restored in commit `f8382a6`) so a fresh or local
database gets the extension even if you skip this manual step — on Neon it is
already enabled and the line is a no-op.

**Verify**

```sh
DB_URL="$(grep '^DB_URL=' apps/api/.env | cut -d'"' -f2)"
psql "$DB_URL" -tAc "SELECT extname FROM pg_extension WHERE extname = 'vector';"
# → vector
```

**Pitfalls**

- `drizzle-kit migrate` fails with `extension "vector" is not available` (or
  `type "vector" does not exist`) against a non-Neon/local database whose
  vector extension was never created. The migration guard covers it; if you
  hit it anyway, the database's extension support is the problem, not the
  migration.

**Produces**

- `vector` extension enabled on the Neon database.

### Step 4 — Resend and OpenAI keys

**Assumes**

- Step 2: `apps/api/.env` exists.

**Read first**

None — both are external-account setup used by later docs (03: magic-link
email, 04+: embeddings).

**Do**

- **Resend** (https://resend.com): API Keys → create `ctrluhr-dev`, save the
  `re_xxx...` as `RESEND_API_KEY`. For development you don't need a verified
  domain — Resend sends from `onboarding@resend.dev` to your account email
  only. That is enough for phase 0.
- **OpenAI** (https://platform.openai.com): create a key `ctrluhr-dev`, save
  as `OPENAI_API_KEY`. This is a placeholder in `.env` today — embeddings are
  suspended (ADR-0002) and phase 0 never calls OpenAI, so a real key can wait.
- `SMOKE_TEST_EMAIL`: set it to your own email for the 03 magic-link smoke
  test.

**Verify**

```sh
grep -cE '^(RESEND_API_KEY|RESEND_FROM_EMAIL|SMOKE_TEST_EMAIL)=' apps/api/.env
# → 3
```

**Produces**

- `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `SMOKE_TEST_EMAIL` (and optionally
  `OPENAI_API_KEY`) populated in `apps/api/.env`.

## 2. Install Drizzle deps

### Step 5 — Add `drizzle-orm`, `drizzle-kit`, `@neondatabase/serverless`

**Assumes**

- 01 done, workspace installed: `pnpm exec nx show projects | grep -q api && echo ok`

**Read first**

- https://orm.drizzle.team/docs/get-started-postgresql — how Drizzle connects
  to Postgres.
- https://orm.drizzle.team/docs/column-types — pg-core column types, including
  `vector`.

**Do**

Drizzle ships as two packages: `drizzle-orm` (runtime) and `drizzle-kit` (CLI:
generate/migrate/push). `@neondatabase/serverless` is the fetch-based driver —
the right one for Bun and edge. `01` deliberately did not pre-bake these; they
land here with the code that uses them. From the repo root:

```sh
pnpm --filter @ctrluhr/api add drizzle-orm@1.0.0-rc.4 @neondatabase/serverless
pnpm --filter @ctrluhr/api add -D drizzle-kit@1.0.0-rc.4
```

Pin `drizzle-orm`/`drizzle-kit` to `1.0.0-rc.4`: the `vector` column type, the
folder-per-migration output, and the `check` command are all rc.4 behavior.
Let `@neondatabase/serverless` float (`^1.1.0`).

**Verify**

```sh
grep -E '"(drizzle-orm|drizzle-kit|@neondatabase/serverless)"' apps/api/package.json
```

Expected (order differs):

```json
"@neondatabase/serverless": "^1.1.0",
"drizzle-orm": "1.0.0-rc.4",
"drizzle-kit": "1.0.0-rc.4"
```

**Produces**

- Drizzle deps in `apps/api/package.json`.

## 3. Drizzle schema files

### Step 6 — `apps/api/tsconfig.json`

**Assumes**

- 01 produced `tsconfig.base.json` at the repo root and the Hono CLI scaffolded
  `apps/api` with a `tsconfig.json`. Check:
  `test -f tsconfig.base.json && test -f apps/api/tsconfig.json && echo ok`

**Read first**

None — our own config, extending the base from 01.

**Do**

`apps/api/tsconfig.json` extends the workspace base and adds the Bun type
environment (`@types/bun` is a devDependency) plus `@ctrluhr/schema` path
aliases so `import ... from '@ctrluhr/schema'` resolves in TS land. It also
typechecks `drizzle.config.ts` and the migration snapshots.

**Reference** (REFERENCE ONLY)

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./",
    "types": ["bun"],
    "jsx": "react-jsx",
    "jsxImportSource": "hono/jsx",
    "paths": {
      "@ctrluhr/schema": ["../../packages/schema/src/index.ts"],
      "@ctrluhr/schema/*": ["../../packages/schema/src/*"]
    }
  },
  "include": ["src/**/*", "migrations/**/*.ts", "drizzle.config.ts"],
  "exclude": ["node_modules", "dist"]
}
```

**Verify**

```sh
pnpm --filter @ctrluhr/api typecheck
# exit 0 (currently: passes clean)
```

**Produces**

- `apps/api/tsconfig.json`.

### Step 7 — The schema barrel and the better-auth-owned tables

**Assumes**

- Step 5: `drizzle-orm` installed. Check: `test -d apps/api/node_modules/drizzle-orm && echo ok`
- ADR-0006 in force: auth-managed ids are `text`, not `uuid`.

**Read first**

- https://orm.drizzle.team/docs/column-types — `text`, `boolean`, `timestamp`
  with timezone.
- https://orm.drizzle.team/docs/indexes-constraints — `primaryKey`, `unique`,
  `index`, `references`.

**Do**

Write `apps/api/src/schema/` — the single source of truth for the DB shape.
Any change here → `drizzle-kit generate` → migration SQL checked into git →
`drizzle-kit migrate`.

**Ids are `text`, not `uuid`** (ADR-0006). better-auth owns `users`,
`sessions`, `verifications` and supplies id values itself, so those tables use
`text` primary keys with **no server-side default** — and every table that
references them (`*.user_id`, `*.device_id`, `*.category_id`, etc.) is also
`text` for the FK types to match. There is no `gen_random_uuid()` anywhere in
the schema. This was the single most expensive doc/code drift in the project:
the original docs declared `uuid('id').defaultRandom()`, better-auth wrote
`text` ids, and the magic-link smoke test failed at the database with
`22P02 invalid input syntax for type uuid: <32-char hex>` (see Pitfalls).

The `account` table from better-auth's generated schema is **deferred** to
phase 1+ (OAuth) — magic link doesn't read or write it, so creating it now
would carry unused columns.

Create the barrel that re-exports every table file:

```ts
// apps/api/src/schema/index.ts
export * from './activity-events';
export * from './categories';
export * from './category-rules';
export * from './devices';
export * from './habit-checkins';
export * from './habits';
export * from './sessions';
export * from './users';
export * from './verifications';
```

Then the three better-auth-owned tables. `emailVerified` is a **boolean**
(not a timestamp) — that is better-auth's contract. `verifications` carries
`identifier`/`value` (NOT NULL) and a **nullable** `user_id`; the old
`token`/`type` columns were dropped as dead draft, and `users.image` was added,
all in the ADR-0006 alignment migration.

```ts
// apps/api/src/schema/users.ts
import { boolean, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').default(false).notNull(),
  name: text('name'),
  image: text('image'),
  timezone: text('timezone').notNull().default('UTC'), // IANA setting (ADR-0003)
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
```

Note: `timezone` is present on `users` (default `'UTC'`, IANA string). It was
added in the pre-phase-1 batch per ADR-0003 (day boundaries are user-local) —
the canonical schema in `00-plan-overview.md` §4 lists it as a real column.

```ts
// apps/api/src/schema/sessions.ts
import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { users } from './users';

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
```

```ts
// apps/api/src/schema/verifications.ts
import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { users } from './users';

export const verifications = pgTable('verifications', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  userId: text('user_id').references(() => users.id, {
    onDelete: 'cascade',
  }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
```

**Verify**

```sh
test -f apps/api/src/schema/index.ts \
  && test -f apps/api/src/schema/users.ts \
  && test -f apps/api/src/schema/sessions.ts \
  && test -f apps/api/src/schema/verifications.ts && echo ok
# no gen_random_uuid/defaultRandom anywhere (ADR-0006 applied):
! rg -q "defaultRandom|gen_random_uuid" apps/api/src/schema && echo ok
pnpm --filter @ctrluhr/api typecheck   # exit 0
```

**Pitfalls**

- `22P02 invalid input syntax for type uuid: <32-char hex>` — what happens when
  the schema says `uuid` but better-auth inserts a `text` id. This is ADR-0006's
  origin: the 03 schema-sync was skipped, drift went undetected, and the
  magic-link smoke test died at the database. The fix was a migration that
  `ALTER COLUMN ... TYPE text USING <col>::text` on every PK/FK (the
  `20260730232745_faulty_vulture` migration) plus deleting `verifications.token`
  and `.type`. Keep ids `text` and this class of failure stays gone.

**Produces**

- `apps/api/src/schema/{index,users,sessions,verifications}.ts`.

### Step 8 — Devices, categories, category rules

**Assumes**

- Step 7: `users` exists; ADR-0006 ids are `text`. Check:
  `grep -q "text('id')" apps/api/src/schema/users.ts && echo ok`

**Read first**

- https://orm.drizzle.team/docs/column-types — `vector`.
- https://orm.drizzle.team/docs/indexes-constraints — `uniqueIndex`, `check`,
  composite `primaryKey`.
- ADR-0005 (devices revoked, not deleted), ADR-0002 (embedding columns
  suspended), ADR-0004 (productivity read live from category).

**Do**

Three ctrluhr-owned tables.

`devices`: carries `status` (`'active' | 'revoked'`, default `'active'`) and
no `api_token_hash` — the hash was dropped in the pre-phase-1 batch (ADR-0005:
rotation = revoke + re-enroll, so the hash dance is dead). Still don't build UI
that deletes a Device row — the cascade would take its whole event history.

`categories`: this is the first table using pgvector — `vector` imports from
`drizzle-orm/pg-core` (rc.4 includes it). `embedding` (vector 1536) exists but
its **server-side role is suspended** (ADR-0002: client-side encryption gates
phase 1, so server-side embedding matching is off the table until phase 2 is
re-designed). The `is_productive` domain check is a real constraint in the
repo.

`category_rules`: the composite primary key is `(category_id, pattern_type,
pattern)` — the same pattern may exist under both matcher types — and there IS
a `priority` column (default 0, "ordering room for phase 2" per `00` §4). The
older doc claimed "deliberately no priority"; the repo has it. Rule evaluation
order itself is unchanged (CONTEXT.md: title regexes first, then app names,
first hit wins) — the `pattern_type` domain check enforces the two allowed
matcher types.

```ts
// apps/api/src/schema/devices.ts
import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { users } from './users';

export const devices = pgTable(
  'devices',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    os: text('os').notNull(), // 'linux' | 'windows' | 'darwin'
    status: text('status').notNull().default('active'), // 'active' | 'revoked' (ADR-0005)
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('devices_user_id_idx').on(t.userId)],
);
```

```ts
// apps/api/src/schema/categories.ts
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  vector,
} from 'drizzle-orm/pg-core';
import { users } from './users';

export const categories = pgTable(
  'categories',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color').notNull().default('#6b7280'),
    // -1 distracting, 0 neutral, 1 productive
    isProductive: integer('is_productive').notNull().default(0),
    // category centroid; vector(1536) matches text-embedding-3-small.
    // Server-side role suspended (ADR-0002); column kept, nothing reads it yet.
    embedding: vector('embedding', { dimensions: 1536 }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('categories_user_name_uniq').on(t.userId, t.name),
    index('categories_user_id_idx').on(t.userId),
    check('categories_is_productive_domain', sql`${t.isProductive} IN (-1, 0, 1)`),
  ],
);
```

```ts
// apps/api/src/schema/category-rules.ts
import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import { categories } from './categories';

export const categoryRules = pgTable(
  'category_rules',
  {
    categoryId: text('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
    patternType: text('pattern_type').notNull(), // 'app_name' | 'title_regex'
    pattern: text('pattern').notNull(),
    priority: integer('priority').default(0),
  },
  (t) => [
    // patternType is part of the key so the same pattern can exist under both
    // matcher types (app_name + title_regex) for the same category.
    primaryKey({ columns: [t.categoryId, t.patternType, t.pattern] }),
    index('category_rules_category_idx').on(t.categoryId),
    check(
      'category_rules_pattern_type_domain',
      sql`${t.patternType} IN ('app_name', 'title_regex')`,
    ),
  ],
);
```

**Verify**

```sh
for f in devices categories category-rules; do
  test -f apps/api/src/schema/$f.ts || echo "missing $f"
done
grep -q "vector" apps/api/src/schema/categories.ts && echo ok
pnpm --filter @ctrluhr/api typecheck   # exit 0
```

**Produces**

- `apps/api/src/schema/{devices,categories,category-rules}.ts`.

### Step 9 — Activity events, habits, habit check-ins

**Assumes**

- Step 8: `devices`, `categories` exist. Check:
  `test -f apps/api/src/schema/devices.ts && test -f apps/api/src/schema/categories.ts && echo ok`

**Read first**

- https://orm.drizzle.team/docs/column-types — `date` vs timestamp.
- ADR-0004 (productive is a live read, column pending drop), ADR-0003
  (habit_checkins.day is a User-local Day).

**Do**

`activity_events`: the workhorse. `productive` was dropped in the pre-phase-1
batch (ADR-0004 — productivity is read live from the category). `raw_embedding`
(vector 1536) exists; its server-side role is suspended (ADR-0002). There is
deliberately **no
`duration_sec` column**: Drizzle doesn't express generated columns cleanly, so
duration is computed at query time (`EXTRACT(EPOCH FROM ended_at -
started_at)`); a raw-SQL migration can re-add it later. No HNSW index on
`raw_embedding` yet — adding it on an empty table is instant, adding it later
on a big one needs `CONCURRENTLY`; revisit when phase 2 is designed.

`habits`: includes `cadence` (text, default 'daily') — a column the older docs
never mentioned. Only 'daily' is meaningful in phases 0–3 (00 §4).

`habit_checkins`: `day` is a bare `date`, and per ADR-0003 it is a **User-local
Day** — bucketing happens in the User's timezone, never UTC. The unique index
is on `(habit_id, day)`.

```ts
// apps/api/src/schema/activity-events.ts
import { index, integer, pgTable, text, timestamp, vector } from 'drizzle-orm/pg-core';
import { categories } from './categories';
import { devices } from './devices';
import { users } from './users';

export const activityEvents = pgTable(
  'activity_events',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deviceId: text('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    appName: text('app_name').notNull(),
    windowTitle: text('window_title').notNull(),
    categoryId: text('category_id').references(() => categories.id),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }).notNull(),
    // Cached embedding of (app || '' || window_title). Server-side role
    // suspended (ADR-0002); column kept, nothing reads it yet.
    rawEmbedding: vector('raw_embedding', { dimensions: 1536 }),
  },
  (t) => [
    index('activity_events_user_started_idx').on(t.userId, t.startedAt),
    index('activity_events_user_cat_idx').on(t.userId, t.categoryId, t.startedAt),
  ],
);
```

```ts
// apps/api/src/schema/habits.ts
import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { categories } from './categories';
import { users } from './users';

export const habits = pgTable('habits', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  targetMinutesPerDay: integer('target_minutes_per_day').notNull().default(60),
  color: text('color').notNull().default('#22c55e'),
  cadence: text('cadence').notNull().default('daily'),
  linkedCategoryId: text('linked_category_id').references(() => categories.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
```

```ts
// apps/api/src/schema/habit-checkins.ts
import { boolean, date, integer, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { habits } from './habits';
import { users } from './users';

export const habitCheckins = pgTable(
  'habit_checkins',
  {
    id: text('id').primaryKey(),
    habitId: text('habit_id')
      .notNull()
      .references(() => habits.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    day: date('day').notNull(), // a User-local Day (ADR-0003)
    minutesActual: integer('minutes_actual').notNull().default(0),
    achieved: boolean('achieved').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('habit_checkins_habit_day_uniq').on(t.habitId, t.day)],
);
```

**Verify**

```sh
for f in activity-events habits habit-checkins; do
  test -f apps/api/src/schema/$f.ts || echo "missing $f"
done
# all 9 tables have text primary keys; no uuid defaults anywhere:
! rg -q "defaultRandom|gen_random_uuid" apps/api/src/schema && echo ok
# schema files count (9 tables + barrel):
test "$(ls apps/api/src/schema | wc -l)" -eq 10 && echo ok
pnpm --filter @ctrluhr/api typecheck   # exit 0
```

**Pitfalls**

- During the ADR-0006 migration (`20260730232745_faulty_vulture`), the column
  type changes could not be applied in one transaction while FKs referenced the
  old types: Postgres refuses `ALTER COLUMN ... TYPE` on a column an FK points
  at with the old type, even with `CASCADE`. The migration therefore drops every
  affected FK first, does the type changes, then re-adds them. If you ever
  hand-edit that kind of migration, keep the drop → alter → re-add order.

**Produces**

- `apps/api/src/schema/{activity-events,habits,habit-checkins}.ts`.

## 4. `drizzle.config.ts`

### Step 10 — Write the Drizzle config

**Assumes**

- Step 7–9: all 9 schema files + barrel exist. Check:
  `test -f apps/api/src/schema/index.ts && echo ok`
- Step 1: `DB_URL` in `.env`.

**Read first**

- https://orm.drizzle.team/docs/drizzle-config-file — every key in the file.

**Do**

In `apps/api/`, a config that tells drizzle-kit where the schema lives, where
migrations go, and how to reach the DB. It reads **`DB_URL`** (Step 1) — not
`DATABASE_URL`. `schemaFilter: 'public'`, `verbose` and `strict` match the
repo.

**Reference** (REFERENCE ONLY)

```ts
// apps/api/drizzle.config.ts
import {defineConfig} from 'drizzle-kit';

export default defineConfig({
    schema: './src/schema/index.ts',
    out: './migrations',
    dialect: 'postgresql',
    dbCredentials: {
        url: process.env.DB_URL!,
    },
    schemaFilter: 'public',
    verbose: true,
    strict: true,
});
```

**Verify**

```sh
grep -q "DB_URL" apps/api/drizzle.config.ts && grep -q "schema: './src/schema/index.ts'" apps/api/drizzle.config.ts && echo ok
# schema ↔ migrations are consistent (no drift):
pnpm --filter @ctrluhr/api exec drizzle-kit generate --explain
# in sync → prints nothing after the config line; drifted → prints the planned SQL
```

`generate --explain` is the no-DB drift detector: it diffs the schema against
the last committed snapshot and dry-runs the statements that would be emitted
(the same ones `generate` writes to a folder). No output = schema and snapshots
agree. (Don't use `drizzle-kit check` for this — in rc.4 it only validates the
migration folders' commutativity/conflicts, and it reports "Everything's fine"
even while the schema and snapshots disagree.)

**Produces**

- `apps/api/drizzle.config.ts`.

## 5. Generate and apply the first migration

### Step 11 — Generate the migration

**Assumes**

- Step 10: config reads `apps/api/src/schema/index.ts`. Check:
  `pnpm --filter @ctrluhr/api exec drizzle-kit generate --explain` (prints
  nothing when schema and snapshots agree — see Step 10)

**Read first**

- https://orm.drizzle.team/docs/drizzle-kit-generate — what the CLI emits.
- https://orm.drizzle.team/docs/drizzle-kit-migrate — how it applies.

**Do**

From `apps/api/`:

```sh
pnpm exec drizzle-kit generate
```

rc.4 emits **one folder per migration** — `migrations/<timestamp>_<name>/`
containing `migration.sql` and `snapshot.json` (not the old
`0000_<timestamp>_<hash>.sql` single-file layout; there is no `meta/journal`).
Open the SQL and read every line — it is the first thing to check when the DB
misbehaves later. Look for:

- `CREATE TABLE` for all 9 tables, ids as `text` (no `gen_random_uuid`).
- `CREATE INDEX` / `UNIQUE INDEX` statements at the bottom.
- The `CREATE EXTENSION IF NOT EXISTS vector;` guard at the top (Step 3).

**The repo's migration history** (this phase is built): three folders exist —
`20260730230020_initial_schema` (the original full schema, which started life
with `uuid` ids and a `verifications.token`/`type` pair),
`20260730232745_faulty_vulture` (the ADR-0006 alignment: every PK/FK
`uuid → text`, `users.image` added, `verifications` dead columns dropped,
`identifier`/`value` tightened to NOT NULL), and the pre-phase-1 batch
(`20260805220511_pre_phase1_schema_batch`: adds `enrollment_tokens` and
`devices.status`, drops `devices.api_token_hash` and `activity_events.productive`,
adds `users.timezone`). A fresh build from this corrected
doc writes `text` ids from the start, so `generate` produces a single initial
migration; the later folders exist only because the schema was built, drifted,
and repaired in production order. Either way the *end state* is the same schema
above.

**Verify**

```sh
ls apps/api/migrations
# three folders:
#   20260730230020_initial_schema
#   20260730232745_faulty_vulture
#   20260805220511_pre_phase1_schema_batch
git ls-files apps/api/migrations | wc -l   # → 6 (3 × migration.sql + snapshot.json)
pnpm --filter @ctrluhr/api exec drizzle-kit generate --explain   # prints nothing → schema and snapshots agree
```

**Produces**

- `apps/api/migrations/<name>/migration.sql` + `snapshot.json`, committed.

### Step 12 — Apply the migration

**Assumes**

- Step 11: at least one migration folder exists. Check:
  `test -n "$(ls apps/api/migrations | head -1)" && echo ok`

**Read first**

- https://orm.drizzle.team/docs/drizzle-kit-migrate — reads the folders, fetches
  applied history from the DB, applies only the new ones.
- https://orm.drizzle.team/docs/drizzle-kit-push — the dev alternative that
  diffs schema directly against the DB without writing migration files.

**Do**

drizzle-kit does **not** auto-load `.env`. Load `DB_URL` into the shell, then
from `apps/api/`:

```sh
set -a; . ./.env; set +a
pnpm exec drizzle-kit migrate
```

This reads the migration folders, compares against `drizzle.__drizzle_migrations`
in the DB, and applies only what hasn't run. `drizzle-kit push` is the rapid
iteration path (schema straight to DB, no migration files) — fine while the DB
is empty, but this repo's committed-migrations flow is `generate` + `migrate`.
(`drizzle-kit up` is unrelated — it upgrades snapshot *formats*, not a DB.)

**Verify**

```sh
set -a; . ./.env; set +a
pnpm exec drizzle-kit migrate
# → "done!", applying nothing new (both migrations already applied)
```

**Pitfalls**

- `drizzle-kit migrate` errors with `DATABASE_URL is required`-style messages
  when `DB_URL` isn't in the environment. drizzle-kit never reads `.env` for
  you; the `set -a; . ./.env; set +a` line (or exporting `DB_URL`) is required
  before every `migrate`/`push`/`studio` run.

**Produces**

- All 9 tables in the Neon database.

## 6. Verify with SQL

### Step 13 — Query the tables

**Assumes**

- Step 12: migrations applied. Check (against the live DB):
  `DB_URL="$(grep '^DB_URL=' apps/api/.env | cut -d'"' -f2)" psql "$DB_URL" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';"`

**Read first**

None — read-only SQL against your own DB.

**Do**

Connect (or use the Neon dashboard's SQL editor) and run:

```sql
SELECT table_name FROM information_schema.tables
  WHERE table_schema = 'public' ORDER BY table_name;
SELECT count(*) FROM users;                          -- 0 (empty DB)
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
  WHERE table_name = 'activity_events' ORDER BY ordinal_position;
SELECT * FROM pg_extension WHERE extname = 'vector';
```

You should see all 9 tables (`activity_events`, `categories`, `category_rules`,
`devices`, `habit_checkins`, `habits`, `sessions`, `users`, `verifications`),
`activity_events` columns including `raw_embedding` of type `vector(1536)`
(`information_schema` reports it as `USER-DEFINED`), and one row for `vector`
in `pg_extension`.

**Verify**

```sh
DB_URL="$(grep '^DB_URL=' apps/api/.env | cut -d'"' -f2)"
psql "$DB_URL" -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('users','sessions','verifications','devices','categories','category_rules','activity_events','habits','habit_checkins');"
# → 9
psql "$DB_URL" -tAc "SELECT extname FROM pg_extension WHERE extname='vector';"
# → vector
```

**Produces**

- Verified, queryable schema in Neon — the entry checkpoint for
  `03-api-setup.md`.

## 7. Commit

### Step 14 — Commit `[commit]`

**Assumes**

- Steps 1–13 done: schema, config, migrations all present; tables queryable.

**Do**

```sh
git add apps/api/src/schema apps/api/drizzle.config.ts apps/api/migrations apps/api/.env.example apps/api/package.json apps/api/tsconfig.json
git commit -m "feat(db): drizzle schema + initial migration for all tables"
```

`apps/api/.env` stays out (gitignored in Step 2).

**Verify**

```sh
git status --porcelain | grep -v '^??' | wc -l   # nothing staged/left behind (untracked aside)
git log --oneline -1 | head -1
```

**Produces**

- One commit: `feat(db): drizzle schema + initial migration for all tables`.

Next file: `03-api-setup.md` — Hono server bootstrap, better-auth magic link
flow, device enrollment, `/events` ingest route, `/analytics/day` route.

## Adjudication list

One line per doc↔code disagreement, with a recommendation. These are your calls:

1. **`devices.api_token_hash` still in the schema, `devices.status` not yet
   created** — ADR-0005 schedules dropping the hash and adding
   `status text NOT NULL DEFAULT 'active'`; both marked `[pending]` in Step 8.
   Recommendation: code-fix ticket in the pre-phase-1 migration batch (which
   also creates `enrollment_tokens`; see 03 §6). *(Resolved — applied by
   `20260805220511_pre_phase1_schema_batch`.)*
2. **`users.timezone` not yet added** — ADR-0003 (User-local Day) schedules it;
   `00` §4 marks it `[pending]` (Step 7). Recommendation: code-fix ticket to
   add `timezone` (default `'UTC'`) in the same pre-phase-1 batch.
   *(Resolved — applied by the same batch.)*
3. **`activity_events.productive` (and the suspended embedding columns) still
   exist** — ADR-0004/ADR-0002 suspend them; the drop is `[pending]` (Step 9).
   Recommendation: doc wording only here (nothing reads or writes them); the
   drops are code-fix tickets before phase 1. *(Resolved — `productive` dropped
   by the same batch; the embedding columns stay by ADR-0002.)*
4. **`DATABASE_URL` vs `DB_URL`** — the repo and this doc standardised on
   `DB_URL`; the older name survives only in ADR-0006-era commits and older
   docs (Step 1). Recommendation: resolved — no code-fix item; any snippet
   saying `DATABASE_URL` is stale.
                                                                                