ALTER TYPE "public"."files_kind" ADD VALUE 'material';--> statement-breakpoint
ALTER TYPE "public"."integration_calls_provider" ADD VALUE 'webinargeek';--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "webinar_geek_watch_url" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "image_file_id" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "webinar_geek_url" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "webinar_geek_broadcast_id" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "material_file_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "materials_released_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_image_file_id_files_id_fk" FOREIGN KEY ("image_file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_webinar_geek_url_ck" CHECK ("sessions"."webinar_geek_url" like 'https://%' and length("sessions"."webinar_geek_url") <= 2000);--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_webinar_geek_broadcast_ck" CHECK ("sessions"."webinar_geek_broadcast_id" ~ '^[0-9]{1,20}$');