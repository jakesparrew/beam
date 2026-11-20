CREATE TYPE "public"."assistant_conversations_role" AS ENUM('guide', 'coach');--> statement-breakpoint
CREATE TYPE "public"."assistant_conversations_status" AS ENUM('open', 'handoff', 'closed');--> statement-breakpoint
CREATE TYPE "public"."assistant_messages_author" AS ENUM('visitor', 'assistant', 'staff');--> statement-breakpoint
CREATE TABLE "assistant_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid,
	"person_id" uuid,
	"kind" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assistant_actions_kind_ck" CHECK ("assistant_actions"."kind" ~ '^[a-z_]{2,40}$')
);
--> statement-breakpoint
CREATE TABLE "assistant_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"visitor_id" uuid NOT NULL,
	"person_id" uuid,
	"role" "assistant_conversations_role" DEFAULT 'guide' NOT NULL,
	"status" "assistant_conversations_status" DEFAULT 'open' NOT NULL,
	"locale" text DEFAULT 'nl-BE' NOT NULL,
	"page" text,
	"message_count" integer DEFAULT 0 NOT NULL,
	"unanswered_count" integer DEFAULT 0 NOT NULL,
	"taken_over_by_user_id" uuid,
	"contact_offered_at" timestamp with time zone,
	"contact_captured_at" timestamp with time zone,
	"booking_link_clicked_at" timestamp with time zone,
	"analysis" jsonb,
	"score" smallint,
	"score_reason" text,
	"analysed_at" timestamp with time zone,
	"analysed_message_count" integer DEFAULT 0 NOT NULL,
	"cost_cents" numeric(12, 4) DEFAULT '0' NOT NULL,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assistant_conversations_score_ck" CHECK ("assistant_conversations"."score" is null or "assistant_conversations"."score" between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE "assistant_eval_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"role" "assistant_conversations_role" DEFAULT 'guide' NOT NULL,
	"locale" text DEFAULT 'nl-BE' NOT NULL,
	"question" text NOT NULL,
	"expectation" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assistant_eval_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_key" text NOT NULL,
	"case_id" uuid NOT NULL,
	"model" text NOT NULL,
	"answer" text NOT NULL,
	"passed" smallint,
	"verdict" text,
	"cost_cents" numeric(12, 4) DEFAULT '0' NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assistant_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"author" "assistant_messages_author" NOT NULL,
	"staff_user_id" uuid,
	"body" text NOT NULL,
	"kind" text,
	"cards" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"model" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"cost_cents" numeric(12, 4) DEFAULT '0' NOT NULL,
	"duration_ms" integer,
	"rating" smallint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assistant_messages_body_ck" CHECK (char_length("assistant_messages"."body") <= 8000),
	CONSTRAINT "assistant_messages_rating_ck" CHECK ("assistant_messages"."rating" is null or "assistant_messages"."rating" in (-1, 1))
);
--> statement-breakpoint
CREATE TABLE "assistant_visitors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"person_id" uuid,
	"locale" text DEFAULT 'nl-BE' NOT NULL,
	"first_page" text,
	"origin" jsonb,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assistant_visitors_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "assistant_actions" ADD CONSTRAINT "assistant_actions_conversation_id_assistant_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."assistant_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_actions" ADD CONSTRAINT "assistant_actions_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_conversations" ADD CONSTRAINT "assistant_conversations_visitor_id_assistant_visitors_id_fk" FOREIGN KEY ("visitor_id") REFERENCES "public"."assistant_visitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_conversations" ADD CONSTRAINT "assistant_conversations_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_conversations" ADD CONSTRAINT "assistant_conversations_taken_over_by_user_id_users_id_fk" FOREIGN KEY ("taken_over_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_eval_runs" ADD CONSTRAINT "assistant_eval_runs_case_id_assistant_eval_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."assistant_eval_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_messages" ADD CONSTRAINT "assistant_messages_conversation_id_assistant_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."assistant_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_messages" ADD CONSTRAINT "assistant_messages_staff_user_id_users_id_fk" FOREIGN KEY ("staff_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_visitors" ADD CONSTRAINT "assistant_visitors_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assistant_actions_created_idx" ON "assistant_actions" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "assistant_actions_person_idx" ON "assistant_actions" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "assistant_conversations_visitor_idx" ON "assistant_conversations" USING btree ("visitor_id");--> statement-breakpoint
CREATE INDEX "assistant_conversations_person_idx" ON "assistant_conversations" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "assistant_conversations_last_idx" ON "assistant_conversations" USING btree ("last_message_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "assistant_eval_runs_key_idx" ON "assistant_eval_runs" USING btree ("run_key","model");--> statement-breakpoint
CREATE INDEX "assistant_messages_conversation_idx" ON "assistant_messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "assistant_visitors_person_idx" ON "assistant_visitors" USING btree ("person_id");