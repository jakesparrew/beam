CREATE TYPE "public"."lightspeed_imports_status" AS ENUM('uploaded', 'running', 'done', 'failed');--> statement-breakpoint
CREATE TABLE "lightspeed_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"file_id" uuid NOT NULL,
	"status" "lightspeed_imports_status" DEFAULT 'uploaded' NOT NULL,
	"business_from_on" date,
	"business_to_on" date,
	"rows_total" integer DEFAULT 0 NOT NULL,
	"rows_imported" integer DEFAULT 0 NOT NULL,
	"rows_skipped" integer DEFAULT 0 NOT NULL,
	"errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lightspeed_imports_counts_chk" CHECK ("lightspeed_imports"."rows_total" >= 0 and "lightspeed_imports"."rows_imported" >= 0 and "lightspeed_imports"."rows_skipped" >= 0)
);
--> statement-breakpoint
CREATE TABLE "lightspeed_sales" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"import_id" uuid NOT NULL,
	"external_line_key" text NOT NULL,
	"business_day_on" date NOT NULL,
	"sold_at" timestamp with time zone NOT NULL,
	"receipt_number" text NOT NULL,
	"product_name" text NOT NULL,
	"category" text NOT NULL,
	"quantity" numeric(10, 3) NOT NULL,
	"total_cents" integer NOT NULL,
	"vat_rate_pct" numeric(4, 2) NOT NULL,
	"vat_cents" integer NOT NULL,
	"payment_method" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lightspeed_sales_external_line_key_unique" UNIQUE("external_line_key")
);
--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT "orders_renewal_chk";--> statement-breakpoint
ALTER TABLE "refunds" ALTER COLUMN "created_by_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "promotions" ADD COLUMN "partner_company_id" uuid;--> statement-breakpoint
ALTER TABLE "lightspeed_imports" ADD CONSTRAINT "lightspeed_imports_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lightspeed_imports" ADD CONSTRAINT "lightspeed_imports_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lightspeed_sales" ADD CONSTRAINT "lightspeed_sales_import_id_lightspeed_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."lightspeed_imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lightspeed_imports_status_idx" ON "lightspeed_imports" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "lightspeed_sales_business_day_idx" ON "lightspeed_sales" USING btree ("business_day_on");--> statement-breakpoint
CREATE INDEX "lightspeed_sales_import_idx" ON "lightspeed_sales" USING btree ("import_id");--> statement-breakpoint
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_partner_company_id_companies_id_fk" FOREIGN KEY ("partner_company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "promotions_partner_idx" ON "promotions" USING btree ("partner_company_id") WHERE "promotions"."partner_company_id" is not null;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_renewal_chk" CHECK ("orders"."renewal_membership_id" is null or "orders"."renewal_period_end_on" is not null);--> statement-breakpoint
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_partner_code_chk" CHECK ("promotions"."partner_company_id" is null or "promotions"."code" is not null);