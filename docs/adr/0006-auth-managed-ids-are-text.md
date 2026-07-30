# Auth-managed id columns are text, not uuid

The build docs (`docs/02-database-setup.md` §3, the schema examples throughout
`docs/03-api-setup.md`, and the spec block in `docs/00-plan-overview.md` §3)
declared every primary key as `uuid` with `gen_random_uuid()`. better-auth's
CLI-generated schema (`pnpm dlx auth@latest generate --config src/auth.ts
--output src/schema`) declares every id it owns — `users.id`, `sessions.id`,
`verifications.id`, and the future `account.id` — as `text`. The §3.5
schema-sync step was skipped, so the drift went undetected until the
magic-link smoke test failed at the database with
`22P02 invalid input syntax for type uuid: <32-char hex>`. Decision:
**`users.id`, `sessions.id`, `verifications.id` are `text` primary keys (no
server-side default — better-auth supplies the value), and every foreign
key that targets them — `*.user_id`, `*.device_id`, `*.category_id`,
`habit_checkins.habit_id`, `habits.linked_category_id`,
`activity_events.device_id` — is also `text`.** The `account` table from
better-auth's generated schema is deferred to phase 1+; magic-link doesn't
read or write it, so creating it now would carry unused columns. It lands
when OAuth does.

Why align the schema to the library rather than override
`advanced.database.generateId` to emit a UUID and keep `uuid` columns:
`text` ids are better-auth's documented contract for every table it owns,
including future plugin tables. Forcing UUIDs is a per-instance hook that
has to be remembered each time a new auth-touching table or plugin is
added, and it would also paper over the unrelated drift the §3.5 sync
surfaced (missing `users.image`, un-`notNull` `verifications.identifier`
and `verifications.value`, dead `verifications.token` and
`verifications.type` columns left over from an earlier doc draft). One
move fixes everything.

## Consequences

- New migration: `ALTER TABLE … ALTER COLUMN … TYPE text USING <col>::text`
  on every column listed above; `ADD COLUMN users.image text`; tighten
  `verifications.identifier` and `verifications.value` to `NOT NULL`;
  `DROP COLUMN verifications.token` and `verifications.type`. All
  `apps/api/src/schema/*.ts` files change in the same commit (PKs lose
  the `defaultRandom()` call).
- Build docs that pinned `uuid + gen_random_uuid()` are now stale:
  `docs/02-database-setup.md` §3, every schema snippet in
  `docs/03-api-setup.md`, and `docs/00-plan-overview.md` §3. Corrected
  the next time each is touched; the decision lives here so the next
  reader doesn't see a contradiction between docs and code.
- `apps/api/test-resend.ts` (the magic-link smoke test) is now the
  regression test for "auth ↔ schema in sync." The recipient is read
  from `SMOKE_TEST_EMAIL` in `apps/api/.env` (placeholder in
  `.env.example`) so the file stays committable. The §3.5 schema-sync
  step in `docs/03-api-setup.md` is no longer optional — it's the
  mechanism that catches the next round of drift before it hits the
  database.
- Side fix: the `pnpm exec auth@latest generate` command at
  `docs/03-api-setup.md:259` was wrong for pnpm (`pnpm exec` resolves a
  local package; the CLI is downloaded on demand). Corrected to
  `pnpm dlx auth@latest generate` (or `npx …`) in the same commit.
- The `apps/api/src/schema/auth-schema.ts` file dropped by the CLI is a
  throwaway reference. It's not re-exported from `index.ts` and was
  deleted in the same commit once the migration applied — keep
  regenerating it for diffs, but don't keep it in the tree.
