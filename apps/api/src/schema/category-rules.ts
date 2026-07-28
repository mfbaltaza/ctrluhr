import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
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
