import { integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { categories } from './categories';
import { users } from './users';

export const habits = pgTable('habits', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  targetMinutesPerDay: integer('target_minutes_per_day').notNull().default(60),
  color: text('color').notNull().default('#22c55e'),
  cadence: text('cadence').notNull().default('daily'),
  linkedCategoryId: uuid('linked_category_id').references(() => categories.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
