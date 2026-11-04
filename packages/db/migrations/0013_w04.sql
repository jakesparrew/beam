CREATE TYPE "public"."cookie_consents_action" AS ENUM('accept_all', 'reject_all', 'custom', 'withdraw');--> statement-breakpoint
CREATE TYPE "public"."media_assets_source" AS ENUM('upload', 'wordpress');--> statement-breakpoint
CREATE TYPE "public"."nav_menus_key" AS ENUM('header', 'footer', 'legal');--> statement-breakpoint
CREATE TYPE "public"."page_edit_requests_kind" AS ENUM('edit', 'new_page', 'translate');--> statement-breakpoint
CREATE TYPE "public"."page_edit_requests_status" AS ENUM('pending', 'running', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."page_versions_created_by" AS ENUM('user', 'claude');--> statement-breakpoint
CREATE TYPE "public"."page_versions_state" AS ENUM('draft', 'proposed', 'published', 'rejected', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."pages_legal_key" AS ENUM('privacy_notice', 'terms', 'cookie_notice', 'accessibility_statement', 'guardian_consent');--> statement-breakpoint
CREATE TYPE "public"."redirects_source" AS ENUM('wordpress', 'rename', 'archive', 'manual');--> statement-breakpoint
CREATE TYPE "public"."terms_acceptances_context" AS ENUM('checkout', 'signup', 'booking', 'portal_prompt', 'pos', 'import');--> statement-breakpoint
CREATE TYPE "public"."wordpress_import_items_decision" AS ENUM('import', 'skip', 'redirect_only');--> statement-breakpoint
CREATE TYPE "public"."wordpress_import_items_status" AS ENUM('pending', 'imported', 'skipped', 'error');--> statement-breakpoint
CREATE TYPE "public"."wordpress_import_items_wp_type" AS ENUM('page', 'post', 'attachment');--> statement-breakpoint
CREATE TYPE "public"."wordpress_imports_status" AS ENUM('uploaded', 'parsing', 'parsed', 'applying', 'done', 'failed');--> statement-breakpoint
CREATE TABLE "cookie_consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"consent_key" uuid NOT NULL,
	"person_id" uuid,
	"choices" jsonb NOT NULL,
	"banner_version" integer NOT NULL,
	"action" "cookie_consents_action" NOT NULL,
	"locale" "locale" NOT NULL,
	"ip_hash" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cookie_consents_banner_version_ck" CHECK ("cookie_consents"."banner_version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "media_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"file_id" uuid NOT NULL,
	"alt" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_decorative" boolean DEFAULT false NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"caption" jsonb,
	"credit" text,
	"source" "media_assets_source" DEFAULT 'upload' NOT NULL,
	"wordpress_url" text,
	"uploaded_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_assets_file_id_uq" UNIQUE("file_id"),
	CONSTRAINT "media_assets_width_ck" CHECK ("media_assets"."width" > 0),
	CONSTRAINT "media_assets_height_ck" CHECK ("media_assets"."height" > 0),
	CONSTRAINT "media_assets_credit_ck" CHECK ("media_assets"."credit" is null or length("media_assets"."credit") <= 200)
);
--> statement-breakpoint
CREATE TABLE "nav_menus" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" "nav_menus_key" NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nav_menus_key_uq" UNIQUE("key"),
	CONSTRAINT "nav_menus_version_ck" CHECK ("nav_menus"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "page_edit_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"page_id" uuid NOT NULL,
	"kind" "page_edit_requests_kind" DEFAULT 'edit' NOT NULL,
	"instruction" text NOT NULL,
	"locales" text[] NOT NULL,
	"base_version_id" uuid,
	"base_updated_at" timestamp with time zone,
	"status" "page_edit_requests_status" DEFAULT 'pending' NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"result_version_id" uuid,
	"ai_request_id" uuid,
	"error_code" text,
	"error_message" text,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "page_edit_requests_instruction_ck" CHECK (length("page_edit_requests"."instruction") between 3 and 4000),
	CONSTRAINT "page_edit_requests_locales_ck" CHECK ("page_edit_requests"."locales" <@ array['nl-BE','fr-BE','en']::text[] and cardinality("page_edit_requests"."locales") >= 1),
	CONSTRAINT "page_edit_requests_error_code_ck" CHECK ("page_edit_requests"."error_code" is null or "page_edit_requests"."error_code" in ('budget_exceeded', 'invalid_output', 'ai_unavailable', 'page_archived'))
);
--> statement-breakpoint
CREATE TABLE "page_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"page_id" uuid NOT NULL,
	"locale" "locale" NOT NULL,
	"path" text NOT NULL,
	"version_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "page_routes_path_ck" CHECK (("page_routes"."path" = '' or "page_routes"."path" ~ '^[a-z0-9]+(-[a-z0-9]+)*(/[a-z0-9]+(-[a-z0-9]+)*){0,2}$') and length("page_routes"."path") <= 200)
);
--> statement-breakpoint
CREATE TABLE "page_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"page_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"state" "page_versions_state" DEFAULT 'draft' NOT NULL,
	"title" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"paths" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"blocks" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"seo" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"excerpt" jsonb,
	"cover_media_id" uuid,
	"locales" text[] DEFAULT '{nl-BE,fr-BE,en}'::text[] NOT NULL,
	"is_material_change" boolean DEFAULT false NOT NULL,
	"change_summary" text,
	"based_on_version_id" uuid,
	"created_by" "page_versions_created_by" DEFAULT 'user' NOT NULL,
	"created_by_user_id" uuid,
	"edit_request_id" uuid,
	"proposed_by_ai_request_id" uuid,
	"scheduled_publish_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"published_by_user_id" uuid,
	"rejected_at" timestamp with time zone,
	"rejected_by_user_id" uuid,
	"reject_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "page_versions_version_ck" CHECK ("page_versions"."version" > 0),
	CONSTRAINT "page_versions_locales_ck" CHECK ("page_versions"."locales" <@ array['nl-BE','fr-BE','en']::text[] and cardinality("page_versions"."locales") >= 1),
	CONSTRAINT "page_versions_change_summary_ck" CHECK ("page_versions"."change_summary" is null or length("page_versions"."change_summary") <= 500),
	CONSTRAINT "page_versions_reject_reason_ck" CHECK ("page_versions"."reject_reason" is null or length("page_versions"."reject_reason") <= 500),
	CONSTRAINT "page_versions_published_ck" CHECK (("page_versions"."state" = 'published') = ("page_versions"."published_at" is not null)),
	CONSTRAINT "page_versions_rejected_ck" CHECK ("page_versions"."state" <> 'rejected' or "page_versions"."rejected_at" is not null),
	CONSTRAINT "page_versions_claude_not_draft_ck" CHECK ("page_versions"."created_by" = 'user' or "page_versions"."state" <> 'draft'),
	CONSTRAINT "page_versions_superseded_claude_ck" CHECK ("page_versions"."state" <> 'superseded' or "page_versions"."created_by" = 'claude'),
	CONSTRAINT "page_versions_schedule_state_ck" CHECK ("page_versions"."scheduled_publish_at" is null or "page_versions"."state" in ('draft', 'proposed'))
);
--> statement-breakpoint
CREATE TABLE "redirects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_path" text NOT NULL,
	"to_page_id" uuid,
	"to_locale" "locale",
	"to_url" text,
	"is_permanent" boolean DEFAULT true NOT NULL,
	"source" "redirects_source" NOT NULL,
	"hits" integer DEFAULT 0 NOT NULL,
	"last_hit_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "redirects_from_path_uq" UNIQUE("from_path"),
	CONSTRAINT "redirects_from_path_ck" CHECK ("redirects"."from_path" like '/%' and "redirects"."from_path" !~ '^/(admin|api|_next)(/|$)'),
	CONSTRAINT "redirects_target_ck" CHECK (("redirects"."to_page_id" is not null and "redirects"."to_locale" is not null and "redirects"."to_url" is null) or ("redirects"."to_page_id" is null and "redirects"."to_locale" is null and "redirects"."to_url" is not null)),
	CONSTRAINT "redirects_to_url_ck" CHECK ("redirects"."to_url" is null or (("redirects"."to_url" like '/%' or "redirects"."to_url" like 'https://%') and length("redirects"."to_url") <= 500 and "redirects"."to_url" <> "redirects"."from_path")),
	CONSTRAINT "redirects_hits_ck" CHECK ("redirects"."hits" >= 0)
);
--> statement-breakpoint
CREATE TABLE "site_audit_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"week_on" date NOT NULL,
	"findings" jsonb NOT NULL,
	"ai_request_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_audit_reports_week_on_uq" UNIQUE("week_on")
);
--> statement-breakpoint
CREATE TABLE "terms_acceptances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"page_version_id" uuid NOT NULL,
	"legal_key" "pages_legal_key" NOT NULL,
	"context" "terms_acceptances_context" NOT NULL,
	"ref_type" text,
	"ref_id" uuid,
	"ip" text,
	"idempotency_key" text NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "terms_acceptances_idempotency_key_uq" UNIQUE("idempotency_key"),
	CONSTRAINT "terms_acceptances_ref_type_ck" CHECK ("terms_acceptances"."ref_type" is null or "terms_acceptances"."ref_type" in ('order', 'booking', 'user'))
);
--> statement-breakpoint
CREATE TABLE "wordpress_import_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"import_id" uuid NOT NULL,
	"wp_id" integer NOT NULL,
	"wp_type" "wordpress_import_items_wp_type" NOT NULL,
	"wp_status" text NOT NULL,
	"locale" "locale",
	"translation_group" text,
	"parent_wp_id" integer,
	"title" text NOT NULL,
	"wp_link" text NOT NULL,
	"wp_path" text NOT NULL,
	"content_html" text,
	"excerpt" text,
	"published_at" timestamp with time zone,
	"attachment_url" text,
	"decision" "wordpress_import_items_decision" DEFAULT 'import' NOT NULL,
	"target_page_id" uuid,
	"target_media_id" uuid,
	"redirect_to_page_id" uuid,
	"status" "wordpress_import_items_status" DEFAULT 'pending' NOT NULL,
	"message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wordpress_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"file_id" uuid NOT NULL,
	"site_origin" text NOT NULL,
	"default_locale" "locale" DEFAULT 'nl-BE' NOT NULL,
	"status" "wordpress_imports_status" DEFAULT 'uploaded' NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"report" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wordpress_imports_origin_ck" CHECK ("wordpress_imports"."site_origin" ~ '^https://')
);
--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "legal_key" "pages_legal_key";--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "session_id" uuid;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "partner_company_id" uuid;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "first_published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "archived_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "created_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "cookie_consents" ADD CONSTRAINT "cookie_consents_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nav_menus" ADD CONSTRAINT "nav_menus_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_edit_requests" ADD CONSTRAINT "page_edit_requests_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_edit_requests" ADD CONSTRAINT "page_edit_requests_base_version_id_page_versions_id_fk" FOREIGN KEY ("base_version_id") REFERENCES "public"."page_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_edit_requests" ADD CONSTRAINT "page_edit_requests_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_edit_requests" ADD CONSTRAINT "page_edit_requests_result_version_id_page_versions_id_fk" FOREIGN KEY ("result_version_id") REFERENCES "public"."page_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_routes" ADD CONSTRAINT "page_routes_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_routes" ADD CONSTRAINT "page_routes_version_id_page_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."page_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_versions" ADD CONSTRAINT "page_versions_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_versions" ADD CONSTRAINT "page_versions_cover_media_id_media_assets_id_fk" FOREIGN KEY ("cover_media_id") REFERENCES "public"."media_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_versions" ADD CONSTRAINT "page_versions_based_on_version_id_page_versions_id_fk" FOREIGN KEY ("based_on_version_id") REFERENCES "public"."page_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_versions" ADD CONSTRAINT "page_versions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_versions" ADD CONSTRAINT "page_versions_edit_request_id_page_edit_requests_id_fk" FOREIGN KEY ("edit_request_id") REFERENCES "public"."page_edit_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_versions" ADD CONSTRAINT "page_versions_published_by_user_id_users_id_fk" FOREIGN KEY ("published_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_versions" ADD CONSTRAINT "page_versions_rejected_by_user_id_users_id_fk" FOREIGN KEY ("rejected_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "redirects" ADD CONSTRAINT "redirects_to_page_id_pages_id_fk" FOREIGN KEY ("to_page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "redirects" ADD CONSTRAINT "redirects_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terms_acceptances" ADD CONSTRAINT "terms_acceptances_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terms_acceptances" ADD CONSTRAINT "terms_acceptances_page_version_id_page_versions_id_fk" FOREIGN KEY ("page_version_id") REFERENCES "public"."page_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wordpress_import_items" ADD CONSTRAINT "wordpress_import_items_import_id_wordpress_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."wordpress_imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wordpress_import_items" ADD CONSTRAINT "wordpress_import_items_target_page_id_pages_id_fk" FOREIGN KEY ("target_page_id") REFERENCES "public"."pages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wordpress_import_items" ADD CONSTRAINT "wordpress_import_items_target_media_id_media_assets_id_fk" FOREIGN KEY ("target_media_id") REFERENCES "public"."media_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wordpress_import_items" ADD CONSTRAINT "wordpress_import_items_redirect_to_page_id_pages_id_fk" FOREIGN KEY ("redirect_to_page_id") REFERENCES "public"."pages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wordpress_imports" ADD CONSTRAINT "wordpress_imports_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wordpress_imports" ADD CONSTRAINT "wordpress_imports_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cookie_consents_key_idx" ON "cookie_consents" USING btree ("consent_key","recorded_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "cookie_consents_person_idx" ON "cookie_consents" USING btree ("person_id") WHERE "cookie_consents"."person_id" is not null;--> statement-breakpoint
CREATE INDEX "cookie_consents_recorded_idx" ON "cookie_consents" USING btree ("recorded_at");--> statement-breakpoint
CREATE INDEX "media_assets_source_idx" ON "media_assets" USING btree ("source");--> statement-breakpoint
CREATE UNIQUE INDEX "media_assets_wordpress_url_uq" ON "media_assets" USING btree ("wordpress_url") WHERE "media_assets"."wordpress_url" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "page_edit_requests_active_uq" ON "page_edit_requests" USING btree ("page_id") WHERE "page_edit_requests"."status" in ('pending', 'running');--> statement-breakpoint
CREATE INDEX "page_edit_requests_page_created_idx" ON "page_edit_requests" USING btree ("page_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "page_routes_locale_path_uq" ON "page_routes" USING btree ("locale","path");--> statement-breakpoint
CREATE UNIQUE INDEX "page_routes_page_locale_uq" ON "page_routes" USING btree ("page_id","locale");--> statement-breakpoint
CREATE UNIQUE INDEX "page_versions_page_version_uq" ON "page_versions" USING btree ("page_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "page_versions_one_draft_uq" ON "page_versions" USING btree ("page_id") WHERE "page_versions"."state" = 'draft';--> statement-breakpoint
CREATE INDEX "page_versions_page_state_idx" ON "page_versions" USING btree ("page_id","state");--> statement-breakpoint
CREATE INDEX "page_versions_scheduled_idx" ON "page_versions" USING btree ("scheduled_publish_at") WHERE "page_versions"."scheduled_publish_at" is not null;--> statement-breakpoint
CREATE INDEX "page_versions_edit_request_idx" ON "page_versions" USING btree ("edit_request_id");--> statement-breakpoint
CREATE INDEX "redirects_to_page_idx" ON "redirects" USING btree ("to_page_id");--> statement-breakpoint
CREATE INDEX "terms_acceptances_person_idx" ON "terms_acceptances" USING btree ("person_id","legal_key","accepted_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "wordpress_import_items_item_uq" ON "wordpress_import_items" USING btree ("import_id","wp_type","wp_id");--> statement-breakpoint
CREATE INDEX "wordpress_import_items_status_idx" ON "wordpress_import_items" USING btree ("import_id","status");--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_current_version_id_page_versions_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."page_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_archived_by_user_id_users_id_fk" FOREIGN KEY ("archived_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pages_singleton_kind_uq" ON "pages" USING btree ("kind") WHERE "pages"."kind" in ('home', 'events_index', 'blog_index', 'contact') and "pages"."status" <> 'archived';--> statement-breakpoint
CREATE UNIQUE INDEX "pages_legal_key_uq" ON "pages" USING btree ("legal_key") WHERE "pages"."legal_key" is not null and "pages"."status" <> 'archived';--> statement-breakpoint
CREATE UNIQUE INDEX "pages_session_uq" ON "pages" USING btree ("session_id") WHERE "pages"."session_id" is not null and "pages"."status" <> 'archived';--> statement-breakpoint
CREATE INDEX "pages_posts_published_idx" ON "pages" USING btree ("first_published_at" DESC NULLS LAST) WHERE "pages"."kind" = 'post' and "pages"."status" = 'published';--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_legal_key_ck" CHECK (("pages"."kind" = 'legal') = ("pages"."legal_key" is not null));--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_session_kind_ck" CHECK ("pages"."session_id" is null or "pages"."kind" = 'event');--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_partner_kind_ck" CHECK ("pages"."partner_company_id" is null or "pages"."kind" = 'landing');--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_published_version_ck" CHECK ("pages"."status" <> 'published' or "pages"."current_version_id" is not null);