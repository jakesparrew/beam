ALTER TABLE "orders" ADD COLUMN "utm" jsonb;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "is_booking_extra" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "booking_extra_kinds" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_booking_extra_chk" CHECK ((not "products"."is_booking_extra" or "products"."kind" = 'item') and "products"."booking_extra_kinds" <@ array['day', 'night', 'event']::text[]);