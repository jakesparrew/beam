CREATE TYPE "public"."inbox_messages_ai_draft_status" AS ENUM('none', 'pending', 'ready', 'blocked_sensitive', 'failed', 'used', 'discarded');--> statement-breakpoint
CREATE TABLE "support_knowledge_articles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"title" jsonb NOT NULL,
	"body" jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_knowledge_articles_key_unique" UNIQUE("key"),
	CONSTRAINT "support_knowledge_articles_key_ck" CHECK ("support_knowledge_articles"."key" ~ '^[a-z0-9_-]{2,64}$')
);
--> statement-breakpoint
ALTER TABLE "inbox_messages" ADD COLUMN "ai_draft_status" "inbox_messages_ai_draft_status" DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "inbox_messages" ADD COLUMN "ai_request_id" uuid;--> statement-breakpoint
ALTER TABLE "support_knowledge_articles" ADD CONSTRAINT "support_knowledge_articles_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;