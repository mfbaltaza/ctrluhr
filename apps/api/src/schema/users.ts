import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

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
