// [TODO] look into using better auth minimal
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { magicLink } from 'better-auth/plugins';
import { db } from './lib/db';

export const auth = betterAuth({
  plugins: [
    magicLink({
      sendMagicLink: async ({ email, token, url, metadata }, ctx) => {
        //send email to user
      },
    }),
  ],
  database: drizzleAdapter(db, {
    provider: 'pg',
  }),
});

// FIXME(better-auth): the table/column names below diverge from better-auth's
// default contract (plural `users`/`sessions`/`verifications`, `email_verified`
// boolean, `user_id`/`token`/`type` columns). `drizzleAdapter` must be given an
// explicit `schema` map so the adapter resolves the right tables/columns, or
// the source schema must be regenerated via `npx @better-auth/cli generate`.
// Tracked in a GitHub issue — see PR #1 review (CodeRabbit comment re:
// snapshot.json L45-61).
