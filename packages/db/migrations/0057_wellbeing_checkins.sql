CREATE TYPE "public"."wellbeing_checkins_moment" AS ENUM('before', 'after', 'daily');--> statement-breakpoint
CREATE TABLE "wellbeing_checkins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"booking_id" uuid,
	"moment" "wellbeing_checkins_moment" NOT NULL,
	"on_date" date NOT NULL,
	"energy" smallint NOT NULL,
	"sleep" smallint,
	"calm" smallint NOT NULL,
	"mood" smallint NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wellbeing_checkins_scale_ck" CHECK ("wellbeing_checkins"."energy" between 1 and 5 and "wellbeing_checkins"."calm" between 1 and 5 and "wellbeing_checkins"."mood" between 1 and 5 and ("wellbeing_checkins"."sleep" is null or "wellbeing_checkins"."sleep" between 1 and 5)),
	CONSTRAINT "wellbeing_checkins_booking_ck" CHECK (("wellbeing_checkins"."moment" = 'daily') = ("wellbeing_checkins"."booking_id" is null)),
	CONSTRAINT "wellbeing_checkins_note_ck" CHECK ("wellbeing_checkins"."note" is null or char_length("wellbeing_checkins"."note") <= 500)
);
--> statement-breakpoint
ALTER TABLE "wellbeing_checkins" ADD CONSTRAINT "wellbeing_checkins_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wellbeing_checkins" ADD CONSTRAINT "wellbeing_checkins_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wellbeing_checkins_person_idx" ON "wellbeing_checkins" USING btree ("person_id","on_date");--> statement-breakpoint
CREATE UNIQUE INDEX "wellbeing_checkins_booking_moment_uq" ON "wellbeing_checkins" USING btree ("booking_id","moment") WHERE "wellbeing_checkins"."booking_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "wellbeing_checkins_daily_uq" ON "wellbeing_checkins" USING btree ("person_id","on_date") WHERE "wellbeing_checkins"."moment" = 'daily';