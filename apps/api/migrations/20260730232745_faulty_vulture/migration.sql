-- Path A per ADR-0006: auth-managed ids (and the FKs that target them) move
-- from uuid to text to match better-auth's generated shape. We have to drop
-- every affected FK, do the type changes, then re-add the FKs — Postgres
-- won't let a column change type while an FK references it with the old type,
-- even with CASCADE, and we can't wrap the whole migration in a single
-- transaction because Drizzle runs each statement in its own implicit tx.

-- 1) drop the FKs
ALTER TABLE "activity_events" DROP CONSTRAINT "activity_events_user_id_users_id_fkey";--> statement-breakpoint
ALTER TABLE "activity_events" DROP CONSTRAINT "activity_events_device_id_devices_id_fkey";--> statement-breakpoint
ALTER TABLE "activity_events" DROP CONSTRAINT "activity_events_category_id_categories_id_fkey";--> statement-breakpoint
ALTER TABLE "categories" DROP CONSTRAINT "categories_user_id_users_id_fkey";--> statement-breakpoint
ALTER TABLE "category_rules" DROP CONSTRAINT "category_rules_category_id_categories_id_fkey";--> statement-breakpoint
ALTER TABLE "devices" DROP CONSTRAINT "devices_user_id_users_id_fkey";--> statement-breakpoint
ALTER TABLE "habit_checkins" DROP CONSTRAINT "habit_checkins_habit_id_habits_id_fkey";--> statement-breakpoint
ALTER TABLE "habit_checkins" DROP CONSTRAINT "habit_checkins_user_id_users_id_fkey";--> statement-breakpoint
ALTER TABLE "habits" DROP CONSTRAINT "habits_user_id_users_id_fkey";--> statement-breakpoint
ALTER TABLE "habits" DROP CONSTRAINT "habits_linked_category_id_categories_id_fkey";--> statement-breakpoint
ALTER TABLE "sessions" DROP CONSTRAINT "sessions_user_id_users_id_fkey";--> statement-breakpoint
ALTER TABLE "verifications" DROP CONSTRAINT "verifications_user_id_users_id_fkey";--> statement-breakpoint

-- 2) type changes + user.image + dead verifications columns + NOT NULL on identifier/value
ALTER TABLE "users" ALTER COLUMN "id" SET DATA TYPE text USING "id"::text;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "image" text;--> statement-breakpoint
ALTER TABLE "categories" ALTER COLUMN "id" SET DATA TYPE text USING "id"::text;--> statement-breakpoint
ALTER TABLE "categories" ALTER COLUMN "id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "categories" ALTER COLUMN "user_id" SET DATA TYPE text USING "user_id"::text;--> statement-breakpoint
ALTER TABLE "category_rules" ALTER COLUMN "category_id" SET DATA TYPE text USING "category_id"::text;--> statement-breakpoint
ALTER TABLE "devices" ALTER COLUMN "id" SET DATA TYPE text USING "id"::text;--> statement-breakpoint
ALTER TABLE "devices" ALTER COLUMN "id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "devices" ALTER COLUMN "user_id" SET DATA TYPE text USING "user_id"::text;--> statement-breakpoint
ALTER TABLE "habits" ALTER COLUMN "id" SET DATA TYPE text USING "id"::text;--> statement-breakpoint
ALTER TABLE "habits" ALTER COLUMN "id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "habits" ALTER COLUMN "user_id" SET DATA TYPE text USING "user_id"::text;--> statement-breakpoint
ALTER TABLE "habits" ALTER COLUMN "linked_category_id" SET DATA TYPE text USING "linked_category_id"::text;--> statement-breakpoint
ALTER TABLE "habit_checkins" ALTER COLUMN "id" SET DATA TYPE text USING "id"::text;--> statement-breakpoint
ALTER TABLE "habit_checkins" ALTER COLUMN "id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "habit_checkins" ALTER COLUMN "habit_id" SET DATA TYPE text USING "habit_id"::text;--> statement-breakpoint
ALTER TABLE "habit_checkins" ALTER COLUMN "user_id" SET DATA TYPE text USING "user_id"::text;--> statement-breakpoint
ALTER TABLE "activity_events" ALTER COLUMN "id" SET DATA TYPE text USING "id"::text;--> statement-breakpoint
ALTER TABLE "activity_events" ALTER COLUMN "id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "activity_events" ALTER COLUMN "user_id" SET DATA TYPE text USING "user_id"::text;--> statement-breakpoint
ALTER TABLE "activity_events" ALTER COLUMN "device_id" SET DATA TYPE text USING "device_id"::text;--> statement-breakpoint
ALTER TABLE "activity_events" ALTER COLUMN "category_id" SET DATA TYPE text USING "category_id"::text;--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "id" SET DATA TYPE text USING "id"::text;--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "user_id" SET DATA TYPE text USING "user_id"::text;--> statement-breakpoint
ALTER TABLE "verifications" DROP COLUMN "token";--> statement-breakpoint
ALTER TABLE "verifications" DROP COLUMN "type";--> statement-breakpoint
ALTER TABLE "verifications" ALTER COLUMN "id" SET DATA TYPE text USING "id"::text;--> statement-breakpoint
ALTER TABLE "verifications" ALTER COLUMN "id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "verifications" ALTER COLUMN "user_id" SET DATA TYPE text USING "user_id"::text;--> statement-breakpoint
ALTER TABLE "verifications" ALTER COLUMN "identifier" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "verifications" ALTER COLUMN "value" SET NOT NULL;--> statement-breakpoint

-- 3) re-add the FKs (both sides now text, all valid; tables are empty so no row check)
ALTER TABLE "categories" ADD CONSTRAINT "categories_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "category_rules" ADD CONSTRAINT "category_rules_category_id_categories_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "habits" ADD CONSTRAINT "habits_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "habits" ADD CONSTRAINT "habits_linked_category_id_categories_id_fkey" FOREIGN KEY ("linked_category_id") REFERENCES "categories"("id");--> statement-breakpoint
ALTER TABLE "habit_checkins" ADD CONSTRAINT "habit_checkins_habit_id_habits_id_fkey" FOREIGN KEY ("habit_id") REFERENCES "habits"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "habit_checkins" ADD CONSTRAINT "habit_checkins_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_device_id_devices_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_category_id_categories_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id");--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "verifications" ADD CONSTRAINT "verifications_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
