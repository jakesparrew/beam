CREATE TYPE "public"."bookings_cancel_reason_code" AS ENUM('customer', 'staff', 'session_cancelled', 'payment_expired', 'order_cancelled', 'refunded', 'rescheduled', 'erased', 'duplicate');--> statement-breakpoint
CREATE TYPE "public"."capacity_holds_kind" AS ENUM('staff', 'partner', 'host', 'speaker', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."session_exceptions_kind" AS ENUM('closed', 'holiday', 'special_hours');--> statement-breakpoint
CREATE TYPE "public"."session_templates_credit_kind" AS ENUM('day', 'night');--> statement-breakpoint
CREATE TYPE "public"."session_templates_kind" AS ENUM('day', 'night', 'event');--> statement-breakpoint
CREATE TYPE "public"."sessions_event_category" AS ENUM('lecture', 'concert', 'member_event', 'experience', 'webinar', 'special_activity', 'partner_event');--> statement-breakpoint
CREATE TYPE "public"."sessions_lead_release_rule" AS ENUM('customers_then_public', 'public', 'keep_for_leads');--> statement-breakpoint
CREATE TYPE "public"."waitlist_entries_queue" AS ENUM('lead', 'customer', 'public');--> statement-breakpoint
CREATE TYPE "public"."waitlist_entries_state" AS ENUM('waiting', 'offered', 'confirmed', 'released', 'expired', 'withdrawn');--> statement-breakpoint
CREATE TABLE "capacity_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"kind" "capacity_holds_kind" NOT NULL,
	"quantity" integer NOT NULL,
	"company_id" uuid,
	"note" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capacity_holds_quantity_ck" CHECK ("capacity_holds"."quantity" > 0),
	CONSTRAINT "capacity_holds_partner_company_ck" CHECK ("capacity_holds"."kind" <> 'partner' or "capacity_holds"."company_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "session_exceptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"on_date" date NOT NULL,
	"kind" "session_exceptions_kind" NOT NULL,
	"template_ids" uuid[],
	"opens_at" time,
	"closes_at" time,
	"name" jsonb NOT NULL,
	"note" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_exceptions_special_hours_ck" CHECK (("session_exceptions"."kind" = 'special_hours') = ("session_exceptions"."opens_at" is not null and "session_exceptions"."closes_at" is not null)),
	CONSTRAINT "session_exceptions_hours_order_ck" CHECK ("session_exceptions"."closes_at" is null or "session_exceptions"."opens_at" is null or "session_exceptions"."closes_at" > "session_exceptions"."opens_at")
);
--> statement-breakpoint
CREATE TABLE "session_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "session_templates_kind" NOT NULL,
	"name" jsonb NOT NULL,
	"description" jsonb,
	"weekdays" smallint[] NOT NULL,
	"start_time" time NOT NULL,
	"duration_minutes" integer NOT NULL,
	"capacity_seats" integer,
	"capacity_beds" integer,
	"credit_kind" "session_templates_credit_kind",
	"credit_cost" smallint DEFAULT 1 NOT NULL,
	"product_id" uuid,
	"is_member_only" boolean DEFAULT false NOT NULL,
	"location" text,
	"active_from_on" date NOT NULL,
	"active_to_on" date,
	"is_active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_templates_weekdays_ck" CHECK ("session_templates"."weekdays" <@ '{1,2,3,4,5,6,7}'::smallint[] and cardinality("session_templates"."weekdays") >= 1),
	CONSTRAINT "session_templates_duration_ck" CHECK ("session_templates"."duration_minutes" between 15 and 1440),
	CONSTRAINT "session_templates_capacity_seats_ck" CHECK ("session_templates"."capacity_seats" >= 0),
	CONSTRAINT "session_templates_capacity_beds_ck" CHECK ("session_templates"."capacity_beds" >= 0),
	CONSTRAINT "session_templates_credit_cost_ck" CHECK ("session_templates"."credit_cost" between 0 and 10),
	CONSTRAINT "session_templates_active_range_ck" CHECK ("session_templates"."active_to_on" is null or "session_templates"."active_to_on" >= "session_templates"."active_from_on"),
	CONSTRAINT "session_templates_night_beds_ck" CHECK (("session_templates"."kind" = 'night') = ("session_templates"."capacity_beds" is not null)),
	CONSTRAINT "session_templates_seats_ck" CHECK ("session_templates"."kind" = 'night' or "session_templates"."capacity_seats" is not null),
	CONSTRAINT "session_templates_credit_kind_ck" CHECK ("session_templates"."kind" = 'event' or "session_templates"."credit_kind" is not null)
);
--> statement-breakpoint
CREATE TABLE "ticket_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"name" jsonb NOT NULL,
	"capacity" integer,
	"is_member_only" boolean DEFAULT false NOT NULL,
	"sales_start_at" timestamp with time zone,
	"sales_end_at" timestamp with time zone,
	"max_per_booking" smallint DEFAULT 4 NOT NULL,
	"requires_guest_details" boolean DEFAULT true NOT NULL,
	"sort_order" smallint DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_types_capacity_ck" CHECK ("ticket_types"."capacity" > 0),
	CONSTRAINT "ticket_types_sales_window_ck" CHECK ("ticket_types"."sales_end_at" is null or "ticket_types"."sales_start_at" is null or "ticket_types"."sales_end_at" > "ticket_types"."sales_start_at"),
	CONSTRAINT "ticket_types_max_per_booking_ck" CHECK ("ticket_types"."max_per_booking" >= 1)
);
--> statement-breakpoint
CREATE TABLE "waitlist_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"queue" "waitlist_entries_queue" DEFAULT 'public' NOT NULL,
	"state" "waitlist_entries_state" DEFAULT 'waiting' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"offered_at" timestamp with time zone,
	"offer_expires_at" timestamp with time zone,
	"offers_count" smallint DEFAULT 0 NOT NULL,
	"rejoin_count" smallint DEFAULT 0 NOT NULL,
	"claim_token_hash" text,
	"booking_id" uuid,
	"is_flagged_duplicate" boolean DEFAULT false NOT NULL,
	"flag_reason" text,
	"flag_reviewed_by_user_id" uuid,
	"flag_reviewed_at" timestamp with time zone,
	"email_normalised" text,
	"join_ip_hash" text,
	"ended_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "waitlist_entries_offered_ck" CHECK ("waitlist_entries"."state" <> 'offered' or "waitlist_entries"."offer_expires_at" is not null),
	CONSTRAINT "waitlist_entries_confirmed_ck" CHECK ("waitlist_entries"."state" <> 'confirmed' or "waitlist_entries"."booking_id" is not null),
	CONSTRAINT "waitlist_entries_offers_count_ck" CHECK ("waitlist_entries"."offers_count" between 0 and 5),
	CONSTRAINT "waitlist_entries_rejoin_count_ck" CHECK ("waitlist_entries"."rejoin_count" between 0 and 1),
	CONSTRAINT "waitlist_entries_ended_reason_ck" CHECK ("waitlist_entries"."ended_reason" is null or "waitlist_entries"."ended_reason" in ('declined', 'session_started', 'session_cancelled', 'staff', 'booked_directly', 'offer_timeout', 'payment_not_completed', 'flag_withdrawn', 'customer'))
);
--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "capacity_units" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "capacity_hold_id" uuid;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "used_lead_seat" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "is_over_capacity" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "is_pay_at_desk" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "booked_by_person_id" uuid;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "external_ref" text;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "rescheduled_from_booking_id" uuid;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "checkin_code" text NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "qr_file_id" uuid;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "reminder_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "cancel_reason_code" "bookings_cancel_reason_code";--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "no_show_marked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "template_version" integer;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "description" jsonb;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "product_id" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "event_category" "sessions_event_category";--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "partner_company_id" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "has_manual_changes" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "lead_release_rule" "sessions_lead_release_rule" DEFAULT 'customers_then_public' NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "public_release_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "is_waitlist_position_visible" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "cancel_reason" text;--> statement-breakpoint
ALTER TABLE "capacity_holds" ADD CONSTRAINT "capacity_holds_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capacity_holds" ADD CONSTRAINT "capacity_holds_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_exceptions" ADD CONSTRAINT "session_exceptions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_templates" ADD CONSTRAINT "session_templates_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_templates" ADD CONSTRAINT "session_templates_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_types" ADD CONSTRAINT "ticket_types_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_types" ADD CONSTRAINT "ticket_types_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_flag_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("flag_reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "capacity_holds_session_idx" ON "capacity_holds" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "capacity_holds_company_idx" ON "capacity_holds" USING btree ("company_id") WHERE "capacity_holds"."company_id" is not null;--> statement-breakpoint
CREATE INDEX "session_exceptions_on_date_idx" ON "session_exceptions" USING btree ("on_date");--> statement-breakpoint
CREATE INDEX "session_templates_active_kind_idx" ON "session_templates" USING btree ("is_active","kind");--> statement-breakpoint
CREATE INDEX "ticket_types_session_sort_idx" ON "ticket_types" USING btree ("session_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "waitlist_entries_session_person_uq" ON "waitlist_entries" USING btree ("session_id","person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "waitlist_entries_claim_token_uq" ON "waitlist_entries" USING btree ("claim_token_hash") WHERE "waitlist_entries"."claim_token_hash" is not null;--> statement-breakpoint
CREATE INDEX "waitlist_entries_queue_idx" ON "waitlist_entries" USING btree ("session_id","state","queue","joined_at");--> statement-breakpoint
CREATE INDEX "waitlist_entries_offer_expiry_idx" ON "waitlist_entries" USING btree ("offer_expires_at") WHERE "waitlist_entries"."state" = 'offered';--> statement-breakpoint
CREATE INDEX "waitlist_entries_session_email_idx" ON "waitlist_entries" USING btree ("session_id","email_normalised");--> statement-breakpoint
CREATE INDEX "waitlist_entries_person_idx" ON "waitlist_entries" USING btree ("person_id");--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_ticket_type_id_ticket_types_id_fk" FOREIGN KEY ("ticket_type_id") REFERENCES "public"."ticket_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_capacity_hold_id_capacity_holds_id_fk" FOREIGN KEY ("capacity_hold_id") REFERENCES "public"."capacity_holds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_booked_by_person_id_persons_id_fk" FOREIGN KEY ("booked_by_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_rescheduled_from_booking_id_bookings_id_fk" FOREIGN KEY ("rescheduled_from_booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_qr_file_id_files_id_fk" FOREIGN KEY ("qr_file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_template_id_session_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."session_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bookings_checkin_code_uq" ON "bookings" USING btree ("checkin_code");--> statement-breakpoint
CREATE UNIQUE INDEX "bookings_external_ref_uq" ON "bookings" USING btree ("external_ref") WHERE "bookings"."external_ref" is not null;--> statement-breakpoint
CREATE INDEX "bookings_rescheduled_from_idx" ON "bookings" USING btree ("rescheduled_from_booking_id") WHERE "bookings"."rescheduled_from_booking_id" is not null;--> statement-breakpoint
CREATE INDEX "bookings_capacity_hold_idx" ON "bookings" USING btree ("capacity_hold_id") WHERE "bookings"."capacity_hold_id" is not null;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_capacity_units_ck" CHECK ("bookings"."capacity_units" between 0 and 1);--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_order_line_ck" CHECK ("bookings"."paid_with" <> 'order' or "bookings"."order_line_id" is not null or "bookings"."status" = 'reserved');--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_cancelled_ck" CHECK ("bookings"."status" not in ('cancelled', 'late_cancelled') or ("bookings"."cancelled_at" is not null and "bookings"."cancel_reason_code" is not null));--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_pay_at_desk_ck" CHECK (not "bookings"."is_pay_at_desk" or "bookings"."paid_with" = 'order');--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_capacity_seats_ck" CHECK ("sessions"."capacity_seats" >= 0);--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_capacity_beds_ck" CHECK ("sessions"."capacity_beds" >= 0);--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_night_beds_ck" CHECK (("sessions"."kind" = 'night') = ("sessions"."capacity_beds" is not null));--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_seats_ck" CHECK ("sessions"."kind" = 'night' or "sessions"."capacity_seats" is not null);--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_credit_cost_ck" CHECK ("sessions"."credit_cost" between 0 and 10);--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_cancelled_at_ck" CHECK (("sessions"."status" = 'cancelled') = ("sessions"."cancelled_at" is not null));--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_event_category_ck" CHECK ("sessions"."kind" = 'event' or "sessions"."event_category" is null);