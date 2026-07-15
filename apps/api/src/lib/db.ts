import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';

// import * as schema from '../schema'

// [TODO] we should instead of doing the following non null assertion
// use type narrowing
const connectionString = process.env.DB_URL!;

const sql = neon(connectionString);
// export const db = drizzle(sql, {schema})
// export type DB = typeof db
