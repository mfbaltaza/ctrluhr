// [TODO] look into using better auth minimal
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { betterAuth } from 'better-auth';
import { magicLink } from 'better-auth/plugins';
import { Resend } from 'resend';
import { db } from './lib/db';
import * as schema from './schema';

const resend = new Resend(process.env.RESEND_API_KEY!);

export const auth = betterAuth({
  emailAndPassword: { enabled: false },
  plugins: [
    magicLink({
      sendMagicLink: async ({ email, token, url, metadata }, ctx) => {
        const from = process.env.RESEND_FROM_EMAIL!;
        resend.emails.send({
          from,
          to: email,
          subject: 'Sign in to ctrluhr',
          html: `<a href="${url}">Click here to sign in</a>`,
        });
      },
    }),
  ],
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema: {
      user: schema.users,
      session: schema.sessions,
      verification: schema.verifications,
    },
  }),
});

export type Auth = typeof auth;
