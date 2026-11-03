CREATE TYPE "public"."automations_purpose" AS ENUM('newsletter', 'events', 'member_comms', 'b2b');--> statement-breakpoint
CREATE TYPE "public"."automations_status" AS ENUM('draft', 'active', 'paused', 'archived');--> statement-breakpoint
CREATE TYPE "public"."bookings_paid_with" AS ENUM('credit', 'order', 'guest', 'free');--> statement-breakpoint
CREATE TYPE "public"."bookings_source" AS ENUM('portal', 'admin', 'waitlist', 'import', 'pos', 'site');--> statement-breakpoint
CREATE TYPE "public"."bookings_status" AS ENUM('reserved', 'confirmed', 'cancelled', 'late_cancelled', 'no_show', 'attended');--> statement-breakpoint
CREATE TYPE "public"."sessions_credit_kind" AS ENUM('day', 'night');--> statement-breakpoint
CREATE TYPE "public"."sessions_kind" AS ENUM('day', 'night', 'event');--> statement-breakpoint
CREATE TYPE "public"."sessions_status" AS ENUM('open', 'closed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."orders_channel" AS ENUM('portal', 'site', 'admin', 'pos', 'link', 'recurring');--> statement-breakpoint
CREATE TYPE "public"."orders_status" AS ENUM('draft', 'pending_payment', 'paid', 'cancelled', 'expired', 'refunded', 'partially_refunded');--> statement-breakpoint
CREATE TYPE "public"."price_versions_audience" AS ENUM('public', 'member', 'b2b');--> statement-breakpoint
CREATE TYPE "public"."products_credit_kind" AS ENUM('day', 'night', 'euro');--> statement-breakpoint
CREATE TYPE "public"."products_kind" AS ENUM('session', 'night', 'package', 'membership', 'ticket', 'item', 'voucher');--> statement-breakpoint
CREATE TYPE "public"."products_recurring_interval" AS ENUM('month', 'year');--> statement-breakpoint
CREATE TYPE "public"."credit_entries_kind" AS ENUM('grant', 'consume', 'release', 'expire', 'extend', 'adjust', 'revoke', 'transfer_out', 'transfer_in');--> statement-breakpoint
CREATE TYPE "public"."credit_grants_credit_kind" AS ENUM('day', 'night', 'euro');--> statement-breakpoint
CREATE TYPE "public"."credit_grants_source" AS ENUM('purchase', 'voucher', 'membership', 'bonus', 'import', 'manual', 'referral', 'transfer');--> statement-breakpoint
CREATE TYPE "public"."credit_grants_status" AS ENUM('active', 'exhausted', 'expired', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."activity_events_mode" AS ENUM('live', 'replay', 'on_demand');--> statement-breakpoint
CREATE TYPE "public"."consent_records_method" AS ENUM('form', 'portal', 'import', 'staff', 'preference_centre', 'unsubscribe_link', 'complaint');--> statement-breakpoint
CREATE TYPE "public"."consent_records_purpose" AS ENUM('newsletter', 'events', 'member_comms', 'b2b', 'assessment_result', 'sensitive_processing', 'ai_processing');--> statement-breakpoint
CREATE TYPE "public"."consent_records_status" AS ENUM('granted', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."persons_preferred_channel" AS ENUM('email', 'phone', 'whatsapp');--> statement-breakpoint
CREATE TYPE "public"."persons_status_override" AS ENUM('lead', 'customer', 'member');--> statement-breakpoint
CREATE TYPE "public"."suppressions_reason" AS ENUM('unsubscribe', 'hard_bounce', 'complaint', 'manual', 'erased');--> statement-breakpoint
CREATE TYPE "public"."suppressions_scope" AS ENUM('all', 'newsletter', 'events', 'member_comms', 'b2b');--> statement-breakpoint
CREATE TYPE "public"."email_messages_kind" AS ENUM('transactional', 'campaign', 'automation', 'test');--> statement-breakpoint
CREATE TYPE "public"."email_messages_purpose" AS ENUM('newsletter', 'events', 'member_comms', 'b2b');--> statement-breakpoint
CREATE TYPE "public"."email_messages_status" AS ENUM('queued', 'blocked_translation', 'suppressed', 'sent', 'delivered', 'bounced', 'complained', 'failed');--> statement-breakpoint
CREATE TYPE "public"."email_templates_kind" AS ENUM('transactional', 'marketing');--> statement-breakpoint
CREATE TYPE "public"."email_templates_purpose" AS ENUM('newsletter', 'events', 'member_comms', 'b2b');--> statement-breakpoint
CREATE TYPE "public"."email_templates_status" AS ENUM('draft', 'published', 'archived');--> statement-breakpoint
CREATE TYPE "public"."invoices_billit_status" AS ENUM('pending', 'synced', 'failed');--> statement-breakpoint
CREATE TYPE "public"."invoices_kind" AS ENUM('invoice', 'credit_note');--> statement-breakpoint
CREATE TYPE "public"."invoices_status" AS ENUM('issued', 'paid', 'open', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."forms_kind" AS ENUM('lead', 'intake', 'survey', 'assessment', 'registration');--> statement-breakpoint
CREATE TYPE "public"."forms_status" AS ENUM('draft', 'published', 'archived');--> statement-breakpoint
CREATE TYPE "public"."ai_requests_status" AS ENUM('ok', 'error', 'budget_exceeded');--> statement-breakpoint
CREATE TYPE "public"."feature_flags_state" AS ENUM('off', 'testers', 'on');--> statement-breakpoint
CREATE TYPE "public"."files_kind" AS ENUM('invoice_pdf', 'import', 'export', 'image', 'rendered_email', 'receipt');--> statement-breakpoint
CREATE TYPE "public"."integration_calls_provider" AS ENUM('mollie', 'stripe', 'viva', 'billit', 'resend', 'youtube', 'meta_ads', 'google_ads', 'anthropic', 'slack', 'betterstack', 'wordpress');--> statement-breakpoint
CREATE TYPE "public"."jobs_lane" AS ENUM('fast', 'bulk');--> statement-breakpoint
CREATE TYPE "public"."jobs_status" AS ENUM('pending', 'running', 'succeeded', 'failed', 'dead');--> statement-breakpoint
CREATE TYPE "public"."locale" AS ENUM('nl-BE', 'fr-BE', 'en');--> statement-breakpoint
CREATE TYPE "public"."monthly_reports_status" AS ENUM('draft', 'sent');--> statement-breakpoint
CREATE TYPE "public"."roles_key" AS ENUM('owner', 'management', 'customer_service', 'sales', 'marketing', 'finance', 'reception', 'technical_admin', 'external_partner');--> statement-breakpoint
CREATE TYPE "public"."security_incidents_severity" AS ENUM('critical', 'high', 'normal');--> statement-breakpoint
CREATE TYPE "public"."security_incidents_status" AS ENUM('open', 'contained', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."support_requests_channel" AS ENUM('email', 'slack', 'whatsapp', 'phone', 'in_app');--> statement-breakpoint
CREATE TYPE "public"."support_requests_severity" AS ENUM('critical', 'high', 'normal', 'improvement');--> statement-breakpoint
CREATE TYPE "public"."support_requests_status" AS ENUM('open', 'responded', 'resolved', 'closed');--> statement-breakpoint
CREATE TYPE "public"."users_audience" AS ENUM('staff', 'customer');--> statement-breakpoint
CREATE TYPE "public"."users_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."webhook_events_provider" AS ENUM('mollie', 'resend', 'billit');--> statement-breakpoint
CREATE TYPE "public"."pages_kind" AS ENUM('home', 'standard', 'offer', 'pricing', 'events_index', 'event', 'blog_index', 'post', 'contact', 'legal', 'landing');--> statement-breakpoint
CREATE TYPE "public"."pages_status" AS ENUM('draft', 'published', 'archived');--> statement-breakpoint
CREATE TABLE "automations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"group_id" uuid NOT NULL,
	"current_version_id" uuid,
	"status" "automations_status" DEFAULT 'draft' NOT NULL,
	"is_marketing" boolean DEFAULT true NOT NULL,
	"purpose" "automations_purpose",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automations_slug_unique" UNIQUE("slug"),
	CONSTRAINT "automations_slug_ck" CHECK ("automations"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "automations_version_ck" CHECK ("automations"."status" = 'draft' or "automations"."current_version_id" is not null),
	CONSTRAINT "automations_purpose_ck" CHECK ("automations"."is_marketing" = false or "automations"."purpose" is not null)
);
--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"status" "bookings_status" NOT NULL,
	"paid_with" "bookings_paid_with" NOT NULL,
	"guest_of_booking_id" uuid,
	"order_line_id" uuid,
	"ticket_type_id" uuid,
	"booked_by_user_id" uuid,
	"source" "bookings_source" NOT NULL,
	"reserved_until" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"attended_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bookings_guest_not_self_ck" CHECK ("bookings"."guest_of_booking_id" <> "bookings"."id"),
	CONSTRAINT "bookings_reserved_until_ck" CHECK ("bookings"."status" <> 'reserved' or "bookings"."reserved_until" is not null),
	CONSTRAINT "bookings_attended_at_ck" CHECK ("bookings"."status" <> 'attended' or "bookings"."attended_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid,
	"kind" "sessions_kind" NOT NULL,
	"title" jsonb NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"capacity_seats" integer,
	"capacity_beds" integer,
	"credit_kind" "sessions_credit_kind",
	"credit_cost" smallint DEFAULT 1 NOT NULL,
	"status" "sessions_status" DEFAULT 'open' NOT NULL,
	"is_member_only" boolean DEFAULT false NOT NULL,
	"is_lead_magnet" boolean DEFAULT false NOT NULL,
	"lead_reserved_seats" integer DEFAULT 0 NOT NULL,
	"lead_window_start_at" timestamp with time zone,
	"lead_window_end_at" timestamp with time zone,
	"claim_window_minutes" integer DEFAULT 120 NOT NULL,
	"webinar_id" uuid,
	"location" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_ends_after_starts_ck" CHECK ("sessions"."ends_at" > "sessions"."starts_at"),
	CONSTRAINT "sessions_lead_seats_ck" CHECK ("sessions"."lead_reserved_seats" >= 0 and "sessions"."lead_reserved_seats" <= coalesce("sessions"."capacity_seats", "sessions"."capacity_beds")),
	CONSTRAINT "sessions_lead_window_ck" CHECK ("sessions"."lead_window_end_at" is null or "sessions"."lead_window_start_at" is null or "sessions"."lead_window_end_at" > "sessions"."lead_window_start_at"),
	CONSTRAINT "sessions_claim_window_ck" CHECK ("sessions"."claim_window_minutes" between 10 and 2880),
	CONSTRAINT "sessions_lead_magnet_ck" CHECK ("sessions"."is_lead_magnet" = false or ("sessions"."kind" = 'event' and "sessions"."lead_window_start_at" is not null and "sessions"."lead_window_end_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "order_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"product_kind" "products_kind" NOT NULL,
	"price_version_id" uuid,
	"description" jsonb NOT NULL,
	"quantity" integer NOT NULL,
	"unit_amount_cents" integer NOT NULL,
	"discount_cents" integer DEFAULT 0 NOT NULL,
	"line_total_cents" integer NOT NULL,
	"vat_rate_pct" numeric(4, 2) NOT NULL,
	"vat_cents" integer NOT NULL,
	"promotion_id" uuid,
	"pricing_trace" jsonb NOT NULL,
	"session_id" uuid,
	"ticket_type_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_lines_quantity_chk" CHECK ("order_lines"."quantity" between 1 and 50),
	CONSTRAINT "order_lines_unit_amount_chk" CHECK ("order_lines"."unit_amount_cents" >= 0),
	CONSTRAINT "order_lines_total_chk" CHECK ("order_lines"."line_total_cents" = "order_lines"."unit_amount_cents" * "order_lines"."quantity" - "order_lines"."discount_cents" and "order_lines"."line_total_cents" >= 0),
	CONSTRAINT "order_lines_vat_rate_chk" CHECK ("order_lines"."vat_rate_pct" in (0, 6, 12, 21))
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid,
	"company_id" uuid,
	"checkout_id" uuid,
	"channel" "orders_channel" NOT NULL,
	"status" "orders_status" DEFAULT 'pending_payment' NOT NULL,
	"subtotal_cents" integer NOT NULL,
	"discount_cents" integer DEFAULT 0 NOT NULL,
	"vat_cents" integer NOT NULL,
	"total_cents" integer NOT NULL,
	"promotion_id" uuid,
	"locale" text NOT NULL,
	"client_key" uuid NOT NULL,
	"paid_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_client_key_unique" UNIQUE("client_key"),
	CONSTRAINT "orders_subtotal_chk" CHECK ("orders"."subtotal_cents" >= 0),
	CONSTRAINT "orders_discount_chk" CHECK ("orders"."discount_cents" >= 0),
	CONSTRAINT "orders_total_chk" CHECK ("orders"."total_cents" = "orders"."subtotal_cents" - "orders"."discount_cents" and "orders"."total_cents" >= 0),
	CONSTRAINT "orders_locale_chk" CHECK ("orders"."locale" in ('nl-BE', 'fr-BE', 'en'))
);
--> statement-breakpoint
CREATE TABLE "price_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"audience" "price_versions_audience" NOT NULL,
	"amount_cents" integer NOT NULL,
	"valid_from_at" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_to_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_versions_version_chk" CHECK ("price_versions"."version" > 0),
	CONSTRAINT "price_versions_amount_chk" CHECK ("price_versions"."amount_cents" >= 0),
	CONSTRAINT "price_versions_window_chk" CHECK ("price_versions"."valid_to_at" is null or "price_versions"."valid_to_at" > "price_versions"."valid_from_at")
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "products_kind" NOT NULL,
	"sku" text NOT NULL,
	"name" jsonb NOT NULL,
	"description" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"vat_rate_pct" numeric(4, 2) NOT NULL,
	"credit_kind" "products_credit_kind",
	"credit_units" integer,
	"validity_days" integer,
	"is_sharing_allowed" boolean DEFAULT false NOT NULL,
	"max_guest_uses_per_month" smallint DEFAULT 2 NOT NULL,
	"member_discount_pct" numeric(5, 2),
	"recurring_interval" "products_recurring_interval",
	"included_credit_kind" "products_credit_kind",
	"included_credit_units" integer,
	"is_active" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_sku_unique" UNIQUE("sku"),
	CONSTRAINT "products_sku_chk" CHECK ("products"."sku" ~ '^[A-Z0-9-]{3,32}$'),
	CONSTRAINT "products_vat_rate_chk" CHECK ("products"."vat_rate_pct" in (0, 6, 12, 21)),
	CONSTRAINT "products_credit_units_chk" CHECK ("products"."credit_units" is null or "products"."credit_units" > 0),
	CONSTRAINT "products_validity_days_chk" CHECK ("products"."validity_days" is null or "products"."validity_days" > 0),
	CONSTRAINT "products_member_discount_chk" CHECK ("products"."member_discount_pct" is null or "products"."member_discount_pct" between 0 and 100),
	CONSTRAINT "products_included_credit_kind_chk" CHECK ("products"."included_credit_kind" is null or "products"."included_credit_kind" in ('day', 'night')),
	CONSTRAINT "products_package_chk" CHECK ("products"."kind" <> 'package' or ("products"."credit_kind" in ('day', 'night') and "products"."credit_units" is not null and "products"."validity_days" is not null)),
	CONSTRAINT "products_voucher_chk" CHECK ("products"."kind" <> 'voucher' or ("products"."credit_kind" = 'euro' and "products"."vat_rate_pct" = 0 and "products"."validity_days" >= 730)),
	CONSTRAINT "products_membership_chk" CHECK (("products"."kind" = 'membership') = ("products"."recurring_interval" is not null) and ("products"."included_credit_kind" is null) = ("products"."included_credit_units" is null)),
	CONSTRAINT "products_no_credit_chk" CHECK ("products"."kind" not in ('session', 'night', 'ticket', 'item') or "products"."credit_kind" is null)
);
--> statement-breakpoint
CREATE TABLE "credit_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"grant_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"beneficiary_person_id" uuid,
	"kind" "credit_entries_kind" NOT NULL,
	"quantity" integer NOT NULL,
	"reason" text,
	"ref_type" text,
	"ref_id" uuid,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor" jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_entries_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "credit_entries_sign_ck" CHECK (("credit_entries"."kind" not in ('grant', 'transfer_in', 'release') or "credit_entries"."quantity" > 0) and ("credit_entries"."kind" not in ('consume', 'expire', 'revoke', 'transfer_out') or "credit_entries"."quantity" < 0)),
	CONSTRAINT "credit_entries_beneficiary_ck" CHECK ("credit_entries"."beneficiary_person_id" is null or "credit_entries"."kind" in ('consume', 'release'))
);
--> statement-breakpoint
CREATE TABLE "credit_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"product_id" uuid,
	"order_line_id" uuid,
	"credit_kind" "credit_grants_credit_kind" NOT NULL,
	"units_granted" integer NOT NULL,
	"unit_value_cents" integer DEFAULT 0 NOT NULL,
	"starts_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"status" "credit_grants_status" DEFAULT 'active' NOT NULL,
	"source" "credit_grants_source" NOT NULL,
	"sharing" jsonb DEFAULT '{"mode":"none","max_guest_uses_per_month":0,"allowed_person_ids":[]}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_grants_units_ck" CHECK ("credit_grants"."units_granted" > 0),
	CONSTRAINT "credit_grants_unit_value_ck" CHECK ("credit_grants"."unit_value_cents" >= 0),
	CONSTRAINT "credit_grants_euro_unit_ck" CHECK ("credit_grants"."credit_kind" <> 'euro' or "credit_grants"."unit_value_cents" = 1),
	CONSTRAINT "credit_grants_expiry_ck" CHECK ("credit_grants"."expires_at" is null or "credit_grants"."expires_at" > "credit_grants"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "activity_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "activity_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"person_id" uuid,
	"company_id" uuid,
	"kind" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"mode" "activity_events_mode",
	"is_sensitive" boolean DEFAULT false NOT NULL,
	"actor" jsonb NOT NULL,
	"ref_type" text,
	"ref_id" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dedupe_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activity_events_dedupe_key_unique" UNIQUE("dedupe_key"),
	CONSTRAINT "activity_events_subject_ck" CHECK ("activity_events"."person_id" is not null or "activity_events"."company_id" is not null),
	CONSTRAINT "activity_events_kind_ck" CHECK ("activity_events"."kind" ~ '^[a-z_]+\.[a-z_]+$')
);
--> statement-breakpoint
CREATE TABLE "consent_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"purpose" "consent_records_purpose" NOT NULL,
	"status" "consent_records_status" NOT NULL,
	"source" text NOT NULL,
	"method" "consent_records_method" NOT NULL,
	"wording_version" text NOT NULL,
	"ip" "inet",
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "persons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text,
	"phone" text,
	"first_name" text,
	"last_name" text,
	"locale" "locale" DEFAULT 'nl-BE' NOT NULL,
	"address" jsonb,
	"birth_on" date,
	"preferred_channel" "persons_preferred_channel",
	"status_override" "persons_status_override",
	"status_override_reason" text,
	"status_override_by_user_id" uuid,
	"acquisition" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"partner_company_id" uuid,
	"is_tester" boolean DEFAULT false NOT NULL,
	"processing_restricted_at" timestamp with time zone,
	"merged_into_person_id" uuid,
	"erased_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "persons_email_ck" CHECK ("persons"."email" ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
	CONSTRAINT "persons_name_length_ck" CHECK (("persons"."first_name" is null or char_length("persons"."first_name") <= 100) and ("persons"."last_name" is null or char_length("persons"."last_name") <= 100)),
	CONSTRAINT "persons_birth_on_ck" CHECK ("persons"."birth_on" > '1900-01-01'),
	CONSTRAINT "persons_status_override_reason_ck" CHECK ("persons"."status_override" is null or "persons"."status_override_reason" is not null),
	CONSTRAINT "persons_merged_into_ck" CHECK ("persons"."merged_into_person_id" <> "persons"."id")
);
--> statement-breakpoint
CREATE TABLE "suppressions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email_hash" text NOT NULL,
	"email" text,
	"scope" "suppressions_scope" NOT NULL,
	"reason" "suppressions_reason" NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid,
	"to_email" text,
	"kind" "email_messages_kind" NOT NULL,
	"purpose" "email_messages_purpose",
	"template_version_id" uuid,
	"campaign_id" uuid,
	"enrolment_id" uuid,
	"locale" text NOT NULL,
	"subject" text,
	"props" jsonb,
	"context" jsonb,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reply_to" text,
	"extra_headers" jsonb,
	"send_at" timestamp with time zone,
	"idempotency_key" text NOT NULL,
	"resend_id" text,
	"link_token_hash" text,
	"status" "email_messages_status" DEFAULT 'queued' NOT NULL,
	"rendered_file_id" uuid,
	"error" text,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_messages_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "email_messages_resend_id_unique" UNIQUE("resend_id"),
	CONSTRAINT "email_messages_link_token_hash_unique" UNIQUE("link_token_hash"),
	CONSTRAINT "email_messages_campaign_purpose_ck" CHECK ("email_messages"."kind" <> 'campaign' or "email_messages"."purpose" is not null)
);
--> statement-breakpoint
CREATE TABLE "email_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"kind" "email_templates_kind" NOT NULL,
	"purpose" "email_templates_purpose",
	"current_version_id" uuid,
	"status" "email_templates_status" DEFAULT 'draft' NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_templates_slug_unique" UNIQUE("slug"),
	CONSTRAINT "email_templates_slug_ck" CHECK (("email_templates"."kind" = 'transactional' and "email_templates"."slug" ~ '^[a-z]+\.[a-z][a-z0-9_]{1,60}$') or ("email_templates"."kind" = 'marketing' and "email_templates"."slug" ~ '^[a-z0-9][a-z0-9-]{2,79}$')),
	CONSTRAINT "email_templates_purpose_ck" CHECK (("email_templates"."kind" = 'marketing') = ("email_templates"."purpose" is not null))
);
--> statement-breakpoint
CREATE TABLE "invoice_sequences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "invoices_kind" NOT NULL,
	"year" smallint NOT NULL,
	"last_number" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_invoice_sequences_year" CHECK ("invoice_sequences"."year" between 2026 and 2100),
	CONSTRAINT "chk_invoice_sequences_last_number" CHECK ("invoice_sequences"."last_number" >= 0)
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "invoices_kind" NOT NULL,
	"number" text NOT NULL,
	"reverses_invoice_id" uuid,
	"order_id" uuid NOT NULL,
	"person_id" uuid,
	"company_id" uuid,
	"customer_snapshot" jsonb NOT NULL,
	"lines" jsonb NOT NULL,
	"subtotal_cents" integer NOT NULL,
	"vat_cents" integer NOT NULL,
	"total_cents" integer NOT NULL,
	"vat_breakdown" jsonb NOT NULL,
	"issued_on" date NOT NULL,
	"due_on" date,
	"status" "invoices_status" NOT NULL,
	"pdf_file_id" uuid,
	"billit_id" text,
	"billit_status" "invoices_billit_status" DEFAULT 'pending' NOT NULL,
	"billit_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_number_unique" UNIQUE("number"),
	CONSTRAINT "invoices_billit_id_unique" UNIQUE("billit_id"),
	CONSTRAINT "chk_invoices_total" CHECK ("invoices"."total_cents" = "invoices"."subtotal_cents" + "invoices"."vat_cents")
);
--> statement-breakpoint
CREATE TABLE "forms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"kind" "forms_kind" NOT NULL,
	"name" jsonb NOT NULL,
	"status" "forms_status" DEFAULT 'draft' NOT NULL,
	"current_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "forms_slug_ck" CHECK ("forms"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length("forms"."slug") <= 64 and "forms"."slug" not in ('result', 'import')),
	CONSTRAINT "forms_published_version_ck" CHECK ("forms"."status" <> 'published' or "forms"."current_version_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "ai_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"feature" text NOT NULL,
	"model" text NOT NULL,
	"actor" jsonb NOT NULL,
	"person_id" uuid,
	"fields_sent" text[] DEFAULT '{}'::text[] NOT NULL,
	"prompt" text NOT NULL,
	"output" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cost_cents" numeric(12, 4) DEFAULT '0' NOT NULL,
	"status" "ai_requests_status" NOT NULL,
	"error" text,
	"job_id" uuid,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_requests_model_ck" CHECK ("ai_requests"."model" in ('claude-opus-5-5', 'claude-haiku-5-5'))
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor" jsonb NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"person_id" uuid,
	"old_value" jsonb,
	"new_value" jsonb,
	"request_id" text,
	"ip" text,
	"is_redacted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_log_action_ck" CHECK ("audit_log"."action" ~ '^[a-z_]+(\.[a-z_]+){1,2}$')
);
--> statement-breakpoint
CREATE TABLE "auth_accounts" (
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"provider" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"refresh_token" text,
	"access_token" text,
	"expires_at" integer,
	"token_type" text,
	"scope" text,
	"id_token" text,
	"session_state" text,
	CONSTRAINT "auth_accounts_provider_provider_account_id_pk" PRIMARY KEY("provider","provider_account_id")
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_token" text NOT NULL,
	"user_id" uuid NOT NULL,
	"audience" "users_audience" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"absolute_expires_at" timestamp with time zone NOT NULL,
	"mfa_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_sessions_session_token_unique" UNIQUE("session_token"),
	CONSTRAINT "auth_sessions_absolute_ck" CHECK ("auth_sessions"."absolute_expires_at" >= "auth_sessions"."created_at")
);
--> statement-breakpoint
CREATE TABLE "auth_verification_tokens" (
	"identifier" text NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_verification_tokens_identifier_token_pk" PRIMARY KEY("identifier","token")
);
--> statement-breakpoint
CREATE TABLE "feature_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"state" "feature_flags_state" DEFAULT 'off' NOT NULL,
	"user_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"person_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feature_flags_key_unique" UNIQUE("key"),
	CONSTRAINT "feature_flags_key_ck" CHECK ("feature_flags"."key" ~ '^ff_[a-z]+_[a-z0-9_]+$')
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "files_kind" NOT NULL,
	"name" text NOT NULL,
	"mime" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"bytes" "bytea" NOT NULL,
	"sha256" text NOT NULL,
	"is_public" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone,
	"person_id" uuid,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "files_name_ck" CHECK (char_length("files"."name") between 1 and 200 and strpos("files"."name", '/') = 0 and strpos("files"."name", chr(92)) = 0),
	CONSTRAINT "files_size_ck" CHECK ("files"."size_bytes" between 0 and 10485760),
	CONSTRAINT "files_sha256_ck" CHECK ("files"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "files_public_kind_ck" CHECK (not "files"."is_public" or "files"."kind" = 'image'),
	CONSTRAINT "files_mime_ck" CHECK ("files"."kind" <> 'image' or "files"."mime" in ('image/png', 'image/jpeg', 'image/webp', 'image/gif'))
);
--> statement-breakpoint
CREATE TABLE "integration_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "integration_calls_provider" NOT NULL,
	"operation" text NOT NULL,
	"request_digest" text NOT NULL,
	"status_code" integer,
	"ok" boolean NOT NULL,
	"duration_ms" integer NOT NULL,
	"error" text,
	"job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_calls_duration_ck" CHECK ("integration_calls"."duration_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"lane" "jobs_lane" DEFAULT 'fast' NOT NULL,
	"priority" smallint DEFAULT 5 NOT NULL,
	"status" "jobs_status" DEFAULT 'pending' NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 6 NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"last_error" text,
	"result" jsonb,
	"request_id" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "jobs_kind_ck" CHECK ("jobs"."kind" ~ '^[a-z_]+\.[a-z_]+$'),
	CONSTRAINT "jobs_priority_ck" CHECK ("jobs"."priority" between 1 and 9),
	CONSTRAINT "jobs_attempts_ck" CHECK ("jobs"."attempts" >= 0),
	CONSTRAINT "jobs_max_attempts_ck" CHECK ("jobs"."max_attempts" >= 1),
	CONSTRAINT "jobs_running_lock_ck" CHECK ("jobs"."status" <> 'running' or "jobs"."locked_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "monthly_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"month_on" date NOT NULL,
	"status" "monthly_reports_status" DEFAULT 'draft' NOT NULL,
	"data" jsonb NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"sent_at" timestamp with time zone,
	"sent_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "monthly_reports_month_on_unique" UNIQUE("month_on")
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" "roles_key" NOT NULL,
	"name" jsonb NOT NULL,
	"description" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"permissions" text[] DEFAULT '{}'::text[] NOT NULL,
	"seeded_permissions" text[] DEFAULT '{}'::text[] NOT NULL,
	"is_system" boolean DEFAULT true NOT NULL,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_key_unique" UNIQUE("key"),
	CONSTRAINT "roles_owner_all_ck" CHECK ("roles"."key" <> 'owner' or "roles"."permissions" = '{*}'::text[])
);
--> statement-breakpoint
CREATE TABLE "security_incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"severity" "security_incidents_severity" NOT NULL,
	"status" "security_incidents_status" DEFAULT 'open' NOT NULL,
	"discovered_at" timestamp with time zone NOT NULL,
	"beam_notified_at" timestamp with time zone,
	"systems_affected" text DEFAULT '' NOT NULL,
	"data_affected" text DEFAULT '' NOT NULL,
	"risk" text DEFAULT '' NOT NULL,
	"actions" text DEFAULT '' NOT NULL,
	"notifications" text DEFAULT '' NOT NULL,
	"resolution" text DEFAULT '' NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "security_incidents_resolved_ck" CHECK ("security_incidents"."status" <> 'resolved' or "security_incidents"."resolved_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settings_key_unique" UNIQUE("key"),
	CONSTRAINT "settings_key_ck" CHECK ("settings"."key" ~ '^[a-z_]+$'),
	CONSTRAINT "settings_version_ck" CHECK ("settings"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "support_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference" text NOT NULL,
	"severity" "support_requests_severity" NOT NULL,
	"channel" "support_requests_channel" NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" "support_requests_status" DEFAULT 'open' NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"response_due_at" timestamp with time zone NOT NULL,
	"first_response_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"reported_by_user_id" uuid,
	"assignee_user_id" uuid,
	"incident_id" uuid,
	"page_url" text,
	"request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_requests_reference_unique" UNIQUE("reference"),
	CONSTRAINT "support_requests_title_ck" CHECK (char_length("support_requests"."title") between 3 and 200),
	CONSTRAINT "support_requests_first_response_ck" CHECK ("support_requests"."first_response_at" is null or "support_requests"."first_response_at" >= "support_requests"."received_at"),
	CONSTRAINT "support_requests_resolved_ck" CHECK ("support_requests"."status" not in ('resolved', 'closed') or "support_requests"."resolved_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"audience" "users_audience" NOT NULL,
	"email" text NOT NULL,
	"email_verified_at" timestamp with time zone,
	"name" text,
	"image" text,
	"password_hash" text,
	"password_changed_at" timestamp with time zone,
	"locale" "locale" DEFAULT 'nl-BE' NOT NULL,
	"role_key" "roles_key",
	"person_id" uuid,
	"totp_secret_enc" "bytea",
	"recovery_codes_enc" "bytea",
	"secret_key_version" smallint,
	"mfa_enrolled_at" timestamp with time zone,
	"is_tester" boolean DEFAULT false NOT NULL,
	"failed_logins" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"status" "users_status" DEFAULT 'active' NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_ck" CHECK ("users"."email" = lower("users"."email") and position('@' in "users"."email") > 1),
	CONSTRAINT "users_password_hash_ck" CHECK ("users"."password_hash" is null or "users"."password_hash" like '$argon2id$%'),
	CONSTRAINT "users_failed_logins_ck" CHECK ("users"."failed_logins" >= 0),
	CONSTRAINT "users_audience_shape_ck" CHECK (("users"."audience" = 'staff' and "users"."role_key" is not null) or ("users"."audience" = 'customer' and "users"."role_key" is null and "users"."person_id" is not null)),
	CONSTRAINT "users_partner_person_ck" CHECK ("users"."role_key" <> 'external_partner' or "users"."person_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "webhook_events_provider" NOT NULL,
	"external_event_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"job_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "pages_kind" NOT NULL,
	"slug" text NOT NULL,
	"status" "pages_status" DEFAULT 'draft' NOT NULL,
	"current_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pages_slug_unique" UNIQUE("slug"),
	CONSTRAINT "pages_slug_ck" CHECK ("pages"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length("pages"."slug") <= 80)
);
--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_guest_of_booking_id_bookings_id_fk" FOREIGN KEY ("guest_of_booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_order_line_id_order_lines_id_fk" FOREIGN KEY ("order_line_id") REFERENCES "public"."order_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_booked_by_user_id_users_id_fk" FOREIGN KEY ("booked_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_price_version_id_price_versions_id_fk" FOREIGN KEY ("price_version_id") REFERENCES "public"."price_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_versions" ADD CONSTRAINT "price_versions_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_versions" ADD CONSTRAINT "price_versions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_entries" ADD CONSTRAINT "credit_entries_grant_id_credit_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."credit_grants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_entries" ADD CONSTRAINT "credit_entries_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_entries" ADD CONSTRAINT "credit_entries_beneficiary_person_id_persons_id_fk" FOREIGN KEY ("beneficiary_person_id") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_grants" ADD CONSTRAINT "credit_grants_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_grants" ADD CONSTRAINT "credit_grants_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_grants" ADD CONSTRAINT "credit_grants_order_line_id_order_lines_id_fk" FOREIGN KEY ("order_line_id") REFERENCES "public"."order_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "persons" ADD CONSTRAINT "persons_status_override_by_user_id_users_id_fk" FOREIGN KEY ("status_override_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "persons" ADD CONSTRAINT "persons_merged_into_person_id_persons_id_fk" FOREIGN KEY ("merged_into_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_rendered_file_id_files_id_fk" FOREIGN KEY ("rendered_file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_templates" ADD CONSTRAINT "email_templates_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_reverses_invoice_id_invoices_id_fk" FOREIGN KEY ("reverses_invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_pdf_file_id_files_id_fk" FOREIGN KEY ("pdf_file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_requests" ADD CONSTRAINT "ai_requests_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_accounts" ADD CONSTRAINT "auth_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_flags" ADD CONSTRAINT "feature_flags_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monthly_reports" ADD CONSTRAINT "monthly_reports_sent_by_user_id_users_id_fk" FOREIGN KEY ("sent_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_incidents" ADD CONSTRAINT "security_incidents_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_requests" ADD CONSTRAINT "support_requests_reported_by_user_id_users_id_fk" FOREIGN KEY ("reported_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_requests" ADD CONSTRAINT "support_requests_assignee_user_id_users_id_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_requests" ADD CONSTRAINT "support_requests_incident_id_security_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."security_incidents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_key_roles_key_fk" FOREIGN KEY ("role_key") REFERENCES "public"."roles"("key") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automations_status_idx" ON "automations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "automations_group_idx" ON "automations" USING btree ("group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bookings_session_person_active_uq" ON "bookings" USING btree ("session_id","person_id") WHERE "bookings"."status" in ('reserved', 'confirmed');--> statement-breakpoint
CREATE INDEX "bookings_session_status_idx" ON "bookings" USING btree ("session_id","status");--> statement-breakpoint
CREATE INDEX "bookings_person_created_idx" ON "bookings" USING btree ("person_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "bookings_guest_of_idx" ON "bookings" USING btree ("guest_of_booking_id") WHERE "bookings"."guest_of_booking_id" is not null;--> statement-breakpoint
CREATE INDEX "bookings_order_line_idx" ON "bookings" USING btree ("order_line_id") WHERE "bookings"."order_line_id" is not null;--> statement-breakpoint
CREATE INDEX "bookings_reserved_until_idx" ON "bookings" USING btree ("reserved_until") WHERE "bookings"."status" = 'reserved';--> statement-breakpoint
CREATE INDEX "sessions_starts_at_idx" ON "sessions" USING btree ("starts_at");--> statement-breakpoint
CREATE INDEX "sessions_open_kind_idx" ON "sessions" USING btree ("kind","starts_at") WHERE "sessions"."status" = 'open';--> statement-breakpoint
CREATE INDEX "sessions_ends_at_idx" ON "sessions" USING btree ("ends_at") WHERE "sessions"."status" <> 'cancelled';--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_template_starts_uq" ON "sessions" USING btree ("template_id","starts_at") WHERE "sessions"."template_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_webinar_uq" ON "sessions" USING btree ("webinar_id") WHERE "sessions"."webinar_id" is not null;--> statement-breakpoint
CREATE INDEX "order_lines_order_idx" ON "order_lines" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_lines_session_idx" ON "order_lines" USING btree ("session_id") WHERE "order_lines"."session_id" is not null;--> statement-breakpoint
CREATE INDEX "orders_person_created_idx" ON "orders" USING btree ("person_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "orders_company_idx" ON "orders" USING btree ("company_id") WHERE "orders"."company_id" is not null;--> statement-breakpoint
CREATE INDEX "orders_paid_at_idx" ON "orders" USING btree ("paid_at") WHERE "orders"."paid_at" is not null;--> statement-breakpoint
CREATE INDEX "orders_checkout_idx" ON "orders" USING btree ("checkout_id");--> statement-breakpoint
CREATE UNIQUE INDEX "price_versions_product_audience_version_uq" ON "price_versions" USING btree ("product_id","audience","version");--> statement-breakpoint
CREATE INDEX "price_versions_product_audience_from_idx" ON "price_versions" USING btree ("product_id","audience","valid_from_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "products_kind_active_idx" ON "products" USING btree ("kind","is_active","sort_order");--> statement-breakpoint
CREATE INDEX "credit_entries_grant_idx" ON "credit_entries" USING btree ("grant_id","created_at");--> statement-breakpoint
CREATE INDEX "credit_entries_person_idx" ON "credit_entries" USING btree ("person_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "credit_entries_beneficiary_idx" ON "credit_entries" USING btree ("beneficiary_person_id","created_at") WHERE "credit_entries"."beneficiary_person_id" is not null;--> statement-breakpoint
CREATE INDEX "credit_entries_ref_idx" ON "credit_entries" USING btree ("ref_type","ref_id");--> statement-breakpoint
CREATE INDEX "credit_grants_person_kind_idx" ON "credit_grants" USING btree ("person_id","credit_kind","status","expires_at");--> statement-breakpoint
CREATE INDEX "credit_grants_active_expires_idx" ON "credit_grants" USING btree ("expires_at") WHERE "credit_grants"."status" = 'active';--> statement-breakpoint
CREATE INDEX "credit_grants_order_line_idx" ON "credit_grants" USING btree ("order_line_id");--> statement-breakpoint
CREATE INDEX "credit_grants_product_idx" ON "credit_grants" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "activity_events_person_idx" ON "activity_events" USING btree ("person_id","occurred_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "activity_events_company_idx" ON "activity_events" USING btree ("company_id","occurred_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "activity_events"."company_id" is not null;--> statement-breakpoint
CREATE INDEX "activity_events_kind_idx" ON "activity_events" USING btree ("kind","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "activity_events_ref_idx" ON "activity_events" USING btree ("ref_type","ref_id");--> statement-breakpoint
CREATE INDEX "consent_records_person_purpose_idx" ON "consent_records" USING btree ("person_id","purpose","recorded_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "persons_email_active_uq" ON "persons" USING btree (lower("email")) WHERE "persons"."erased_at" is null and "persons"."merged_into_person_id" is null;--> statement-breakpoint
CREATE INDEX "persons_email_idx" ON "persons" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "persons_name_idx" ON "persons" USING btree (lower("last_name"),lower("first_name"));--> statement-breakpoint
CREATE INDEX "persons_merged_into_idx" ON "persons" USING btree ("merged_into_person_id") WHERE "persons"."merged_into_person_id" is not null;--> statement-breakpoint
CREATE INDEX "persons_partner_company_idx" ON "persons" USING btree ("partner_company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "suppressions_email_hash_scope_uq" ON "suppressions" USING btree ("email_hash","scope");--> statement-breakpoint
CREATE INDEX "email_messages_person_created_idx" ON "email_messages" USING btree ("person_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "email_messages_campaign_status_idx" ON "email_messages" USING btree ("campaign_id","status");--> statement-breakpoint
CREATE INDEX "email_messages_queued_idx" ON "email_messages" USING btree ("queued_at") WHERE "email_messages"."status" in ('queued', 'blocked_translation');--> statement-breakpoint
CREATE INDEX "email_messages_person_template_idx" ON "email_messages" USING btree ("person_id","template_version_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "email_templates_kind_status_idx" ON "email_templates" USING btree ("kind","status");--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_sequences_year_kind_uq" ON "invoice_sequences" USING btree ("year","kind");--> statement-breakpoint
CREATE INDEX "ix_invoices_issued_on" ON "invoices" USING btree ("issued_on","kind");--> statement-breakpoint
CREATE INDEX "ix_invoices_order" ON "invoices" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "ix_invoices_reverses" ON "invoices" USING btree ("reverses_invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "forms_slug_uq" ON "forms" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "forms_status_idx" ON "forms" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ai_requests_created_idx" ON "ai_requests" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "ai_requests_feature_idx" ON "ai_requests" USING btree ("feature","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ai_requests_person_idx" ON "ai_requests" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_log_person_idx" ON "audit_log" USING btree ("person_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_log_action_idx" ON "audit_log" USING btree ("action","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_log_created_idx" ON "audit_log" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_log_actor_idx" ON "audit_log" USING btree (("actor"->>'id'),"created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "auth_sessions_user_idx" ON "auth_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_sessions_expires_idx" ON "auth_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "auth_verification_tokens_expires_idx" ON "auth_verification_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "files_person_idx" ON "files" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "files_expires_idx" ON "files" USING btree ("expires_at") WHERE "files"."expires_at" is not null;--> statement-breakpoint
CREATE INDEX "files_kind_created_idx" ON "files" USING btree ("kind","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "files_sha256_idx" ON "files" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "integration_calls_provider_created_idx" ON "integration_calls" USING btree ("provider","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "integration_calls_created_idx" ON "integration_calls" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "integration_calls_job_idx" ON "integration_calls" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "jobs_pending_idx" ON "jobs" USING btree ("lane","priority","run_at") WHERE "jobs"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "jobs_running_idx" ON "jobs" USING btree ("locked_at") WHERE "jobs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "jobs_done_idx" ON "jobs" USING btree ("status","finished_at") WHERE "jobs"."status" in ('succeeded', 'dead');--> statement-breakpoint
CREATE INDEX "jobs_kind_idx" ON "jobs" USING btree ("kind","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "rate_limits_expires_idx" ON "rate_limits" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "security_incidents_status_idx" ON "security_incidents" USING btree ("status","discovered_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "support_requests_status_due_idx" ON "support_requests" USING btree ("status","response_due_at");--> statement-breakpoint
CREATE INDEX "support_requests_received_idx" ON "support_requests" USING btree ("received_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_uq" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "users_customer_person_uq" ON "users" USING btree ("person_id") WHERE "users"."audience" = 'customer';--> statement-breakpoint
CREATE INDEX "users_role_idx" ON "users" USING btree ("role_key") WHERE "users"."audience" = 'staff';--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_provider_external_uq" ON "webhook_events" USING btree ("provider","external_event_id");--> statement-breakpoint
CREATE INDEX "webhook_events_provider_received_idx" ON "webhook_events" USING btree ("provider","received_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "pages_kind_status_idx" ON "pages" USING btree ("kind","status");