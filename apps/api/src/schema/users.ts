import { boolean, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * better-auth's user table. We define it here so Drizzle manages migrations;
 * better-auth reads/writes via its own client (which uses our Drizzle pool).
 * `id` is `text` (not `uuid`) per better-auth's generated schema; see ADR-0006.
 */

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').default(false).notNull(),
  name: text('name'),
  image: text('image'),
  timezone: text('timezone').notNull().default('UTC'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
