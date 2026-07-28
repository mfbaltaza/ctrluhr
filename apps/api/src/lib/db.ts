import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';

// [TODO] we should instead of doing the following non null assertion
// use type narrowing
const connectionString = process.env.DB_URL!;

const sql = neon(connectionString);
// NOTE: schema binding is intentionally omitted here. In drizzle-orm 1.0 the
// drizzle() constructor no longer accepts `schema`; better-auth's drizzleAdapter
// receives its schema map separately (see auth.ts — tracked in a follow-up issue).
export const db = drizzle({ client: sql });
export type DB = typeof db;
