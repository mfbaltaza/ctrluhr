import { index, integer, pgTable, text, timestamp, uuid, vector } from 'drizzle-orm/pg-core';
import { categories } from './categories';
import { devices } from './devices';
import { users } from './users';

export const activityEvents = pgTable(
  'activity_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
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
  (t) => [
    index('activity_events_user_started_idx').on(t.userId, t.startedAt),
    index('activity_events_user_cat_idx').on(t.userId, t.categoryId, t.startedAt),
  ],
);
