import { boolean, date, integer, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { habits } from './habits';
import { users } from './users';

export const habitCheckins = pgTable(
  'habit_checkins',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    habitId: uuid('habit_id')
      .notNull()
      .references(() => habits.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    day: date('day').notNull(),
    minutesActual: integer('minutes_actual').notNull().default(0),
    achieved: boolean('achieved').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('habit_checkins_habit_day_uniq').on(t.habitId, t.day)],
);
