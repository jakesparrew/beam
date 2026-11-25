CREATE TYPE "public"."bookings_age_group" AS ENUM('child', 'youth');--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "age_group" "bookings_age_group";--> statement-breakpoint
ALTER TABLE "checkouts" ADD COLUMN "first_name" text;--> statement-breakpoint
ALTER TABLE "checkouts" ADD COLUMN "last_name" text;--> statement-breakpoint
ALTER TABLE "checkouts" ADD COLUMN "phone" text;