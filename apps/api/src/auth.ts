// [TODO] look into using better auth minimal
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "./lib/db";
import { magicLink } from "better-auth/plugins";

export const auth = betterAuth({
    plugins: [
        magicLink({
            sendMagicLink: async ({email, token, url, metadata}, ctx) => {
                //send email to user
            }
        })
    ],
    database: drizzleAdapter(db, {
        provider: "pg"
    })
})