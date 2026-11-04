CREATE TYPE "public"."automation_enrolments_source" AS ENUM('trigger', 'segment', 'staff', 'staff_move', 'enrol_step', 'migration', 'api');--> statement-breakpoint
CREATE TYPE "public"."automation_enrolments_status" AS ENUM('active', 'completed', 'exited');--> statement-breakpoint
CREATE TYPE "public"."automation_runs_outcome" AS ENUM('entered', 'scheduled', 'sent', 'task_created', 'tag_applied', 'tag_removed', 'field_set', 'status_set', 'enrolled', 'notified', 'webhook_called', 'branched', 'skipped_late_entry', 'skipped_condition', 'skipped_unreachable', 'skipped_translation', 'skipped_exclusive', 'skipped_paused', 'skipped_stale', 'skipped_frequency_cap', 'exited', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."campaign_recipients_status" AS ENUM('planned', 'sent', 'skipped_suppressed', 'skipped_consent', 'skipped_translation', 'skipped_unreachable', 'removed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."campaigns_paused_reason" AS ENUM('manual', 'bounce_rate');--> statement-breakpoint
CREATE TYPE "public"."campaigns_purpose" AS ENUM('newsletter', 'events', 'member_comms', 'b2b');--> statement-breakpoint
CREATE TYPE "public"."campaigns_status" AS ENUM('draft', 'planning', 'scheduled', 'sending', 'paused', 'sent', 'stopped', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."email_ai_drafts_status" AS ENUM('queued', 'ready', 'failed', 'accepted', 'discarded');--> statement-breakpoint
CREATE TYPE "public"."email_events_source" AS ENUM('resend', 'tracking');--> statement-breakpoint
CREATE TYPE "public"."email_events_type" AS ENUM('sent', 'delivered', 'delayed', 'bounced', 'complained', 'opened', 'clicked', 'failed');--> statement-breakpoint
CREATE TYPE "public"."email_messages_bounce_type" AS ENUM('hard', 'soft');--> statement-breakpoint
CREATE TYPE "public"."email_messages_from_domain" AS ENUM('mail.beam.be', 'news.beam.be');--> statement-breakpoint
CREATE TABLE "automation_enrolments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"automation_id" uuid NOT NULL,
	"automation_version_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"subject_key" text DEFAULT '' NOT NULL,
	"group_id" uuid NOT NULL,
	"exclusive_domain" text,
	"source" "automation_enrolments_source" NOT NULL,
	"trigger_event_id" bigint,
	"anchor_at" timestamp with time zone,
	"status" "automation_enrolments_status" DEFAULT 'active' NOT NULL,
	"next_step_key" text,
	"next_step_at" timestamp with time zone,
	"entered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	"plan" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"entered_by_user_id" uuid,
	"migrated_from_enrolment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_enrolments_ended_ck" CHECK (("automation_enrolments"."status" = 'active') = ("automation_enrolments"."ended_at" is null)),
	CONSTRAINT "automation_enrolments_next_step_ck" CHECK ("automation_enrolments"."status" = 'active' or "automation_enrolments"."next_step_at" is null),
	CONSTRAINT "automation_enrolments_end_reason_ck" CHECK ("automation_enrolments"."status" <> 'exited' or "automation_enrolments"."end_reason" is not null),
	CONSTRAINT "automation_enrolments_subject_key_ck" CHECK ("automation_enrolments"."subject_key" = '' or "automation_enrolments"."subject_key" ~ '^[a-z_]+:.+$')
);
--> statement-breakpoint
CREATE TABLE "automation_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_exclusive" boolean DEFAULT false NOT NULL,
	"lane" text,
	"priority" smallint DEFAULT 100 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_groups_key_unique" UNIQUE("key"),
	CONSTRAINT "automation_groups_key_ck" CHECK ("automation_groups"."key" ~ '^[a-z][a-z0-9_]*$'),
	CONSTRAINT "automation_groups_lane_ck" CHECK ("automation_groups"."lane" is null or "automation_groups"."lane" ~ '^[a-z][a-z0-9_]*$'),
	CONSTRAINT "automation_groups_priority_ck" CHECK ("automation_groups"."priority" between 0 and 1000)
);
--> statement-breakpoint
CREATE TABLE "automation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enrolment_id" uuid,
	"person_id" uuid NOT NULL,
	"automation_id" uuid NOT NULL,
	"automation_version_id" uuid,
	"step_key" text,
	"outcome" "automation_runs_outcome" NOT NULL,
	"reason" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"email_message_id" uuid,
	"task_id" uuid,
	"actor" jsonb NOT NULL,
	"dedupe_key" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_runs_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "automation_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"automation_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"definition" jsonb NOT NULL,
	"definition_hash" text NOT NULL,
	"change_note" text,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_versions_version_ck" CHECK ("automation_versions"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "campaign_recipients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"locale" text NOT NULL,
	"chunk_no" integer NOT NULL,
	"status" "campaign_recipients_status" DEFAULT 'planned' NOT NULL,
	"email_message_id" uuid,
	"removed_by_user_id" uuid,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaign_recipients_email_message_id_unique" UNIQUE("email_message_id"),
	CONSTRAINT "campaign_recipients_locale_ck" CHECK ("campaign_recipients"."locale" in ('nl-BE', 'fr-BE', 'en')),
	CONSTRAINT "campaign_recipients_chunk_ck" CHECK ("campaign_recipients"."chunk_no" >= 0),
	CONSTRAINT "campaign_recipients_removed_ck" CHECK (("campaign_recipients"."status" = 'removed') = ("campaign_recipients"."removed_by_user_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"template_id" uuid NOT NULL,
	"template_version_id" uuid,
	"segment_id" uuid,
	"exclude_segment_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"purpose" "campaigns_purpose" NOT NULL,
	"status" "campaigns_status" DEFAULT 'draft' NOT NULL,
	"scheduled_at" timestamp with time zone,
	"audience_snapshot_at" timestamp with time zone,
	"recipients_count" integer DEFAULT 0 NOT NULL,
	"sent_count" integer DEFAULT 0 NOT NULL,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"run_no" smallint DEFAULT 1 NOT NULL,
	"paused_reason" "campaigns_paused_reason",
	"test_sent_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"stopped_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"last_error" text,
	"stats_snapshot" jsonb,
	"ai_draft_id" uuid,
	"created_by_user_id" uuid NOT NULL,
	"updated_by_user_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaigns_name_ck" CHECK (length("campaigns"."name") between 1 and 160),
	CONSTRAINT "campaigns_paused_reason_ck" CHECK (("campaigns"."status" = 'paused') = ("campaigns"."paused_reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "email_ai_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid,
	"brief" text NOT NULL,
	"inputs" jsonb NOT NULL,
	"status" "email_ai_drafts_status" DEFAULT 'queued' NOT NULL,
	"output" jsonb,
	"ai_request_id" uuid,
	"error" text,
	"created_by_user_id" uuid NOT NULL,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_ai_drafts_brief_ck" CHECK (length("email_ai_drafts"."brief") between 10 and 4000)
);
--> statement-breakpoint
CREATE TABLE "email_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email_message_id" uuid NOT NULL,
	"type" "email_events_type" NOT NULL,
	"source" "email_events_source" NOT NULL,
	"resend_event_id" text,
	"url" text,
	"link_index" smallint,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_events_resend_event_id_unique" UNIQUE("resend_event_id")
);
--> statement-breakpoint
CREATE TABLE "email_template_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"subject" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"preheader" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"document" jsonb,
	"copy" jsonb,
	"react_component" text,
	"html_by_locale" jsonb,
	"text_by_locale" jsonb,
	"locales" text[] DEFAULT '{}'::text[] NOT NULL,
	"published_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"ai_draft_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_template_versions_version_ck" CHECK ("email_template_versions"."version" > 0),
	CONSTRAINT "email_template_versions_locales_ck" CHECK ("email_template_versions"."locales" <@ array['nl-BE','fr-BE','en']::text[]),
	CONSTRAINT "email_template_versions_copy_ck" CHECK (("email_template_versions"."react_component" is null) = ("email_template_versions"."copy" is null)),
	CONSTRAINT "email_template_versions_body_ck" CHECK (("email_template_versions"."react_component" is null) = ("email_template_versions"."document" is not null))
);
--> statement-breakpoint
ALTER TABLE "email_messages" DROP CONSTRAINT "email_messages_rendered_file_id_files_id_fk";
--> statement-breakpoint
ALTER TABLE "email_templates" DROP CONSTRAINT "email_templates_created_by_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "priority" smallint DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "draft_definition" jsonb;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "draft_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "draft_updated_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "activated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "last_resumed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "requires_dpia" text;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "requires_flag" text;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "created_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "email_messages" ADD COLUMN "from_domain" "email_messages_from_domain" DEFAULT 'mail.beam.be' NOT NULL;--> statement-breakpoint
ALTER TABLE "email_messages" ADD COLUMN "bounce_type" "email_messages_bounce_type";--> statement-breakpoint
ALTER TABLE "email_messages" ADD COLUMN "attempt" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "email_messages" ADD COLUMN "retry_of_message_id" uuid;--> statement-breakpoint
ALTER TABLE "email_messages" ADD COLUMN "links" jsonb;--> statement-breakpoint
ALTER TABLE "email_messages" ADD COLUMN "delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_messages" ADD COLUMN "opened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_messages" ADD COLUMN "clicked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_messages" ADD COLUMN "bounced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_messages" ADD COLUMN "complained_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_messages" ADD COLUMN "last_event_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_templates" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "automation_enrolments" ADD CONSTRAINT "automation_enrolments_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_enrolments" ADD CONSTRAINT "automation_enrolments_automation_version_id_automation_versions_id_fk" FOREIGN KEY ("automation_version_id") REFERENCES "public"."automation_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_enrolments" ADD CONSTRAINT "automation_enrolments_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_enrolments" ADD CONSTRAINT "automation_enrolments_group_id_automation_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."automation_groups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_enrolments" ADD CONSTRAINT "automation_enrolments_trigger_event_id_activity_events_id_fk" FOREIGN KEY ("trigger_event_id") REFERENCES "public"."activity_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_enrolments" ADD CONSTRAINT "automation_enrolments_entered_by_user_id_users_id_fk" FOREIGN KEY ("entered_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_enrolments" ADD CONSTRAINT "automation_enrolments_migrated_from_enrolment_id_automation_enrolments_id_fk" FOREIGN KEY ("migrated_from_enrolment_id") REFERENCES "public"."automation_enrolments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_enrolment_id_automation_enrolments_id_fk" FOREIGN KEY ("enrolment_id") REFERENCES "public"."automation_enrolments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_automation_version_id_automation_versions_id_fk" FOREIGN KEY ("automation_version_id") REFERENCES "public"."automation_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_email_message_id_email_messages_id_fk" FOREIGN KEY ("email_message_id") REFERENCES "public"."email_messages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_versions" ADD CONSTRAINT "automation_versions_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_versions" ADD CONSTRAINT "automation_versions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_email_message_id_email_messages_id_fk" FOREIGN KEY ("email_message_id") REFERENCES "public"."email_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_removed_by_user_id_users_id_fk" FOREIGN KEY ("removed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_template_id_email_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."email_templates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_template_version_id_email_template_versions_id_fk" FOREIGN KEY ("template_version_id") REFERENCES "public"."email_template_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_ai_draft_id_email_ai_drafts_id_fk" FOREIGN KEY ("ai_draft_id") REFERENCES "public"."email_ai_drafts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_ai_drafts" ADD CONSTRAINT "email_ai_drafts_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_ai_drafts" ADD CONSTRAINT "email_ai_drafts_ai_request_id_ai_requests_id_fk" FOREIGN KEY ("ai_request_id") REFERENCES "public"."ai_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_ai_drafts" ADD CONSTRAINT "email_ai_drafts_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_events" ADD CONSTRAINT "email_events_email_message_id_email_messages_id_fk" FOREIGN KEY ("email_message_id") REFERENCES "public"."email_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_template_versions" ADD CONSTRAINT "email_template_versions_template_id_email_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."email_templates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_template_versions" ADD CONSTRAINT "email_template_versions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_template_versions" ADD CONSTRAINT "email_template_versions_ai_draft_id_email_ai_drafts_id_fk" FOREIGN KEY ("ai_draft_id") REFERENCES "public"."email_ai_drafts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_enrolment_active" ON "automation_enrolments" USING btree ("automation_id","person_id","subject_key") WHERE "automation_enrolments"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_enrolment_domain" ON "automation_enrolments" USING btree ("person_id","exclusive_domain") WHERE "automation_enrolments"."status" = 'active' and "automation_enrolments"."exclusive_domain" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_enrolment_trigger" ON "automation_enrolments" USING btree ("automation_id","trigger_event_id") WHERE "automation_enrolments"."trigger_event_id" is not null;--> statement-breakpoint
CREATE INDEX "ix_enrolment_due" ON "automation_enrolments" USING btree ("next_step_at") WHERE "automation_enrolments"."status" = 'active';--> statement-breakpoint
CREATE INDEX "automation_enrolments_person_status_idx" ON "automation_enrolments" USING btree ("person_id","status");--> statement-breakpoint
CREATE INDEX "automation_enrolments_automation_status_idx" ON "automation_enrolments" USING btree ("automation_id","status","entered_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "automation_enrolments_person_automation_idx" ON "automation_enrolments" USING btree ("person_id","automation_id","entered_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "automation_runs_person_idx" ON "automation_runs" USING btree ("person_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "automation_runs_enrolment_idx" ON "automation_runs" USING btree ("enrolment_id","occurred_at");--> statement-breakpoint
CREATE INDEX "automation_runs_automation_idx" ON "automation_runs" USING btree ("automation_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "automation_runs_issues_idx" ON "automation_runs" USING btree ("occurred_at" DESC NULLS LAST) WHERE "automation_runs"."outcome" in ('failed', 'skipped_translation');--> statement-breakpoint
CREATE UNIQUE INDEX "automation_versions_automation_version_uq" ON "automation_versions" USING btree ("automation_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_recipients_campaign_person_uq" ON "campaign_recipients" USING btree ("campaign_id","person_id");--> statement-breakpoint
CREATE INDEX "campaign_recipients_chunk_idx" ON "campaign_recipients" USING btree ("campaign_id","chunk_no","status");--> statement-breakpoint
CREATE INDEX "campaign_recipients_person_idx" ON "campaign_recipients" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "campaigns_scheduled_idx" ON "campaigns" USING btree ("scheduled_at") WHERE "campaigns"."status" = 'scheduled';--> statement-breakpoint
CREATE INDEX "campaigns_status_created_idx" ON "campaigns" USING btree ("status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "email_ai_drafts_creator_created_idx" ON "email_ai_drafts" USING btree ("created_by_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "email_events_message_type_idx" ON "email_events" USING btree ("email_message_id","type");--> statement-breakpoint
CREATE INDEX "email_events_type_occurred_idx" ON "email_events" USING btree ("type","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "email_template_versions_template_version_uq" ON "email_template_versions" USING btree ("template_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "email_template_versions_one_draft_uq" ON "email_template_versions" USING btree ("template_id") WHERE "email_template_versions"."published_at" is null;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_group_id_automation_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."automation_groups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_current_version_id_automation_versions_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."automation_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_draft_updated_by_user_id_users_id_fk" FOREIGN KEY ("draft_updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_template_version_id_email_template_versions_id_fk" FOREIGN KEY ("template_version_id") REFERENCES "public"."email_template_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_retry_of_message_id_email_messages_id_fk" FOREIGN KEY ("retry_of_message_id") REFERENCES "public"."email_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_rendered_file_id_files_id_fk" FOREIGN KEY ("rendered_file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_templates" ADD CONSTRAINT "email_templates_current_version_id_email_template_versions_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."email_template_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_templates" ADD CONSTRAINT "email_templates_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_messages_domain_sent_idx" ON "email_messages" USING btree ("from_domain","sent_at");--> statement-breakpoint
CREATE INDEX "email_messages_to_email_prefix_idx" ON "email_messages" USING btree (lower("to_email") text_pattern_ops);--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_priority_ck" CHECK ("automations"."priority" between 0 and 1000);--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_paused_ck" CHECK (("automations"."paused_at" is not null) = ("automations"."status" = 'paused'));--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_requires_flag_ck" CHECK ("automations"."requires_flag" is null or "automations"."requires_flag" ~ '^ff_[a-z]+_[a-z0-9_]+$');--> statement-breakpoint
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_template_version_ck" CHECK ("email_messages"."kind" = 'transactional' or "email_messages"."template_version_id" is not null);--> statement-breakpoint
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_attempt_ck" CHECK ("email_messages"."attempt" between 1 and 2);--> statement-breakpoint
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_send_at_ck" CHECK ("email_messages"."send_at" <= "email_messages"."created_at" + interval '400 days');