// [TODO] look into using better auth minimal
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { betterAuth } from 'better-auth';
import { magicLink } from 'better-auth/plugins';
import { Resend } from 'resend';
import { db } from './lib/db';

const resend = new Resend(process.env.RESEND_API_KEY!)

export const auth = betterAuth({
  emailAndPassword: { enabled: false },
  plugins: [
    magicLink({
      sendMagicLink: async ({ email, token, url, metadata }, ctx) => {
        const from = process.env.RESEND_FROM_EMAIL!
        resend.emails.send({
          from,
          to: email,
          subject: 'Sign in to ctrluhr',
          html: `<a href="${url}">Click here to sign in</a>`,
        })
      },
    }),
  ],
  database: drizzleAdapter(db, {
    provider: 'pg',
  }),
});

export type Auth = typeof auth;

// FIXME(better-auth): the table/column names below diverge from better-auth's
// default contract (plural `users`/`sessions`/`verifications`, `email_verified`
// boolean, `user_id`/`token`/`type` columns). `drizzleAdapter` must be given an
// explicit `schema` map so the adapter resolves the right tables/columns, or
// the source schema must be regenerated via `npx @better-auth/cli generate`.
// Tracked in a GitHub issue — see PR #1 review (CodeRabbit comment re:
// snapshot.json L45-61).
