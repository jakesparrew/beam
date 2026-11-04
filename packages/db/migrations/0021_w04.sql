CREATE TYPE "public"."ad_spend_daily_platform" AS ENUM('meta', 'google');--> statement-breakpoint
CREATE TYPE "public"."attribution_credits_model" AS ENUM('first_touch', 'linear');--> statement-breakpoint
CREATE TYPE "public"."data_exports_kind" AS ENUM('entity', 'full');--> statement-breakpoint
CREATE TYPE "public"."data_exports_status" AS ENUM('queued', 'running', 'done', 'failed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."dpia_records_key" AS ENUM('sensitive_assessment_processing', 'behavioural_scoring', 'ai_customer_ranking', 'watch_time_profiling', 'b2b_prospecting', 'voice_ai');--> statement-breakpoint
CREATE TYPE "public"."dpia_records_status" AS ENUM('not_started', 'in_progress', 'approved', 'rejected', 'not_required');--> statement-breakpoint
CREATE TYPE "public"."import_rows_status" AS ENUM('pending', 'imported', 'updated', 'skipped', 'error');--> statement-breakpoint
CREATE TYPE "public"."imported_history_kind" AS ENUM('purchase', 'visit', 'no_show', 'cancellation', 'event_attendance', 'webinar_registration', 'webinar_attendance', 'assessment_result', 'email_engagement');--> statement-breakpoint
CREATE TYPE "public"."imports_kind" AS ENUM('persons', 'suppressions', 'consents', 'tags', 'companies', 'bookings', 'packages', 'memberships', 'history');--> statement-breakpoint
CREATE TYPE "public"."imports_source" AS ENUM('simplybook', 'lightspeed', 'mailchimp', 'spreadsheet', 'event_db', 'b2b_list', 'webinar_tool', 'assessment_tool', 'other');--> statement-breakpoint
CREATE TYPE "public"."imports_status" AS ENUM('uploaded', 'dry_run', 'running', 'done', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."management_summaries_status" AS ENUM('pending', 'ready', 'failed', 'skipped_budget');--> statement-breakpoint
CREATE TYPE "public"."nl_questions_status" AS ENUM('answered', 'refused', 'error', 'timeout', 'budget_exceeded');--> statement-breakpoint
CREATE TYPE "public"."person_stats_b2c_stage" AS ENUM('lead', 'engaged_lead', 'experienced', 'first_visit', 'first_purchase', 'active', 'repeat', 'member', 'retention', 'lost');--> statement-breakpoint
CREATE TYPE "public"."privacy_requests_kind" AS ENUM('export', 'erase', 'restrict', 'rectify', 'object');--> statement-breakpoint
CREATE TYPE "public"."privacy_requests_requested_by" AS ENUM('customer', 'staff', 'system');--> statement-breakpoint
CREATE TYPE "public"."privacy_requests_status" AS ENUM('received', 'verified', 'running', 'done', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."retention_policies_action" AS ENUM('anonymise', 'delete', 'keep');--> statement-breakpoint
CREATE TABLE "ad_spend_daily" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform" "ad_spend_daily_platform" NOT NULL,
	"account_id" text NOT NULL,
	"campaign_external_id" text NOT NULL,
	"campaign_name" text NOT NULL,
	"day_on" date NOT NULL,
	"spend_cents" integer NOT NULL,
	"impressions" integer DEFAULT 0 NOT NULL,
	"clicks" integer DEFAULT 0 NOT NULL,
	"leads" integer DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'EUR' NOT NULL,
	"raw" jsonb NOT NULL,
	"pulled_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ad_spend_daily_uq" UNIQUE("platform","campaign_external_id","day_on"),
	CONSTRAINT "ad_spend_daily_amounts_ck" CHECK ("ad_spend_daily"."spend_cents" >= 0 and "ad_spend_daily"."impressions" >= 0 and "ad_spend_daily"."clicks" >= 0 and "ad_spend_daily"."leads" >= 0),
	CONSTRAINT "ad_spend_daily_currency_ck" CHECK ("ad_spend_daily"."currency" = 'EUR')
);
--> statement-breakpoint
CREATE TABLE "attribution_credits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"model" "attribution_credits_model" NOT NULL,
	"campaign_key" text NOT NULL,
	"source" text,
	"medium" text,
	"campaign" text,
	"weight" numeric(5, 4) NOT NULL,
	"revenue_cents" integer NOT NULL,
	"paid_at" timestamp with time zone NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attribution_credits_uq" UNIQUE("order_id","model","campaign_key"),
	CONSTRAINT "attribution_credits_weight_ck" CHECK ("attribution_credits"."weight" > 0 and "attribution_credits"."weight" <= 1)
);
--> statement-breakpoint
CREATE TABLE "cutover_checklist_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"done_at" timestamp with time zone,
	"done_by_user_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cutover_checklist_items_key_uq" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "dashboards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"definition" jsonb NOT NULL,
	"is_shared" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dashboards_name_ck" CHECK (char_length("dashboards"."name") between 1 and 120)
);
--> statement-breakpoint
CREATE TABLE "data_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "data_exports_kind" NOT NULL,
	"entity" text,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "data_exports_status" DEFAULT 'queued' NOT NULL,
	"part_file_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"cursor" jsonb,
	"created_by_user_id" uuid NOT NULL,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_exports_entity_ck" CHECK (("data_exports"."kind" = 'entity') = ("data_exports"."entity" is not null)),
	CONSTRAINT "data_exports_entity_list_ck" CHECK ("data_exports"."entity" is null or "data_exports"."entity" in ('persons', 'companies', 'company_contacts', 'tags', 'consents', 'suppressions', 'bookings', 'sessions', 'orders', 'order_lines', 'payments', 'refunds', 'invoices', 'credit_grants', 'credit_entries', 'memberships', 'form_submissions', 'email_messages', 'campaigns', 'tasks', 'activity_events')),
	CONSTRAINT "data_exports_row_count_ck" CHECK ("data_exports"."row_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "dpia_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" "dpia_records_key" NOT NULL,
	"status" "dpia_records_status" DEFAULT 'not_started' NOT NULL,
	"purpose" text,
	"risks" text,
	"measures" text,
	"decision_note" text,
	"document_file_id" uuid,
	"reviewed_by_user_id" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dpia_records_key_uq" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "import_external_ids" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" "imports_source" NOT NULL,
	"entity_type" text NOT NULL,
	"external_id" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"import_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_external_ids_uq" UNIQUE("source","entity_type","external_id"),
	CONSTRAINT "import_external_ids_entity_type_ck" CHECK ("import_external_ids"."entity_type" in ('person', 'company', 'booking', 'grant', 'membership'))
);
--> statement-breakpoint
CREATE TABLE "import_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"import_id" uuid NOT NULL,
	"row_number" integer NOT NULL,
	"data" jsonb NOT NULL,
	"status" "import_rows_status" DEFAULT 'pending' NOT NULL,
	"dry_run_status" "import_rows_status",
	"message" text,
	"person_id" uuid,
	"entity_type" text,
	"entity_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_rows_import_row_uq" UNIQUE("import_id","row_number"),
	CONSTRAINT "import_rows_entity_type_ck" CHECK ("import_rows"."entity_type" is null or "import_rows"."entity_type" in ('person', 'company', 'booking', 'grant', 'membership', 'suppression', 'consent', 'tag', 'history')),
	CONSTRAINT "import_rows_row_number_ck" CHECK ("import_rows"."row_number" >= 1)
);
--> statement-breakpoint
CREATE TABLE "imported_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"import_id" uuid NOT NULL,
	"source" "imports_source" NOT NULL,
	"kind" "imported_history_kind" NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"external_id" text NOT NULL,
	"description" text,
	"amount_cents" integer,
	"product_kind" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "imported_history_source_kind_external_uq" UNIQUE("source","kind","external_id"),
	CONSTRAINT "imported_history_product_kind_ck" CHECK ("imported_history"."product_kind" is null or "imported_history"."product_kind" in ('session', 'night', 'package', 'membership', 'ticket', 'item', 'voucher'))
);
--> statement-breakpoint
CREATE TABLE "imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "imports_kind" NOT NULL,
	"source" "imports_source" NOT NULL,
	"name" text NOT NULL,
	"file_id" uuid NOT NULL,
	"part_file_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"status" "imports_status" DEFAULT 'uploaded' NOT NULL,
	"header" text[] DEFAULT '{}'::text[] NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_dry_run" boolean DEFAULT true NOT NULL,
	"run_seq" integer DEFAULT 0 NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"report" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reconciliation" jsonb,
	"signed_off_by_user_id" uuid,
	"signed_off_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "imports_name_ck" CHECK (char_length("imports"."name") between 1 and 120),
	CONSTRAINT "imports_sign_off_ck" CHECK (("imports"."signed_off_by_user_id" is null) = ("imports"."signed_off_at" is null)),
	CONSTRAINT "imports_counts_ck" CHECK ("imports"."row_count" >= 0 and "imports"."run_seq" >= 0)
);
--> statement-breakpoint
CREATE TABLE "management_summaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"week_start_on" date NOT NULL,
	"kpis" jsonb NOT NULL,
	"summary" jsonb NOT NULL,
	"status" "management_summaries_status" DEFAULT 'pending' NOT NULL,
	"batch_id" text,
	"ai_request_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "management_summaries_week_uq" UNIQUE("week_start_on")
);
--> statement-breakpoint
CREATE TABLE "nl_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"question" text NOT NULL,
	"generated_sql" text,
	"status" "nl_questions_status" NOT NULL,
	"row_count" integer,
	"columns" text[] DEFAULT '{}'::text[] NOT NULL,
	"explanation" text,
	"ai_request_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nl_questions_question_ck" CHECK (char_length("nl_questions"."question") <= 500)
);
--> statement-breakpoint
CREATE TABLE "ops_state" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "person_stats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"revenue_cents" integer DEFAULT 0 NOT NULL,
	"purchases" integer DEFAULT 0 NOT NULL,
	"visits" integer DEFAULT 0 NOT NULL,
	"visits_last_60d" integer DEFAULT 0 NOT NULL,
	"visits_prev_180d" integer DEFAULT 0 NOT NULL,
	"events_attended" integer DEFAULT 0 NOT NULL,
	"no_shows" integer DEFAULT 0 NOT NULL,
	"late_cancellations" integer DEFAULT 0 NOT NULL,
	"avg_order_cents" integer DEFAULT 0 NOT NULL,
	"first_purchase_at" timestamp with time zone,
	"last_purchase_at" timestamp with time zone,
	"first_visit_at" timestamp with time zone,
	"last_visit_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone,
	"next_booking_at" timestamp with time zone,
	"b2c_stage" "person_stats_b2c_stage" DEFAULT 'lead' NOT NULL,
	"b2c_stage_changed_at" timestamp with time zone,
	"predicted_value_cents" integer,
	"churn_probability" numeric(4, 3),
	"repurchase_probability" numeric(4, 3),
	"predicted_at" timestamp with time zone,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "person_stats_person_uq" UNIQUE("person_id"),
	CONSTRAINT "person_stats_purchases_ck" CHECK ("person_stats"."purchases" >= 0),
	CONSTRAINT "person_stats_visits_ck" CHECK ("person_stats"."visits" >= 0),
	CONSTRAINT "person_stats_counts_ck" CHECK ("person_stats"."visits_last_60d" >= 0 and "person_stats"."visits_prev_180d" >= 0 and "person_stats"."events_attended" >= 0 and "person_stats"."no_shows" >= 0 and "person_stats"."late_cancellations" >= 0),
	CONSTRAINT "person_stats_churn_ck" CHECK ("person_stats"."churn_probability" is null or "person_stats"."churn_probability" between 0 and 1),
	CONSTRAINT "person_stats_repurchase_ck" CHECK ("person_stats"."repurchase_probability" is null or "person_stats"."repurchase_probability" between 0 and 1)
);
--> statement-breakpoint
CREATE TABLE "privacy_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"kind" "privacy_requests_kind" NOT NULL,
	"status" "privacy_requests_status" DEFAULT 'received' NOT NULL,
	"requested_by" "privacy_requests_requested_by" NOT NULL,
	"due_on" date NOT NULL,
	"verified_at" timestamp with time zone,
	"verified_by_user_id" uuid,
	"verification_note" text,
	"scheduled_for_at" timestamp with time zone,
	"rectify_fields" text[] DEFAULT '{}'::text[] NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"needs_manual_followup" boolean DEFAULT false NOT NULL,
	"run_attempt" smallint DEFAULT 1 NOT NULL,
	"report" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"file_id" uuid,
	"part_file_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"created_by_user_id" uuid,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "privacy_requests_note_ck" CHECK ("privacy_requests"."verification_note" is null or char_length("privacy_requests"."verification_note") <= 500),
	CONSTRAINT "privacy_requests_run_attempt_ck" CHECK ("privacy_requests"."run_attempt" >= 1)
);
--> statement-breakpoint
CREATE TABLE "processing_restrictions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"privacy_request_id" uuid,
	"reason" text DEFAULT 'accuracy_contested' NOT NULL,
	"started_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processing_restrictions_person_uq" UNIQUE("person_id"),
	CONSTRAINT "processing_restrictions_reason_ck" CHECK ("processing_restrictions"."reason" in ('accuracy_contested', 'unlawful_processing', 'needed_for_legal_claims', 'objection_pending'))
);
--> statement-breakpoint
CREATE TABLE "retention_list_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"list_id" uuid NOT NULL,
	"rank" smallint NOT NULL,
	"person_id" uuid NOT NULL,
	"score" integer NOT NULL,
	"primary_reason" text NOT NULL,
	"reasons" text[] NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"task_id" uuid,
	"actioned_at" timestamp with time zone,
	"actioned_by_user_id" uuid,
	"dismissed_at" timestamp with time zone,
	"dismiss_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retention_list_items_person_uq" UNIQUE("list_id","person_id"),
	CONSTRAINT "retention_list_items_rank_uq" UNIQUE("list_id","rank"),
	CONSTRAINT "retention_list_items_rank_ck" CHECK ("retention_list_items"."rank" between 1 and 100)
);
--> statement-breakpoint
CREATE TABLE "retention_lists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"week_start_on" date NOT NULL,
	"size" smallint NOT NULL,
	"thresholds" jsonb NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retention_lists_week_uq" UNIQUE("week_start_on")
);
--> statement-breakpoint
CREATE TABLE "retention_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"table_name" text NOT NULL,
	"days" integer,
	"action" "retention_policies_action" NOT NULL,
	"description" text NOT NULL,
	"run_order" smallint DEFAULT 100 NOT NULL,
	"batch_size" integer DEFAULT 1000 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_run_rows" integer,
	"last_run_status" text,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retention_policies_key_uq" UNIQUE("key"),
	CONSTRAINT "retention_policies_key_ck" CHECK ("retention_policies"."key" ~ '^[a-z]+\.[a-z][a-z0-9_]*$'),
	CONSTRAINT "retention_policies_days_ck" CHECK (("retention_policies"."action" = 'keep') = ("retention_policies"."days" is null) and ("retention_policies"."days" is null or "retention_policies"."days" >= 1)),
	CONSTRAINT "retention_policies_batch_ck" CHECK ("retention_policies"."batch_size" >= 1),
	CONSTRAINT "retention_policies_status_ck" CHECK ("retention_policies"."last_run_status" is null or "retention_policies"."last_run_status" in ('ok', 'no_handler', 'error'))
);
--> statement-breakpoint
ALTER TABLE "attribution_credits" ADD CONSTRAINT "attribution_credits_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attribution_credits" ADD CONSTRAINT "attribution_credits_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cutover_checklist_items" ADD CONSTRAINT "cutover_checklist_items_done_by_user_id_users_id_fk" FOREIGN KEY ("done_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboards" ADD CONSTRAINT "dashboards_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_exports" ADD CONSTRAINT "data_exports_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dpia_records" ADD CONSTRAINT "dpia_records_document_file_id_files_id_fk" FOREIGN KEY ("document_file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dpia_records" ADD CONSTRAINT "dpia_records_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_external_ids" ADD CONSTRAINT "import_external_ids_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imported_history" ADD CONSTRAINT "imported_history_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imported_history" ADD CONSTRAINT "imported_history_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_signed_off_by_user_id_users_id_fk" FOREIGN KEY ("signed_off_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nl_questions" ADD CONSTRAINT "nl_questions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_stats" ADD CONSTRAINT "person_stats_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_requests" ADD CONSTRAINT "privacy_requests_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_requests" ADD CONSTRAINT "privacy_requests_verified_by_user_id_users_id_fk" FOREIGN KEY ("verified_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_requests" ADD CONSTRAINT "privacy_requests_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_requests" ADD CONSTRAINT "privacy_requests_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_restrictions" ADD CONSTRAINT "processing_restrictions_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_restrictions" ADD CONSTRAINT "processing_restrictions_privacy_request_id_privacy_requests_id_fk" FOREIGN KEY ("privacy_request_id") REFERENCES "public"."privacy_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_restrictions" ADD CONSTRAINT "processing_restrictions_started_by_user_id_users_id_fk" FOREIGN KEY ("started_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_list_items" ADD CONSTRAINT "retention_list_items_list_id_retention_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."retention_lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_list_items" ADD CONSTRAINT "retention_list_items_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_list_items" ADD CONSTRAINT "retention_list_items_actioned_by_user_id_users_id_fk" FOREIGN KEY ("actioned_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_policies" ADD CONSTRAINT "retention_policies_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ad_spend_daily_day_idx" ON "ad_spend_daily" USING btree ("day_on");--> statement-breakpoint
CREATE INDEX "attribution_credits_campaign_idx" ON "attribution_credits" USING btree ("campaign_key","paid_at");--> statement-breakpoint
CREATE INDEX "attribution_credits_person_idx" ON "attribution_credits" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "dashboards_owner_idx" ON "dashboards" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "data_exports_creator_idx" ON "data_exports" USING btree ("created_by_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "import_external_ids_entity_idx" ON "import_external_ids" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "import_rows_import_status_idx" ON "import_rows" USING btree ("import_id","status");--> statement-breakpoint
CREATE INDEX "import_rows_person_idx" ON "import_rows" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "imported_history_person_kind_idx" ON "imported_history" USING btree ("person_id","kind","occurred_at");--> statement-breakpoint
CREATE INDEX "imports_status_created_idx" ON "imports" USING btree ("status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "imports_kind_idx" ON "imports" USING btree ("kind");--> statement-breakpoint
CREATE UNIQUE INDEX "imports_one_running" ON "imports" USING btree ((true)) WHERE "imports"."status" = 'running';--> statement-breakpoint
CREATE INDEX "nl_questions_user_idx" ON "nl_questions" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "person_stats_stage_idx" ON "person_stats" USING btree ("b2c_stage");--> statement-breakpoint
CREATE INDEX "person_stats_last_visit_idx" ON "person_stats" USING btree ("last_visit_at");--> statement-breakpoint
CREATE INDEX "person_stats_revenue_idx" ON "person_stats" USING btree ("revenue_cents");--> statement-breakpoint
CREATE INDEX "person_stats_next_booking_idx" ON "person_stats" USING btree ("next_booking_at");--> statement-breakpoint
CREATE UNIQUE INDEX "privacy_requests_open_uq" ON "privacy_requests" USING btree ("person_id","kind") WHERE "privacy_requests"."status" in ('received', 'verified', 'running');--> statement-breakpoint
CREATE INDEX "privacy_requests_status_due_idx" ON "privacy_requests" USING btree ("status","due_on");--> statement-breakpoint
CREATE INDEX "privacy_requests_person_idx" ON "privacy_requests" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "retention_list_items_person_idx" ON "retention_list_items" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "retention_policies_order_idx" ON "retention_policies" USING btree ("run_order");