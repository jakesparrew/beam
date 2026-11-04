CREATE TYPE "public"."companies_size" AS ENUM('1_9', '10_49', '50_249', '250_plus');--> statement-breakpoint
CREATE TYPE "public"."companies_status" AS ENUM('target', 'prospect', 'customer', 'partner', 'inactive');--> statement-breakpoint
CREATE TYPE "public"."company_contacts_decision_role" AS ENUM('decision_maker', 'influencer', 'user', 'gatekeeper');--> statement-breakpoint
CREATE TYPE "public"."consent_records_lawful_basis" AS ENUM('consent', 'legitimate_interest');--> statement-breakpoint
CREATE TYPE "public"."person_declarations_kind" AS ENUM('guardian_consent');--> statement-breakpoint
CREATE TYPE "public"."person_declarations_method" AS ENUM('portal', 'reception', 'form', 'import');--> statement-breakpoint
CREATE TYPE "public"."person_declarations_status" AS ENUM('accepted', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."person_duplicate_candidates_status" AS ENUM('open', 'merged', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."person_sensitive_fields_key" AS ENUM('health_note', 'sleep', 'stress', 'recovery', 'wellbeing', 'medical');--> statement-breakpoint
CREATE TYPE "public"."person_tags_source" AS ENUM('manual', 'automation', 'import', 'form');--> statement-breakpoint
CREATE TYPE "public"."segment_members_source" AS ENUM('rule', 'manual');--> statement-breakpoint
CREATE TYPE "public"."segments_kind" AS ENUM('dynamic', 'static');--> statement-breakpoint
CREATE TYPE "public"."tasks_kind" AS ENUM('call', 'follow_up', 'payment', 'proposal', 'review', 'other');--> statement-breakpoint
CREATE TYPE "public"."tasks_priority" AS ENUM('low', 'normal', 'high');--> statement-breakpoint
CREATE TYPE "public"."tasks_source" AS ENUM('manual', 'automation', 'retention', 'system');--> statement-breakpoint
CREATE TYPE "public"."tasks_status" AS ENUM('open', 'done', 'cancelled');--> statement-breakpoint
CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"vat_number" text,
	"address" jsonb,
	"website" text,
	"industry" text,
	"size" "companies_size",
	"status" "companies_status" DEFAULT 'target' NOT NULL,
	"owner_user_id" uuid,
	"notes" text,
	"is_partner" boolean DEFAULT false NOT NULL,
	"partner_commission_pct" numeric(5, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "companies_vat_number_ck" CHECK ("companies"."vat_number" ~ '^[A-Z]{2}[0-9A-Z]{2,12}$'),
	CONSTRAINT "companies_partner_commission_ck" CHECK ("companies"."partner_commission_pct" between 0 and 100),
	CONSTRAINT "companies_name_ck" CHECK (char_length("companies"."name") between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "company_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"position" text,
	"decision_role" "company_contacts_decision_role",
	"relationship" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"ended_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consent_wordings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purpose" "consent_records_purpose" NOT NULL,
	"version" integer NOT NULL,
	"text" jsonb NOT NULL,
	"published_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consent_wordings_version_ck" CHECK ("consent_wordings"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "person_declarations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"kind" "person_declarations_kind" NOT NULL,
	"document_version_id" uuid NOT NULL,
	"document_version" integer NOT NULL,
	"status" "person_declarations_status" DEFAULT 'accepted' NOT NULL,
	"method" "person_declarations_method" NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"guardian_person_id" uuid,
	"ip" "inet",
	"actor" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "person_declarations_guardian_ck" CHECK ("person_declarations"."kind" <> 'guardian_consent' or "person_declarations"."guardian_person_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "person_duplicate_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_a_id" uuid NOT NULL,
	"person_b_id" uuid NOT NULL,
	"score" smallint NOT NULL,
	"reasons" text[] NOT NULL,
	"status" "person_duplicate_candidates_status" DEFAULT 'open' NOT NULL,
	"reviewed_by_user_id" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "person_duplicate_candidates_order_ck" CHECK ("person_duplicate_candidates"."person_a_id" < "person_duplicate_candidates"."person_b_id"),
	CONSTRAINT "person_duplicate_candidates_score_ck" CHECK ("person_duplicate_candidates"."score" between 0 and 100),
	CONSTRAINT "person_duplicate_candidates_reasons_ck" CHECK ("person_duplicate_candidates"."reasons" <@ array['email_variant','phone','name_birth','name_postal','external_id']::text[])
);
--> statement-breakpoint
CREATE TABLE "person_merges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"winner_person_id" uuid NOT NULL,
	"loser_person_id" uuid NOT NULL,
	"loser_snapshot" jsonb NOT NULL,
	"field_choices" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"repointed" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"merged_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "person_merges_loser_person_id_unique" UNIQUE("loser_person_id"),
	CONSTRAINT "person_merges_distinct_ck" CHECK ("person_merges"."winner_person_id" <> "person_merges"."loser_person_id")
);
--> statement-breakpoint
CREATE TABLE "person_sensitive_fields" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"key" "person_sensitive_fields_key" NOT NULL,
	"value_enc" "bytea" NOT NULL,
	"key_version" smallint DEFAULT 1 NOT NULL,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "person_tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"source" "person_tags_source" NOT NULL,
	"added_by" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "segment_members" (
	"segment_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"source" "segment_members_source" NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "segment_members_segment_id_person_id_pk" PRIMARY KEY("segment_id","person_id")
);
--> statement-breakpoint
CREATE TABLE "segments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"kind" "segments_kind" NOT NULL,
	"definition" jsonb DEFAULT '{"op":"and","rules":[]}'::jsonb NOT NULL,
	"exclude_segment_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL,
	"refresh_error" text,
	"last_count" integer,
	"last_counted_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "segments_no_self_exclusion_ck" CHECK (not ("segments"."id" = any("segments"."exclude_segment_ids"))),
	CONSTRAINT "segments_name_ck" CHECK (char_length("segments"."name") between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" jsonb NOT NULL,
	"color" text DEFAULT '#64748b' NOT NULL,
	"description" text,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tags_key_unique" UNIQUE("key"),
	CONSTRAINT "tags_key_ck" CHECK ("tags"."key" ~ '^[a-z0-9][a-z0-9_:-]{1,62}$'),
	CONSTRAINT "tags_color_ck" CHECK ("tags"."color" ~ '^#[0-9a-f]{6}$')
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"person_id" uuid,
	"company_id" uuid,
	"title" text NOT NULL,
	"kind" "tasks_kind" NOT NULL,
	"due_at" timestamp with time zone,
	"priority" "tasks_priority" DEFAULT 'normal' NOT NULL,
	"status" "tasks_status" DEFAULT 'open' NOT NULL,
	"source" "tasks_source" DEFAULT 'manual' NOT NULL,
	"ref_type" text,
	"ref_id" text,
	"notes" text,
	"done_at" timestamp with time zone,
	"done_by_user_id" uuid,
	"created_by" jsonb NOT NULL,
	"dedupe_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tasks_dedupe_key_unique" UNIQUE("dedupe_key"),
	CONSTRAINT "tasks_title_ck" CHECK (char_length("tasks"."title") between 1 and 200),
	CONSTRAINT "tasks_done_at_ck" CHECK (("tasks"."status" = 'done') = ("tasks"."done_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "consent_records" ADD COLUMN "lawful_basis" "consent_records_lawful_basis" DEFAULT 'consent' NOT NULL;--> statement-breakpoint
ALTER TABLE "consent_records" ADD COLUMN "user_agent" text;--> statement-breakpoint
ALTER TABLE "consent_records" ADD COLUMN "actor" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "consent_records" ADD COLUMN "ref_type" text;--> statement-breakpoint
ALTER TABLE "consent_records" ADD COLUMN "ref_id" text;--> statement-breakpoint
ALTER TABLE "consent_records" ADD COLUMN "copied_from_record_id" uuid;--> statement-breakpoint
ALTER TABLE "persons" ADD COLUMN "customer_number" bigint NOT NULL GENERATED ALWAYS AS IDENTITY (sequence name "persons_customer_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1);--> statement-breakpoint
ALTER TABLE "persons" ADD COLUMN "email_hash" text;--> statement-breakpoint
ALTER TABLE "persons" ADD COLUMN "phone_e164" text;--> statement-breakpoint
ALTER TABLE "persons" ADD COLUMN "linkedin_url" text;--> statement-breakpoint
ALTER TABLE "persons" ADD COLUMN "emergency_contact" jsonb;--> statement-breakpoint
ALTER TABLE "persons" ADD COLUMN "status_override_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "persons" ADD COLUMN "external_ids" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "persons" ADD COLUMN "search_tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', coalesce(first_name, '') || ' ' || coalesce(last_name, '') || ' ' || coalesce(email, '') || ' ' || coalesce(phone_e164, ''))) STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "persons" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "suppressions" ADD COLUMN "person_id" uuid;--> statement-breakpoint
ALTER TABLE "suppressions" ADD COLUMN "actor" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_contacts" ADD CONSTRAINT "company_contacts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_contacts" ADD CONSTRAINT "company_contacts_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_wordings" ADD CONSTRAINT "consent_wordings_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_declarations" ADD CONSTRAINT "person_declarations_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_declarations" ADD CONSTRAINT "person_declarations_guardian_person_id_persons_id_fk" FOREIGN KEY ("guardian_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_duplicate_candidates" ADD CONSTRAINT "person_duplicate_candidates_person_a_id_persons_id_fk" FOREIGN KEY ("person_a_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_duplicate_candidates" ADD CONSTRAINT "person_duplicate_candidates_person_b_id_persons_id_fk" FOREIGN KEY ("person_b_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_duplicate_candidates" ADD CONSTRAINT "person_duplicate_candidates_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_merges" ADD CONSTRAINT "person_merges_winner_person_id_persons_id_fk" FOREIGN KEY ("winner_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_merges" ADD CONSTRAINT "person_merges_loser_person_id_persons_id_fk" FOREIGN KEY ("loser_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_merges" ADD CONSTRAINT "person_merges_merged_by_user_id_users_id_fk" FOREIGN KEY ("merged_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_sensitive_fields" ADD CONSTRAINT "person_sensitive_fields_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_sensitive_fields" ADD CONSTRAINT "person_sensitive_fields_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_tags" ADD CONSTRAINT "person_tags_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_tags" ADD CONSTRAINT "person_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segment_members" ADD CONSTRAINT "segment_members_segment_id_segments_id_fk" FOREIGN KEY ("segment_id") REFERENCES "public"."segments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segment_members" ADD CONSTRAINT "segment_members_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segments" ADD CONSTRAINT "segments_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_done_by_user_id_users_id_fk" FOREIGN KEY ("done_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "companies_vat_number_uq" ON "companies" USING btree ("vat_number") WHERE "companies"."vat_number" is not null;--> statement-breakpoint
CREATE INDEX "companies_name_idx" ON "companies" USING btree (lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "company_contacts_company_person_uq" ON "company_contacts" USING btree ("company_id","person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "company_contacts_primary_uq" ON "company_contacts" USING btree ("company_id") WHERE "company_contacts"."is_primary" and "company_contacts"."ended_on" is null;--> statement-breakpoint
CREATE INDEX "company_contacts_person_idx" ON "company_contacts" USING btree ("person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "consent_wordings_purpose_version_uq" ON "consent_wordings" USING btree ("purpose","version");--> statement-breakpoint
CREATE INDEX "person_declarations_person_kind_idx" ON "person_declarations" USING btree ("person_id","kind","accepted_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "person_declarations_guardian_idx" ON "person_declarations" USING btree ("guardian_person_id") WHERE "person_declarations"."guardian_person_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "person_duplicate_candidates_pair_uq" ON "person_duplicate_candidates" USING btree ("person_a_id","person_b_id");--> statement-breakpoint
CREATE INDEX "person_duplicate_candidates_status_score_idx" ON "person_duplicate_candidates" USING btree ("status","score" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "person_duplicate_candidates_person_b_idx" ON "person_duplicate_candidates" USING btree ("person_b_id");--> statement-breakpoint
CREATE INDEX "person_merges_winner_idx" ON "person_merges" USING btree ("winner_person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "person_sensitive_fields_person_key_uq" ON "person_sensitive_fields" USING btree ("person_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "person_tags_person_tag_uq" ON "person_tags" USING btree ("person_id","tag_id");--> statement-breakpoint
CREATE INDEX "person_tags_tag_idx" ON "person_tags" USING btree ("tag_id");--> statement-breakpoint
CREATE INDEX "segment_members_person_idx" ON "segment_members" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "tasks_owner_status_due_idx" ON "tasks" USING btree ("owner_user_id","status","due_at");--> statement-breakpoint
CREATE INDEX "tasks_person_idx" ON "tasks" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "tasks_company_idx" ON "tasks" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "tasks_open_due_idx" ON "tasks" USING btree ("due_at") WHERE "tasks"."status" = 'open';--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_copied_from_record_id_consent_records_id_fk" FOREIGN KEY ("copied_from_record_id") REFERENCES "public"."consent_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "persons" ADD CONSTRAINT "persons_partner_company_id_companies_id_fk" FOREIGN KEY ("partner_company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppressions" ADD CONSTRAINT "suppressions_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "persons_email_hash_idx" ON "persons" USING btree ("email_hash");--> statement-breakpoint
CREATE INDEX "persons_phone_idx" ON "persons" USING btree ("phone_e164");--> statement-breakpoint
CREATE INDEX "persons_search_gin" ON "persons" USING gin ("search_tsv");--> statement-breakpoint
CREATE INDEX "persons_external_ids_gin" ON "persons" USING gin ("external_ids" jsonb_path_ops);--> statement-breakpoint
CREATE INDEX "suppressions_person_idx" ON "suppressions" USING btree ("person_id");--> statement-breakpoint
ALTER TABLE "persons" ADD CONSTRAINT "persons_customer_number_unique" UNIQUE("customer_number");--> statement-breakpoint
ALTER TABLE "persons" ADD CONSTRAINT "persons_phone_e164_ck" CHECK ("persons"."phone_e164" ~ '^\+[1-9][0-9]{6,14}$');