CREATE TYPE "public"."form_import_events_status" AS ENUM('received', 'processed', 'skipped', 'failed');--> statement-breakpoint
CREATE TYPE "public"."form_import_sources_provider" AS ENUM('scoreapp', 'typeform');--> statement-breakpoint
CREATE TYPE "public"."form_links_channel" AS ENUM('link', 'qr', 'ad', 'email', 'social', 'partner', 'referral', 'print', 'b2b');--> statement-breakpoint
CREATE TYPE "public"."form_submissions_identified_by" AS ENUM('session', 'token', 'staff', 'email', 'import', 'none');--> statement-breakpoint
CREATE TYPE "public"."form_submissions_status" AS ENUM('started', 'partial', 'abandoned', 'completed');--> statement-breakpoint
CREATE TABLE "form_import_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"email_hash" text,
	"status" "form_import_events_status" DEFAULT 'received' NOT NULL,
	"error" text,
	"submission_id" uuid,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "form_import_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"provider" "form_import_sources_provider" NOT NULL,
	"name" text NOT NULL,
	"form_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"mapping" jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_received_at" timestamp with time zone,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "form_import_sources_key_ck" CHECK ("form_import_sources"."key" ~ '^[a-z0-9]{12}$')
);
--> statement-breakpoint
CREATE TABLE "form_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"form_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"channel" "form_links_channel" DEFAULT 'link' NOT NULL,
	"utm" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"partner_company_id" uuid,
	"referrer_person_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "form_links_key_ck" CHECK ("form_links"."key" ~ '^[a-z0-9]{8}$')
);
--> statement-breakpoint
CREATE TABLE "form_sensitive_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"submission_id" uuid NOT NULL,
	"person_id" uuid,
	"field_key" text NOT NULL,
	"value_enc" "bytea" NOT NULL,
	"key_version" smallint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "form_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"form_id" uuid NOT NULL,
	"form_version_id" uuid NOT NULL,
	"person_id" uuid,
	"status" "form_submissions_status" DEFAULT 'started' NOT NULL,
	"identified_by" "form_submissions_identified_by" DEFAULT 'none' NOT NULL,
	"answers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"score" jsonb,
	"outcome_key" text,
	"ending_key" text,
	"path" text[] DEFAULT '{}'::text[] NOT NULL,
	"current_section_key" text,
	"utm" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source" text DEFAULT 'website' NOT NULL,
	"campaign" text,
	"funnel" text NOT NULL,
	"link_id" uuid,
	"referrer_url" text,
	"landing_path" text,
	"embed_host" text,
	"applied_tag_keys" text[] DEFAULT '{}'::text[] NOT NULL,
	"entered_by_user_id" uuid,
	"locale" text NOT NULL,
	"result_token_hash" text,
	"result_token_version" smallint DEFAULT 1 NOT NULL,
	"result_token_expires_at" timestamp with time zone,
	"resume_token_hash" text,
	"ip_hash" text,
	"consent_snapshot" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"import_event_id" uuid,
	"external_ref" text,
	"result_email_message_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"abandoned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "form_submissions_source_ck" CHECK ("form_submissions"."source" in ('website', 'landing_page', 'paid_meta', 'paid_google', 'paid_other', 'organic_search', 'social_media', 'webinar', 'event', 'referral', 'partner', 'customer_introduction', 'walk_in', 'qr_code', 'b2b_campaign', 'import', 'manual', 'other')),
	CONSTRAINT "form_submissions_locale_ck" CHECK ("form_submissions"."locale" in ('nl-BE', 'fr-BE', 'en')),
	CONSTRAINT "form_submissions_completed_ck" CHECK (("form_submissions"."status" = 'completed') = ("form_submissions"."completed_at" is not null)),
	CONSTRAINT "form_submissions_abandoned_ck" CHECK ("form_submissions"."status" <> 'abandoned' or "form_submissions"."abandoned_at" is not null),
	CONSTRAINT "form_submissions_referrer_url_ck" CHECK ("form_submissions"."referrer_url" is null or length("form_submissions"."referrer_url") <= 500),
	CONSTRAINT "form_submissions_landing_path_ck" CHECK ("form_submissions"."landing_path" is null or length("form_submissions"."landing_path") <= 300)
);
--> statement-breakpoint
CREATE TABLE "form_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"form_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"definition" jsonb NOT NULL,
	"scoring" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sensitive_field_keys" text[] DEFAULT '{}'::text[] NOT NULL,
	"locales" text[] DEFAULT '{nl-BE}'::text[] NOT NULL,
	"consent_purposes" text[] DEFAULT '{}'::text[] NOT NULL,
	"definition_hash" text NOT NULL,
	"change_note" text,
	"published_at" timestamp with time zone,
	"published_by_user_id" uuid,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "form_versions_version_ck" CHECK ("form_versions"."version" > 0),
	CONSTRAINT "form_versions_locales_ck" CHECK (cardinality("form_versions"."locales") >= 1 and "form_versions"."locales" <@ array['nl-BE', 'fr-BE', 'en']::text[]),
	CONSTRAINT "form_versions_publisher_ck" CHECK ("form_versions"."published_by_user_id" is null or "form_versions"."published_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "form_views_daily" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"form_id" uuid NOT NULL,
	"day_on" date NOT NULL,
	"link_key" text DEFAULT '' NOT NULL,
	"locale" text NOT NULL,
	"views" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "form_views_daily_views_ck" CHECK ("form_views_daily"."views" >= 0)
);
--> statement-breakpoint
ALTER TABLE "forms" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "forms" ADD COLUMN "created_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "forms" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "forms" ADD COLUMN "cta_warnings" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "form_import_events" ADD CONSTRAINT "form_import_events_source_id_form_import_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."form_import_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_import_events" ADD CONSTRAINT "form_import_events_submission_id_form_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."form_submissions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_import_sources" ADD CONSTRAINT "form_import_sources_form_id_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."forms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_import_sources" ADD CONSTRAINT "form_import_sources_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_links" ADD CONSTRAINT "form_links_form_id_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."forms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_links" ADD CONSTRAINT "form_links_partner_company_id_companies_id_fk" FOREIGN KEY ("partner_company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_links" ADD CONSTRAINT "form_links_referrer_person_id_persons_id_fk" FOREIGN KEY ("referrer_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_links" ADD CONSTRAINT "form_links_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_sensitive_answers" ADD CONSTRAINT "form_sensitive_answers_submission_id_form_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."form_submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_sensitive_answers" ADD CONSTRAINT "form_sensitive_answers_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_form_id_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."forms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_form_version_id_form_versions_id_fk" FOREIGN KEY ("form_version_id") REFERENCES "public"."form_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_link_id_form_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."form_links"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_entered_by_user_id_users_id_fk" FOREIGN KEY ("entered_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_import_event_id_form_import_events_id_fk" FOREIGN KEY ("import_event_id") REFERENCES "public"."form_import_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_result_email_message_id_email_messages_id_fk" FOREIGN KEY ("result_email_message_id") REFERENCES "public"."email_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_versions" ADD CONSTRAINT "form_versions_form_id_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."forms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_versions" ADD CONSTRAINT "form_versions_published_by_user_id_users_id_fk" FOREIGN KEY ("published_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_versions" ADD CONSTRAINT "form_versions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_views_daily" ADD CONSTRAINT "form_views_daily_form_id_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."forms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "form_import_events_uq" ON "form_import_events" USING btree ("source_id","external_id");--> statement-breakpoint
CREATE INDEX "form_import_events_status_idx" ON "form_import_events" USING btree ("status","received_at");--> statement-breakpoint
CREATE INDEX "form_import_events_email_idx" ON "form_import_events" USING btree ("email_hash");--> statement-breakpoint
CREATE INDEX "form_import_events_submission_idx" ON "form_import_events" USING btree ("submission_id") WHERE "form_import_events"."submission_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "form_import_sources_key_uq" ON "form_import_sources" USING btree ("key");--> statement-breakpoint
CREATE INDEX "form_import_sources_form_idx" ON "form_import_sources" USING btree ("form_id");--> statement-breakpoint
CREATE UNIQUE INDEX "form_links_key_uq" ON "form_links" USING btree ("key");--> statement-breakpoint
CREATE INDEX "form_links_form_idx" ON "form_links" USING btree ("form_id");--> statement-breakpoint
CREATE UNIQUE INDEX "form_sensitive_answers_uq" ON "form_sensitive_answers" USING btree ("submission_id","field_key");--> statement-breakpoint
CREATE INDEX "form_sensitive_answers_person_idx" ON "form_sensitive_answers" USING btree ("person_id") WHERE "form_sensitive_answers"."person_id" is not null;--> statement-breakpoint
CREATE INDEX "form_submissions_form_status_idx" ON "form_submissions" USING btree ("form_id","status","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "form_submissions_person_idx" ON "form_submissions" USING btree ("person_id","form_id","completed_at" DESC NULLS LAST) WHERE "form_submissions"."person_id" is not null;--> statement-breakpoint
CREATE INDEX "form_submissions_open_idx" ON "form_submissions" USING btree ("last_activity_at") WHERE "form_submissions"."status" in ('started', 'partial');--> statement-breakpoint
CREATE INDEX "form_submissions_version_idx" ON "form_submissions" USING btree ("form_version_id");--> statement-breakpoint
CREATE INDEX "form_submissions_link_idx" ON "form_submissions" USING btree ("link_id") WHERE "form_submissions"."link_id" is not null;--> statement-breakpoint
CREATE INDEX "form_submissions_ip_idx" ON "form_submissions" USING btree ("form_id","ip_hash","started_at") WHERE "form_submissions"."ip_hash" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "form_submissions_result_token_uq" ON "form_submissions" USING btree ("result_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "form_submissions_resume_token_uq" ON "form_submissions" USING btree ("resume_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "form_submissions_import_uq" ON "form_submissions" USING btree ("import_event_id") WHERE "form_submissions"."import_event_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "form_versions_form_version_uq" ON "form_versions" USING btree ("form_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "form_versions_one_draft_uq" ON "form_versions" USING btree ("form_id") WHERE "form_versions"."published_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "form_views_daily_uq" ON "form_views_daily" USING btree ("form_id","day_on","link_key","locale");--> statement-breakpoint
ALTER TABLE "forms" ADD CONSTRAINT "forms_current_version_id_form_versions_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."form_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forms" ADD CONSTRAINT "forms_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;