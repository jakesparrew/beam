CREATE TYPE "public"."watch_segments_mode" AS ENUM('live', 'replay', 'on_demand');--> statement-breakpoint
CREATE TYPE "public"."webinar_interactions_kind" AS ENUM('started', 'poll_answer', 'cta_shown', 'cta_clicked', 'chat', 'question', 'ended');--> statement-breakpoint
CREATE TYPE "public"."webinar_interactions_mode" AS ENUM('live', 'replay', 'on_demand');--> statement-breakpoint
CREATE TYPE "public"."webinar_moderation_actions_action" AS ENUM('hide_message', 'unhide_message', 'mark_answered', 'mute_viewer', 'unmute_viewer', 'block_viewer', 'unblock_viewer');--> statement-breakpoint
CREATE TYPE "public"."webinar_presenters_role" AS ENUM('host', 'presenter', 'moderator');--> statement-breakpoint
CREATE TYPE "public"."webinar_registrations_person_status" AS ENUM('lead', 'customer', 'member');--> statement-breakpoint
CREATE TYPE "public"."webinar_registrations_registered_mode" AS ENUM('live', 'replay', 'on_demand');--> statement-breakpoint
CREATE TYPE "public"."webinar_registrations_source" AS ENUM('site', 'portal', 'admin', 'automation');--> statement-breakpoint
CREATE TYPE "public"."webinar_registrations_status" AS ENUM('registered', 'cancelled', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."webinars_mode" AS ENUM('live', 'simulive', 'on_demand');--> statement-breakpoint
CREATE TYPE "public"."webinars_status" AS ENUM('draft', 'published', 'live', 'ended', 'cancelled', 'archived');--> statement-breakpoint
CREATE TABLE "watch_segments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"registration_id" uuid NOT NULL,
	"webinar_id" uuid NOT NULL,
	"mode" "watch_segments_mode" NOT NULL,
	"view_id" uuid NOT NULL,
	"from_sec" integer NOT NULL,
	"to_sec" integer NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watch_segments_from_ck" CHECK ("watch_segments"."from_sec" >= 0),
	CONSTRAINT "watch_segments_span_ck" CHECK ("watch_segments"."to_sec" > "watch_segments"."from_sec" and "watch_segments"."to_sec" - "watch_segments"."from_sec" <= 30)
);
--> statement-breakpoint
CREATE TABLE "webinar_ctas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"webinar_id" uuid NOT NULL,
	"key" text NOT NULL,
	"label" jsonb NOT NULL,
	"url" text NOT NULL,
	"show_at_sec" integer,
	"show_for_sec" integer DEFAULT 300 NOT NULL,
	"live_shown_at" timestamp with time zone,
	"live_hidden_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webinar_ctas_webinar_key_uq" UNIQUE("webinar_id","key"),
	CONSTRAINT "webinar_ctas_key_ck" CHECK ("webinar_ctas"."key" ~ '^[a-z0-9_]{1,40}$'),
	CONSTRAINT "webinar_ctas_url_ck" CHECK ("webinar_ctas"."url" like 'https://%' and length("webinar_ctas"."url") <= 2000),
	CONSTRAINT "webinar_ctas_show_at_ck" CHECK ("webinar_ctas"."show_at_sec" >= 0),
	CONSTRAINT "webinar_ctas_show_for_ck" CHECK ("webinar_ctas"."show_for_sec" between 15 and 7200)
);
--> statement-breakpoint
CREATE TABLE "webinar_interactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"registration_id" uuid NOT NULL,
	"webinar_id" uuid NOT NULL,
	"mode" "webinar_interactions_mode" NOT NULL,
	"kind" "webinar_interactions_kind" NOT NULL,
	"poll_id" uuid,
	"cta_id" uuid,
	"view_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at_sec" integer,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webinar_interactions_poll_ck" CHECK (("webinar_interactions"."kind" = 'poll_answer') = ("webinar_interactions"."poll_id" is not null)),
	CONSTRAINT "webinar_interactions_cta_ck" CHECK (("webinar_interactions"."kind" in ('cta_shown','cta_clicked')) = ("webinar_interactions"."cta_id" is not null)),
	CONSTRAINT "webinar_interactions_at_sec_ck" CHECK ("webinar_interactions"."at_sec" >= 0),
	CONSTRAINT "webinar_interactions_text_ck" CHECK ("webinar_interactions"."kind" not in ('chat','question') or char_length(coalesce("webinar_interactions"."payload"->>'text', '')) between 1 and 500)
);
--> statement-breakpoint
CREATE TABLE "webinar_moderation_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"webinar_id" uuid NOT NULL,
	"interaction_id" uuid,
	"registration_id" uuid NOT NULL,
	"action" "webinar_moderation_actions_action" NOT NULL,
	"by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webinar_moderation_actions_message_ck" CHECK ("webinar_moderation_actions"."action" not in ('hide_message','unhide_message','mark_answered') or "webinar_moderation_actions"."interaction_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "webinar_polls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"webinar_id" uuid NOT NULL,
	"key" text NOT NULL,
	"question" jsonb NOT NULL,
	"options" jsonb NOT NULL,
	"allow_multiple" boolean DEFAULT false NOT NULL,
	"show_at_sec" integer,
	"show_for_sec" integer DEFAULT 120 NOT NULL,
	"live_launched_at" timestamp with time zone,
	"live_closed_at" timestamp with time zone,
	"tag_rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webinar_polls_webinar_key_uq" UNIQUE("webinar_id","key"),
	CONSTRAINT "webinar_polls_key_ck" CHECK ("webinar_polls"."key" ~ '^[a-z0-9_]{1,40}$'),
	CONSTRAINT "webinar_polls_options_ck" CHECK (jsonb_typeof("webinar_polls"."options") = 'array' and jsonb_array_length("webinar_polls"."options") between 2 and 8),
	CONSTRAINT "webinar_polls_tag_rules_ck" CHECK (jsonb_typeof("webinar_polls"."tag_rules") = 'array'),
	CONSTRAINT "webinar_polls_show_at_ck" CHECK ("webinar_polls"."show_at_sec" >= 0),
	CONSTRAINT "webinar_polls_show_for_ck" CHECK ("webinar_polls"."show_for_sec" between 15 and 1800)
);
--> statement-breakpoint
CREATE TABLE "webinar_presenters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"webinar_id" uuid NOT NULL,
	"user_id" uuid,
	"person_id" uuid,
	"display_name" text NOT NULL,
	"role" "webinar_presenters_role" DEFAULT 'presenter' NOT NULL,
	"sort_order" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webinar_presenters_identity_ck" CHECK (num_nonnulls("webinar_presenters"."user_id", "webinar_presenters"."person_id") = 1),
	CONSTRAINT "webinar_presenters_display_name_ck" CHECK (length("webinar_presenters"."display_name") between 1 and 120)
);
--> statement-breakpoint
CREATE TABLE "webinar_registrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"webinar_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"access_token_hash" text NOT NULL,
	"token_version" smallint DEFAULT 1 NOT NULL,
	"registered_mode" "webinar_registrations_registered_mode" NOT NULL,
	"status" "webinar_registrations_status" DEFAULT 'registered' NOT NULL,
	"source" "webinar_registrations_source" NOT NULL,
	"locale" "locale" NOT NULL,
	"person_status" "webinar_registrations_person_status" NOT NULL,
	"utm" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"access_emails_sent" smallint DEFAULT 0 NOT NULL,
	"last_access_email_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"blocked_at" timestamp with time zone,
	"blocked_by_user_id" uuid,
	"muted_at" timestamp with time zone,
	"muted_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webinar_registrations_webinar_person_uq" UNIQUE("webinar_id","person_id"),
	CONSTRAINT "webinar_registrations_token_hash_uq" UNIQUE("access_token_hash"),
	CONSTRAINT "webinar_registrations_blocked_ck" CHECK ("webinar_registrations"."status" <> 'blocked' or "webinar_registrations"."blocked_at" is not null),
	CONSTRAINT "webinar_registrations_cancelled_ck" CHECK ("webinar_registrations"."status" <> 'cancelled' or "webinar_registrations"."cancelled_at" is not null),
	CONSTRAINT "webinar_registrations_token_version_ck" CHECK ("webinar_registrations"."token_version" >= 1),
	CONSTRAINT "webinar_registrations_access_emails_ck" CHECK ("webinar_registrations"."access_emails_sent" >= 0)
);
--> statement-breakpoint
CREATE TABLE "webinars" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"session_id" uuid,
	"series_key" text,
	"title" jsonb NOT NULL,
	"description" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"locales" text[] DEFAULT '{nl-BE,fr-BE,en}'::text[] NOT NULL,
	"spoken_locale" "locale" DEFAULT 'nl-BE' NOT NULL,
	"mode" "webinars_mode" NOT NULL,
	"status" "webinars_status" DEFAULT 'draft' NOT NULL,
	"starts_at" timestamp with time zone,
	"planned_duration_minutes" smallint DEFAULT 60 NOT NULL,
	"duration_sec" integer,
	"youtube_video_id" text,
	"youtube_stream_id" text,
	"youtube_lifecycle" text,
	"recording_video_id" text,
	"host_meet_url" text,
	"meet_space_name" text,
	"publish_requested_at" timestamp with time zone,
	"broadcast_error" text,
	"published_at" timestamp with time zone,
	"live_started_at" timestamp with time zone,
	"live_ended_at" timestamp with time zone,
	"finalised_at" timestamp with time zone,
	"is_replay_enabled" boolean DEFAULT true NOT NULL,
	"is_replay_gated" boolean DEFAULT true NOT NULL,
	"replay_until_at" timestamp with time zone,
	"replay_view_limit" smallint,
	"on_demand_access_days" smallint,
	"attended_min_sec" integer DEFAULT 300 NOT NULL,
	"conversion_window_days" smallint DEFAULT 30 NOT NULL,
	"is_chat_enabled" boolean DEFAULT true NOT NULL,
	"is_questions_enabled" boolean DEFAULT true NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"cancelled_reason" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webinars_slug_uq" UNIQUE("slug"),
	CONSTRAINT "webinars_session_uq" UNIQUE("session_id"),
	CONSTRAINT "webinars_slug_ck" CHECK ("webinars"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length("webinars"."slug") <= 80),
	CONSTRAINT "webinars_series_key_ck" CHECK ("webinars"."series_key" ~ '^[a-z0-9-]{3,60}$'),
	CONSTRAINT "webinars_locales_ck" CHECK ("webinars"."locales" <@ array['nl-BE','fr-BE','en']::text[] and cardinality("webinars"."locales") >= 1),
	CONSTRAINT "webinars_starts_at_ck" CHECK ("webinars"."mode" <> 'on_demand' or "webinars"."starts_at" is null),
	CONSTRAINT "webinars_planned_duration_ck" CHECK ("webinars"."planned_duration_minutes" between 5 and 480),
	CONSTRAINT "webinars_duration_sec_ck" CHECK ("webinars"."duration_sec" > 0),
	CONSTRAINT "webinars_youtube_video_id_ck" CHECK ("webinars"."youtube_video_id" ~ '^[A-Za-z0-9_-]{11}$'),
	CONSTRAINT "webinars_recording_video_id_ck" CHECK ("webinars"."recording_video_id" ~ '^[A-Za-z0-9_-]{11}$'),
	CONSTRAINT "webinars_host_meet_url_ck" CHECK ("webinars"."host_meet_url" like 'https://meet.google.com/%'),
	CONSTRAINT "webinars_replay_until_ck" CHECK ("webinars"."replay_until_at" is null or "webinars"."starts_at" is null or "webinars"."replay_until_at" > "webinars"."starts_at"),
	CONSTRAINT "webinars_replay_view_limit_ck" CHECK ("webinars"."replay_view_limit" between 1 and 50),
	CONSTRAINT "webinars_on_demand_access_days_ck" CHECK ("webinars"."on_demand_access_days" between 1 and 365),
	CONSTRAINT "webinars_attended_min_sec_ck" CHECK ("webinars"."attended_min_sec" between 60 and 3600),
	CONSTRAINT "webinars_conversion_window_days_ck" CHECK ("webinars"."conversion_window_days" between 1 and 365),
	CONSTRAINT "ck_webinars_scheduled" CHECK ("webinars"."status" in ('draft','cancelled') or "webinars"."mode" = 'on_demand' or ("webinars"."starts_at" is not null and "webinars"."session_id" is not null)),
	CONSTRAINT "ck_webinars_video" CHECK ("webinars"."status" = 'draft' or "webinars"."mode" = 'live' or "webinars"."recording_video_id" is not null),
	CONSTRAINT "ck_webinars_live_video" CHECK ("webinars"."status" in ('draft','cancelled') or "webinars"."mode" <> 'live' or "webinars"."youtube_video_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "watch_segments" ADD CONSTRAINT "watch_segments_registration_id_webinar_registrations_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."webinar_registrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch_segments" ADD CONSTRAINT "watch_segments_webinar_id_webinars_id_fk" FOREIGN KEY ("webinar_id") REFERENCES "public"."webinars"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webinar_ctas" ADD CONSTRAINT "webinar_ctas_webinar_id_webinars_id_fk" FOREIGN KEY ("webinar_id") REFERENCES "public"."webinars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webinar_interactions" ADD CONSTRAINT "webinar_interactions_registration_id_webinar_registrations_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."webinar_registrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webinar_interactions" ADD CONSTRAINT "webinar_interactions_webinar_id_webinars_id_fk" FOREIGN KEY ("webinar_id") REFERENCES "public"."webinars"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webinar_interactions" ADD CONSTRAINT "webinar_interactions_poll_id_webinar_polls_id_fk" FOREIGN KEY ("poll_id") REFERENCES "public"."webinar_polls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webinar_interactions" ADD CONSTRAINT "webinar_interactions_cta_id_webinar_ctas_id_fk" FOREIGN KEY ("cta_id") REFERENCES "public"."webinar_ctas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webinar_moderation_actions" ADD CONSTRAINT "webinar_moderation_actions_webinar_id_webinars_id_fk" FOREIGN KEY ("webinar_id") REFERENCES "public"."webinars"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webinar_moderation_actions" ADD CONSTRAINT "webinar_moderation_actions_interaction_id_webinar_interactions_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."webinar_interactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webinar_moderation_actions" ADD CONSTRAINT "webinar_moderation_actions_registration_id_webinar_registrations_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."webinar_registrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webinar_moderation_actions" ADD CONSTRAINT "webinar_moderation_actions_by_user_id_users_id_fk" FOREIGN KEY ("by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webinar_polls" ADD CONSTRAINT "webinar_polls_webinar_id_webinars_id_fk" FOREIGN KEY ("webinar_id") REFERENCES "public"."webinars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webinar_presenters" ADD CONSTRAINT "webinar_presenters_webinar_id_webinars_id_fk" FOREIGN KEY ("webinar_id") REFERENCES "public"."webinars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webinar_presenters" ADD CONSTRAINT "webinar_presenters_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webinar_presenters" ADD CONSTRAINT "webinar_presenters_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webinar_registrations" ADD CONSTRAINT "webinar_registrations_webinar_id_webinars_id_fk" FOREIGN KEY ("webinar_id") REFERENCES "public"."webinars"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webinar_registrations" ADD CONSTRAINT "webinar_registrations_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webinar_registrations" ADD CONSTRAINT "webinar_registrations_blocked_by_user_id_users_id_fk" FOREIGN KEY ("blocked_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webinar_registrations" ADD CONSTRAINT "webinar_registrations_muted_by_user_id_users_id_fk" FOREIGN KEY ("muted_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webinars" ADD CONSTRAINT "webinars_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webinars" ADD CONSTRAINT "webinars_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webinars" ADD CONSTRAINT "webinars_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "watch_segments_registration_mode_idx" ON "watch_segments" USING btree ("registration_id","mode","from_sec");--> statement-breakpoint
CREATE INDEX "watch_segments_webinar_mode_idx" ON "watch_segments" USING btree ("webinar_id","mode","recorded_at");--> statement-breakpoint
CREATE INDEX "watch_segments_recorded_idx" ON "watch_segments" USING btree ("recorded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_poll_answer_once" ON "webinar_interactions" USING btree ("registration_id","poll_id","mode") WHERE "webinar_interactions"."kind" = 'poll_answer';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_cta_shown_once" ON "webinar_interactions" USING btree ("registration_id","cta_id","mode") WHERE "webinar_interactions"."kind" = 'cta_shown';--> statement-breakpoint
CREATE INDEX "webinar_interactions_webinar_kind_mode_idx" ON "webinar_interactions" USING btree ("webinar_id","kind","mode");--> statement-breakpoint
CREATE INDEX "webinar_interactions_messages_idx" ON "webinar_interactions" USING btree ("webinar_id","occurred_at") WHERE "webinar_interactions"."kind" in ('chat','question');--> statement-breakpoint
CREATE INDEX "webinar_interactions_registration_kind_mode_idx" ON "webinar_interactions" USING btree ("registration_id","kind","mode");--> statement-breakpoint
CREATE INDEX "webinar_interactions_occurred_idx" ON "webinar_interactions" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "webinar_moderation_actions_webinar_created_idx" ON "webinar_moderation_actions" USING btree ("webinar_id","created_at");--> statement-breakpoint
CREATE INDEX "webinar_moderation_actions_registration_idx" ON "webinar_moderation_actions" USING btree ("registration_id");--> statement-breakpoint
CREATE UNIQUE INDEX "webinar_presenters_identity_uq" ON "webinar_presenters" USING btree ("webinar_id",coalesce("user_id", "person_id"));--> statement-breakpoint
CREATE INDEX "webinar_presenters_person_idx" ON "webinar_presenters" USING btree ("person_id") WHERE "webinar_presenters"."person_id" is not null;--> statement-breakpoint
CREATE INDEX "webinar_registrations_person_idx" ON "webinar_registrations" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "webinar_registrations_webinar_status_idx" ON "webinar_registrations" USING btree ("webinar_id","status");--> statement-breakpoint
CREATE INDEX "webinar_registrations_webinar_person_status_idx" ON "webinar_registrations" USING btree ("webinar_id","person_status");--> statement-breakpoint
CREATE INDEX "webinars_status_starts_idx" ON "webinars" USING btree ("status","starts_at");--> statement-breakpoint
CREATE INDEX "webinars_series_key_idx" ON "webinars" USING btree ("series_key") WHERE "webinars"."series_key" is not null;--> statement-breakpoint
CREATE INDEX "webinars_mode_status_idx" ON "webinars" USING btree ("mode","status") WHERE "webinars"."status" in ('published','live','ended');