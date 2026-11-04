CREATE TYPE "public"."credit_bulk_extensions_status" AS ENUM('pending', 'running', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."credit_grants_validity_rule" AS ENUM('from_purchase', 'fixed');--> statement-breakpoint
CREATE TYPE "public"."credit_grants_vat_treatment" AS ENUM('single_purpose', 'multi_purpose', 'not_applicable');--> statement-breakpoint
CREATE TYPE "public"."credit_reconciliation_runs_status" AS ENUM('ok', 'mismatch', 'error');--> statement-breakpoint
CREATE TYPE "public"."membership_periods_source" AS ENUM('purchase', 'renewal', 'late_payment', 'import', 'staff_extension');--> statement-breakpoint
CREATE TYPE "public"."membership_plan_benefits_kind" AS ENUM('included_units', 'discount', 'member_only_access', 'event_access', 'event_discount', 'other');--> statement-breakpoint
CREATE TYPE "public"."memberships_end_reason" AS ENUM('cancelled_by_customer', 'cancelled_by_staff', 'refunded', 'payment_failed', 'not_renewed', 'merged', 'erased');--> statement-breakpoint
CREATE TYPE "public"."memberships_interval" AS ENUM('month', 'year');--> statement-breakpoint
CREATE TYPE "public"."memberships_source" AS ENUM('purchase', 'import', 'staff');--> statement-breakpoint
CREATE TYPE "public"."memberships_status" AS ENUM('pending', 'active', 'past_due', 'cancelled', 'expired');--> statement-breakpoint
CREATE TYPE "public"."package_shares_status" AS ENUM('active', 'revoked');--> statement-breakpoint
CREATE TABLE "credit_bulk_extensions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reason" text NOT NULL,
	"days" smallint NOT NULL,
	"filter" jsonb NOT NULL,
	"status" "credit_bulk_extensions_status" DEFAULT 'pending' NOT NULL,
	"matched_count" integer DEFAULT 0 NOT NULL,
	"extended_count" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_bulk_extensions_reason_ck" CHECK (length(btrim("credit_bulk_extensions"."reason")) >= 3),
	CONSTRAINT "credit_bulk_extensions_days_ck" CHECK ("credit_bulk_extensions"."days" between 1 and 90),
	CONSTRAINT "credit_bulk_extensions_counts_ck" CHECK ("credit_bulk_extensions"."matched_count" >= 0 and "credit_bulk_extensions"."extended_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "credit_reconciliation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"status" "credit_reconciliation_runs_status",
	"checked_grants" integer DEFAULT 0 NOT NULL,
	"checked_bookings" integer DEFAULT 0 NOT NULL,
	"findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fixed" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_reconciliation_runs_finished_ck" CHECK (("credit_reconciliation_runs"."finished_at" is null) = ("credit_reconciliation_runs"."status" is null))
);
--> statement-breakpoint
CREATE TABLE "membership_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"membership_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"period_start_at" timestamp with time zone NOT NULL,
	"period_end_at" timestamp with time zone NOT NULL,
	"source" "membership_periods_source" NOT NULL,
	"order_id" uuid,
	"amount_cents" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "membership_periods_membership_start_uq" UNIQUE("membership_id","period_start_at"),
	CONSTRAINT "membership_periods_window_ck" CHECK ("membership_periods"."period_end_at" > "membership_periods"."period_start_at"),
	CONSTRAINT "membership_periods_amount_ck" CHECK ("membership_periods"."amount_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "membership_plan_benefits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"kind" "membership_plan_benefits_kind" NOT NULL,
	"text" jsonb NOT NULL,
	"sort_order" smallint DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "membership_plan_inclusions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"credit_kind" "credit_grants_credit_kind" NOT NULL,
	"units_per_period" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "membership_plan_inclusions_product_kind_uq" UNIQUE("product_id","credit_kind"),
	CONSTRAINT "membership_plan_inclusions_kind_ck" CHECK ("membership_plan_inclusions"."credit_kind" <> 'euro'),
	CONSTRAINT "membership_plan_inclusions_units_ck" CHECK ("membership_plan_inclusions"."units_per_period" > 0)
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"status" "memberships_status" DEFAULT 'pending' NOT NULL,
	"interval" "memberships_interval" NOT NULL,
	"source" "memberships_source" DEFAULT 'purchase' NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"current_period_start_at" timestamp with time zone NOT NULL,
	"current_period_end_at" timestamp with time zone NOT NULL,
	"cancel_at" timestamp with time zone,
	"cancel_requested_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"end_reason" "memberships_end_reason",
	"mandate_id" uuid,
	"price_version_id" uuid,
	"first_order_id" uuid,
	"renewal_order_id" uuid,
	"discount_pct" numeric(5, 2) DEFAULT '0' NOT NULL,
	"next_charge_at" timestamp with time zone,
	"dunning_attempt" smallint DEFAULT 0 NOT NULL,
	"past_due_since_at" timestamp with time zone,
	"notes" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_period_ck" CHECK ("memberships"."current_period_end_at" > "memberships"."current_period_start_at"),
	CONSTRAINT "memberships_end_reason_ck" CHECK (("memberships"."end_reason" is not null) = ("memberships"."status" in ('cancelled', 'expired'))),
	CONSTRAINT "memberships_discount_ck" CHECK ("memberships"."discount_pct" between 0 and 100),
	CONSTRAINT "memberships_dunning_ck" CHECK ("memberships"."dunning_attempt" between 0 and 3),
	CONSTRAINT "memberships_version_ck" CHECK ("memberships"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "package_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"grant_id" uuid NOT NULL,
	"shared_with_person_id" uuid NOT NULL,
	"max_units" integer,
	"status" "package_shares_status" DEFAULT 'active' NOT NULL,
	"created_by_user_id" uuid,
	"created_by_person_id" uuid,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "package_shares_max_units_ck" CHECK ("package_shares"."max_units" is null or "package_shares"."max_units" > 0),
	CONSTRAINT "package_shares_creator_ck" CHECK (num_nonnulls("package_shares"."created_by_user_id", "package_shares"."created_by_person_id") = 1)
);
--> statement-breakpoint
ALTER TABLE "credit_entries" ADD COLUMN "reverses_entry_id" uuid;--> statement-breakpoint
ALTER TABLE "credit_grants" ADD COLUMN "line_unit_index" smallint;--> statement-breakpoint
ALTER TABLE "credit_grants" ADD COLUMN "voucher_id" uuid;--> statement-breakpoint
ALTER TABLE "credit_grants" ADD COLUMN "membership_id" uuid;--> statement-breakpoint
ALTER TABLE "credit_grants" ADD COLUMN "vat_rate_pct" numeric(4, 2);--> statement-breakpoint
ALTER TABLE "credit_grants" ADD COLUMN "vat_treatment" "credit_grants_vat_treatment" DEFAULT 'not_applicable' NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_grants" ADD COLUMN "validity_rule" "credit_grants_validity_rule" DEFAULT 'from_purchase' NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_grants" ADD COLUMN "status_changed_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_grants" ADD COLUMN "label" jsonb;--> statement-breakpoint
ALTER TABLE "credit_grants" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "credit_grants" ADD COLUMN "data" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_grants" ADD COLUMN "created_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "credit_bulk_extensions" ADD CONSTRAINT "credit_bulk_extensions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_periods" ADD CONSTRAINT "membership_periods_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_periods" ADD CONSTRAINT "membership_periods_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_periods" ADD CONSTRAINT "membership_periods_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_periods" ADD CONSTRAINT "membership_periods_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_plan_benefits" ADD CONSTRAINT "membership_plan_benefits_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_plan_inclusions" ADD CONSTRAINT "membership_plan_inclusions_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_price_version_id_price_versions_id_fk" FOREIGN KEY ("price_version_id") REFERENCES "public"."price_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_first_order_id_orders_id_fk" FOREIGN KEY ("first_order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_renewal_order_id_orders_id_fk" FOREIGN KEY ("renewal_order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_shares" ADD CONSTRAINT "package_shares_grant_id_credit_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."credit_grants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_shares" ADD CONSTRAINT "package_shares_shared_with_person_id_persons_id_fk" FOREIGN KEY ("shared_with_person_id") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_shares" ADD CONSTRAINT "package_shares_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_shares" ADD CONSTRAINT "package_shares_created_by_person_id_persons_id_fk" FOREIGN KEY ("created_by_person_id") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_bulk_extensions_created_idx" ON "credit_bulk_extensions" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "credit_reconciliation_runs_started_idx" ON "credit_reconciliation_runs" USING btree ("started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "membership_periods_person_idx" ON "membership_periods" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "membership_plan_benefits_product_sort_idx" ON "membership_plan_benefits" USING btree ("product_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_person_live_uq" ON "memberships" USING btree ("person_id") WHERE "memberships"."status" in ('active', 'past_due');--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_person_pending_uq" ON "memberships" USING btree ("person_id") WHERE "memberships"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "memberships_status_period_end_idx" ON "memberships" USING btree ("status","current_period_end_at");--> statement-breakpoint
CREATE INDEX "memberships_next_charge_idx" ON "memberships" USING btree ("next_charge_at") WHERE "memberships"."status" in ('active', 'past_due');--> statement-breakpoint
CREATE INDEX "memberships_renewal_order_idx" ON "memberships" USING btree ("renewal_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "package_shares_active_uq" ON "package_shares" USING btree ("grant_id","shared_with_person_id") WHERE "package_shares"."status" = 'active';--> statement-breakpoint
CREATE INDEX "package_shares_shared_with_idx" ON "package_shares" USING btree ("shared_with_person_id") WHERE "package_shares"."status" = 'active';--> statement-breakpoint
ALTER TABLE "credit_entries" ADD CONSTRAINT "credit_entries_reverses_entry_id_credit_entries_id_fk" FOREIGN KEY ("reverses_entry_id") REFERENCES "public"."credit_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_grants" ADD CONSTRAINT "credit_grants_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_grants" ADD CONSTRAINT "credit_grants_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_entries_release_uq" ON "credit_entries" USING btree ("reverses_entry_id") WHERE "credit_entries"."kind" = 'release';--> statement-breakpoint
CREATE UNIQUE INDEX "credit_grants_order_line_unit_uq" ON "credit_grants" USING btree ("order_line_id","line_unit_index") WHERE "credit_grants"."source" = 'purchase';--> statement-breakpoint
CREATE UNIQUE INDEX "credit_grants_voucher_uq" ON "credit_grants" USING btree ("voucher_id") WHERE "credit_grants"."source" = 'voucher';--> statement-breakpoint
CREATE UNIQUE INDEX "credit_grants_membership_kind_start_uq" ON "credit_grants" USING btree ("membership_id","credit_kind","starts_at") WHERE "credit_grants"."source" = 'membership';--> statement-breakpoint
ALTER TABLE "credit_entries" ADD CONSTRAINT "credit_entries_extend_ck" CHECK ("credit_entries"."kind" <> 'extend' or ("credit_entries"."quantity" = 0 and "credit_entries"."data" ? 'new_expires_at'));--> statement-breakpoint
ALTER TABLE "credit_entries" ADD CONSTRAINT "credit_entries_adjust_ck" CHECK ("credit_entries"."kind" <> 'adjust' or ("credit_entries"."quantity" <> 0 and "credit_entries"."reason" is not null and length(btrim("credit_entries"."reason")) >= 3));--> statement-breakpoint
ALTER TABLE "credit_entries" ADD CONSTRAINT "credit_entries_release_ck" CHECK ("credit_entries"."kind" <> 'release' or "credit_entries"."reverses_entry_id" is not null);--> statement-breakpoint
ALTER TABLE "credit_entries" ADD CONSTRAINT "credit_entries_ref_type_ck" CHECK ("credit_entries"."ref_type" is null or "credit_entries"."ref_type" in ('booking', 'order', 'order_line', 'voucher', 'refund', 'membership', 'import', 'referral', 'transfer', 'bulk_extension', 'privacy_request'));--> statement-breakpoint
ALTER TABLE "credit_grants" ADD CONSTRAINT "credit_grants_line_unit_index_ck" CHECK ("credit_grants"."line_unit_index" is null or "credit_grants"."line_unit_index" > 0);--> statement-breakpoint
ALTER TABLE "credit_grants" ADD CONSTRAINT "credit_grants_vat_rate_ck" CHECK ("credit_grants"."vat_rate_pct" in (0, 6, 12, 21));--> statement-breakpoint
ALTER TABLE "credit_grants" ADD CONSTRAINT "credit_grants_order_line_ck" CHECK ("credit_grants"."source" not in ('purchase', 'voucher') or "credit_grants"."order_line_id" is not null);--> statement-breakpoint
ALTER TABLE "credit_grants" ADD CONSTRAINT "credit_grants_purchase_unit_ck" CHECK ("credit_grants"."source" <> 'purchase' or "credit_grants"."line_unit_index" is not null);--> statement-breakpoint
ALTER TABLE "credit_grants" ADD CONSTRAINT "credit_grants_voucher_ck" CHECK ("credit_grants"."source" <> 'voucher' or ("credit_grants"."voucher_id" is not null and "credit_grants"."credit_kind" = 'euro'));--> statement-breakpoint
ALTER TABLE "credit_grants" ADD CONSTRAINT "credit_grants_membership_ck" CHECK ("credit_grants"."source" <> 'membership' or "credit_grants"."membership_id" is not null);--> statement-breakpoint
ALTER TABLE "credit_grants" ADD CONSTRAINT "credit_grants_euro_vat_ck" CHECK ("credit_grants"."credit_kind" <> 'euro' or "credit_grants"."vat_treatment" in ('multi_purpose', 'not_applicable'));--> statement-breakpoint
ALTER TABLE "credit_grants" ADD CONSTRAINT "credit_grants_multi_purpose_ck" CHECK ("credit_grants"."credit_kind" = 'euro' or "credit_grants"."vat_treatment" <> 'multi_purpose');--> statement-breakpoint
ALTER TABLE "credit_grants" ADD CONSTRAINT "credit_grants_note_ck" CHECK ("credit_grants"."note" is null or length("credit_grants"."note") <= 1000);