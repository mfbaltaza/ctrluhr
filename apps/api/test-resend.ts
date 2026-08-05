import 'dotenv/config';
import { auth } from './src/auth';
import { db } from './src/lib/db';
import { verifications } from './src/schema';

const email = process.env.SMOKE_TEST_EMAIL;
if (!email) {
  throw new Error('SMOKE_TEST_EMAIL is not set. Add it to apps/api/.env (see .env.example).');
}

const before = await db.select().from(verifications);
const result = await auth.api.signInMagicLink({
  body: { email },
  headers: new Headers(),
  request: new Request('http://localhost:3000/auth/sign-in/magic-link', { method: 'POST' }),
  asResponse: false,
});
const after = await db.select().from(verifications);
console.log({
  status: result,
  rows: {
    before: before.length,
    after: after.length,
    latest: after.at(-1),
  },
});
