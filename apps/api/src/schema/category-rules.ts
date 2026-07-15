import { index, integer, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { categories } from './categories';

export const categoryRules = pgTable(
  'category_rules',
  {
    categoryId: uuid('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
    patternType: text('pattern_type').notNull(), // 'app_name' | 'title_regex'
    pattern: text('pattern').notNull(),
    priority: integer('priority').default(0),
  },
  (t) => [
    primaryKey({ columns: [t.categoryId, t.pattern] }),
    index('category_rules_category_idx').on(t.categoryId),
  ],
);
