CREATE TYPE "public"."inbox_messages_direction" AS ENUM('in', 'out', 'note');--> statement-breakpoint
CREATE TYPE "public"."inbox_threads_channel" AS ENUM('email', 'instagram', 'messenger', 'form');--> statement-breakpoint
CREATE TYPE "public"."inbox_threads_status" AS ENUM('open', 'pending', 'resolved');--> statement-breakpoint
CREATE TABLE "inbox_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"direction" "inbox_messages_direction" NOT NULL,
	"body" text NOT NULL,
	"external_message_id" text,
	"ai_draft" text,
	"sent_by_user_id" uuid,
	"email_message_id" uuid,
	"attachment_count" smallint DEFAULT 0 NOT NULL,
	"delivery_error" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbox_messages_external_message_id_unique" UNIQUE("external_message_id"),
	CONSTRAINT "inbox_messages_body_ck" CHECK (char_length("inbox_messages"."body") <= 50000),
	CONSTRAINT "inbox_messages_attachment_count_ck" CHECK ("inbox_messages"."attachment_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "inbox_reply_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" jsonb NOT NULL,
	"body" jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbox_reply_templates_key_unique" UNIQUE("key"),
	CONSTRAINT "inbox_reply_templates_key_ck" CHECK ("inbox_reply_templates"."key" ~ '^[a-z0-9_-]{2,64}$')
);
--> statement-breakpoint
CREATE TABLE "inbox_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel" "inbox_threads_channel" NOT NULL,
	"external_thread_id" text,
	"person_id" uuid,
	"company_id" uuid,
	"from_address" text,
	"from_name" text,
	"status" "inbox_threads_status" DEFAULT 'open' NOT NULL,
	"assignee_user_id" uuid,
	"subject" text,
	"last_message_at" timestamp with time zone NOT NULL,
	"last_inbound_at" timestamp with time zone,
	"first_response_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"escalated_at" timestamp with time zone,
	"is_sensitive" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbox_threads_subject_ck" CHECK ("inbox_threads"."subject" is null or char_length("inbox_threads"."subject") <= 500)
);
--> statement-breakpoint
ALTER TABLE "inbox_messages" ADD CONSTRAINT "inbox_messages_thread_id_inbox_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."inbox_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_messages" ADD CONSTRAINT "inbox_messages_sent_by_user_id_users_id_fk" FOREIGN KEY ("sent_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_messages" ADD CONSTRAINT "inbox_messages_email_message_id_email_messages_id_fk" FOREIGN KEY ("email_message_id") REFERENCES "public"."email_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_threads" ADD CONSTRAINT "inbox_threads_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_threads" ADD CONSTRAINT "inbox_threads_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_threads" ADD CONSTRAINT "inbox_threads_assignee_user_id_users_id_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inbox_messages_thread_idx" ON "inbox_messages" USING btree ("thread_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "inbox_threads_channel_external_uq" ON "inbox_threads" USING btree ("channel","external_thread_id") WHERE "inbox_threads"."external_thread_id" is not null;--> statement-breakpoint
CREATE INDEX "inbox_threads_status_last_idx" ON "inbox_threads" USING btree ("status","last_message_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "inbox_threads_person_idx" ON "inbox_threads" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "inbox_threads_assignee_idx" ON "inbox_threads" USING btree ("assignee_user_id");