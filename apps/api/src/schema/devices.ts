import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';

export const devices = pgTable(
  'devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    os: text('os').notNull(), // 'linux' | 'windows' | 'darwin'
    apiTokenHash: text('api_token_hash').notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('devices_user_id_idx').on(t.userId)],
);
