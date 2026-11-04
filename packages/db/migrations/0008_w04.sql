CREATE TYPE "public"."checkouts_abandoned_reason" AS ENUM('left', 'payment_failed', 'payment_expired');--> statement-breakpoint
CREATE TYPE "public"."checkouts_channel" AS ENUM('portal', 'site');--> statement-breakpoint
CREATE TYPE "public"."checkouts_status" AS ENUM('started', 'abandoned', 'completed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."mandates_status" AS ENUM('pending', 'valid', 'invalid', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."payments_provider" AS ENUM('mollie', 'stripe', 'viva', 'cash', 'terminal', 'bank_transfer', 'credit_balance');--> statement-breakpoint
CREATE TYPE "public"."payments_sequence_type" AS ENUM('oneoff', 'first', 'recurring');--> statement-breakpoint
CREATE TYPE "public"."payments_status" AS ENUM('open', 'pending', 'authorized', 'paid', 'failed', 'expired', 'cancelled', 'refunded', 'partially_refunded');--> statement-breakpoint
CREATE TYPE "public"."pos_day_closes_status" AS ENUM('open', 'closed');--> statement-breakpoint
CREATE TYPE "public"."products_item_category" AS ENUM('merchandise', 'wellness_product', 'other');--> statement-breakpoint
CREATE TYPE "public"."promotion_redemptions_status" AS ENUM('reserved', 'confirmed', 'released');--> statement-breakpoint
CREATE TYPE "public"."promotions_kind" AS ENUM('percent', 'fixed');--> statement-breakpoint
CREATE TYPE "public"."refunds_credit_action" AS ENUM('none', 'release', 'revoke');--> statement-breakpoint
CREATE TYPE "public"."refunds_status" AS ENUM('pending', 'sent', 'refunded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."vouchers_status" AS ENUM('pending', 'active', 'redeemed', 'expired', 'void');--> statement-breakpoint
CREATE TABLE "checkouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid,
	"email" text,
	"channel" "checkouts_channel" NOT NULL,
	"items" jsonb NOT NULL,
	"promo_code" text,
	"total_cents" integer,
	"status" "checkouts_status" DEFAULT 'started' NOT NULL,
	"locale" text DEFAULT 'nl-BE' NOT NULL,
	"utm" jsonb,
	"landing_path" text,
	"order_id" uuid,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone DEFAULT now() + interval '30 days' NOT NULL,
	"abandoned_at" timestamp with time zone,
	"abandoned_reason" "checkouts_abandoned_reason",
	"resume_token_hash" text,
	"recovery_message_id" uuid,
	"recovered_order_id" uuid,
	"recovered_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "checkouts_resume_token_hash_unique" UNIQUE("resume_token_hash"),
	CONSTRAINT "checkouts_locale_chk" CHECK ("checkouts"."locale" in ('nl-BE', 'fr-BE', 'en')),
	CONSTRAINT "checkouts_contact_chk" CHECK ("checkouts"."person_id" is not null or "checkouts"."email" is not null or "checkouts"."status" = 'started')
);
--> statement-breakpoint
CREATE TABLE "mandates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid,
	"provider" "payments_provider" NOT NULL,
	"provider_mandate_id" text NOT NULL,
	"provider_customer_id" text NOT NULL,
	"method" text NOT NULL,
	"details_summary" text,
	"status" "mandates_status" DEFAULT 'pending' NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mandates_provider_mandate_id_unique" UNIQUE("provider_mandate_id")
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"provider" "payments_provider" NOT NULL,
	"provider_payment_id" text,
	"method" text,
	"sequence_type" "payments_sequence_type" DEFAULT 'oneoff' NOT NULL,
	"status" "payments_status" DEFAULT 'open' NOT NULL,
	"amount_cents" integer NOT NULL,
	"refunded_cents" integer DEFAULT 0 NOT NULL,
	"chargeback_cents" integer DEFAULT 0 NOT NULL,
	"mandate_id" uuid,
	"checkout_url" text,
	"terminal_id" text,
	"cash_received_cents" integer,
	"raw" jsonb,
	"status_history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"failed_reason" text,
	"expires_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_provider_payment_id_unique" UNIQUE("provider_payment_id"),
	CONSTRAINT "payments_amount_chk" CHECK ("payments"."amount_cents" > 0),
	CONSTRAINT "payments_refunded_chk" CHECK ("payments"."refunded_cents" >= 0 and "payments"."refunded_cents" <= "payments"."amount_cents"),
	CONSTRAINT "payments_chargeback_chk" CHECK ("payments"."chargeback_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "person_prices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"valid_from_at" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_to_at" timestamp with time zone,
	"reason" text NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "person_prices_amount_chk" CHECK ("person_prices"."amount_cents" >= 0),
	CONSTRAINT "person_prices_window_chk" CHECK ("person_prices"."valid_to_at" is null or "person_prices"."valid_to_at" > "person_prices"."valid_from_at")
);
--> statement-breakpoint
CREATE TABLE "pos_day_closes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_day_on" date NOT NULL,
	"status" "pos_day_closes_status" DEFAULT 'open' NOT NULL,
	"expected_cash_cents" integer DEFAULT 0 NOT NULL,
	"counted_cash_cents" integer,
	"difference_cents" integer,
	"totals" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"note" text,
	"closed_by_user_id" uuid,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pos_day_closes_business_day_on_unique" UNIQUE("business_day_on"),
	CONSTRAINT "pos_day_closes_note_chk" CHECK ("pos_day_closes"."difference_cents" is null or "pos_day_closes"."difference_cents" = 0 or "pos_day_closes"."note" is not null),
	CONSTRAINT "pos_day_closes_closed_chk" CHECK ("pos_day_closes"."status" <> 'closed' or ("pos_day_closes"."counted_cash_cents" is not null and "pos_day_closes"."closed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "promotion_redemptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"promotion_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"person_id" uuid,
	"status" "promotion_redemptions_status" DEFAULT 'reserved' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promotion_redemptions_promotion_order_uq" UNIQUE("promotion_id","order_id")
);
--> statement-breakpoint
CREATE TABLE "promotions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text,
	"name" jsonb NOT NULL,
	"kind" "promotions_kind" NOT NULL,
	"value" integer NOT NULL,
	"applies_to" jsonb DEFAULT '{"product_ids":[],"product_kinds":[]}'::jsonb NOT NULL,
	"eligibility" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"max_uses" integer,
	"max_uses_per_person" integer,
	"uses_count" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promotions_code_chk" CHECK ("promotions"."code" is null or "promotions"."code" ~ '^[A-Z0-9]{4,24}$'),
	CONSTRAINT "promotions_value_chk" CHECK (("promotions"."kind" = 'percent' and "promotions"."value" between 1 and 100) or ("promotions"."kind" = 'fixed' and "promotions"."value" > 0)),
	CONSTRAINT "promotions_window_chk" CHECK ("promotions"."ends_at" is null or "promotions"."ends_at" > "promotions"."starts_at"),
	CONSTRAINT "promotions_max_uses_chk" CHECK ("promotions"."max_uses" is null or "promotions"."max_uses" > 0),
	CONSTRAINT "promotions_max_uses_per_person_chk" CHECK ("promotions"."max_uses_per_person" is null or "promotions"."max_uses_per_person" > 0),
	CONSTRAINT "promotions_uses_count_chk" CHECK ("promotions"."uses_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "provider_customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"provider" "payments_provider" NOT NULL,
	"provider_customer_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_customers_provider_customer_id_unique" UNIQUE("provider_customer_id"),
	CONSTRAINT "provider_customers_person_provider_uq" UNIQUE("person_id","provider")
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"reason" text NOT NULL,
	"lines" jsonb NOT NULL,
	"credit_action" "refunds_credit_action" NOT NULL,
	"provider_refund_id" text,
	"status" "refunds_status" DEFAULT 'pending' NOT NULL,
	"credit_note_id" uuid,
	"failed_reason" text,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refunds_provider_refund_id_unique" UNIQUE("provider_refund_id"),
	CONSTRAINT "refunds_amount_chk" CHECK ("refunds"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "vouchers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_line_id" uuid NOT NULL,
	"code_hash" text,
	"code_last4" text,
	"amount_cents" integer NOT NULL,
	"purchaser_person_id" uuid,
	"recipient_name" text,
	"recipient_email" text,
	"message" text,
	"deliver_on" date,
	"email_message_id" uuid,
	"status" "vouchers_status" DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone,
	"activated_at" timestamp with time zone,
	"redeemed_by_person_id" uuid,
	"redeemed_at" timestamp with time zone,
	"credit_grant_id" uuid,
	"voided_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vouchers_code_hash_unique" UNIQUE("code_hash"),
	CONSTRAINT "vouchers_amount_chk" CHECK ("vouchers"."amount_cents" between 500 and 100000),
	CONSTRAINT "vouchers_message_chk" CHECK ("vouchers"."message" is null or char_length("vouchers"."message") <= 500)
);
--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN "line_no" smallint NOT NULL;--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN "sku" text NOT NULL;--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN "data" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "reference" text DEFAULT 'BO-' || upper(substr(md5(gen_random_uuid()::text), 1, 8)) NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "renewal_membership_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "renewal_period_end_on" date;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "terms_version_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "withdrawal_until_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "pay_token_hash" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "pay_token_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "is_erased_subject" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "created_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "price_versions" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "item_category" "products_item_category";--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "is_custom_amount" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "min_amount_cents" integer;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "max_amount_cents" integer;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "is_shop_visible" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "is_pos_visible" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "image_file_id" uuid;--> statement-breakpoint
ALTER TABLE "checkouts" ADD CONSTRAINT "checkouts_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkouts" ADD CONSTRAINT "checkouts_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkouts" ADD CONSTRAINT "checkouts_recovery_message_id_email_messages_id_fk" FOREIGN KEY ("recovery_message_id") REFERENCES "public"."email_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkouts" ADD CONSTRAINT "checkouts_recovered_order_id_orders_id_fk" FOREIGN KEY ("recovered_order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandates" ADD CONSTRAINT "mandates_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_mandate_id_mandates_id_fk" FOREIGN KEY ("mandate_id") REFERENCES "public"."mandates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_prices" ADD CONSTRAINT "person_prices_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_prices" ADD CONSTRAINT "person_prices_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_prices" ADD CONSTRAINT "person_prices_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_day_closes" ADD CONSTRAINT "pos_day_closes_closed_by_user_id_users_id_fk" FOREIGN KEY ("closed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_redemptions" ADD CONSTRAINT "promotion_redemptions_promotion_id_promotions_id_fk" FOREIGN KEY ("promotion_id") REFERENCES "public"."promotions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_redemptions" ADD CONSTRAINT "promotion_redemptions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_redemptions" ADD CONSTRAINT "promotion_redemptions_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_customers" ADD CONSTRAINT "provider_customers_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_credit_note_id_invoices_id_fk" FOREIGN KEY ("credit_note_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_order_line_id_order_lines_id_fk" FOREIGN KEY ("order_line_id") REFERENCES "public"."order_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_purchaser_person_id_persons_id_fk" FOREIGN KEY ("purchaser_person_id") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_email_message_id_email_messages_id_fk" FOREIGN KEY ("email_message_id") REFERENCES "public"."email_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_redeemed_by_person_id_persons_id_fk" FOREIGN KEY ("redeemed_by_person_id") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_credit_grant_id_credit_grants_id_fk" FOREIGN KEY ("credit_grant_id") REFERENCES "public"."credit_grants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "checkouts_started_activity_idx" ON "checkouts" USING btree ("status","last_activity_at") WHERE "checkouts"."status" = 'started';--> statement-breakpoint
CREATE INDEX "checkouts_person_created_idx" ON "checkouts" USING btree ("person_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "checkouts_abandoned_idx" ON "checkouts" USING btree ("status","abandoned_at") WHERE "checkouts"."status" = 'abandoned';--> statement-breakpoint
CREATE INDEX "mandates_person_valid_idx" ON "mandates" USING btree ("person_id") WHERE "mandates"."status" = 'valid';--> statement-breakpoint
CREATE INDEX "payments_order_idx" ON "payments" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "payments_live_idx" ON "payments" USING btree ("status","created_at") WHERE "payments"."status" in ('open', 'pending', 'authorized');--> statement-breakpoint
CREATE INDEX "payments_failed_idx" ON "payments" USING btree ("status","updated_at") WHERE "payments"."status" = 'failed';--> statement-breakpoint
CREATE INDEX "person_prices_person_product_idx" ON "person_prices" USING btree ("person_id","product_id");--> statement-breakpoint
CREATE INDEX "promotion_redemptions_person_idx" ON "promotion_redemptions" USING btree ("promotion_id","person_id") WHERE "promotion_redemptions"."status" <> 'released';--> statement-breakpoint
CREATE UNIQUE INDEX "promotions_code_uq" ON "promotions" USING btree ("code") WHERE "promotions"."code" is not null;--> statement-breakpoint
CREATE INDEX "promotions_automatic_idx" ON "promotions" USING btree ("is_active","starts_at","ends_at") WHERE "promotions"."code" is null;--> statement-breakpoint
CREATE INDEX "refunds_order_idx" ON "refunds" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "refunds_open_idx" ON "refunds" USING btree ("status") WHERE "refunds"."status" in ('pending', 'sent', 'failed');--> statement-breakpoint
CREATE INDEX "vouchers_active_expires_idx" ON "vouchers" USING btree ("status","expires_at") WHERE "vouchers"."status" = 'active';--> statement-breakpoint
CREATE INDEX "vouchers_order_line_idx" ON "vouchers" USING btree ("order_line_id");--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_promotion_id_promotions_id_fk" FOREIGN KEY ("promotion_id") REFERENCES "public"."promotions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_checkout_id_checkouts_id_fk" FOREIGN KEY ("checkout_id") REFERENCES "public"."checkouts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_promotion_id_promotions_id_fk" FOREIGN KEY ("promotion_id") REFERENCES "public"."promotions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_image_file_id_files_id_fk" FOREIGN KEY ("image_file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "orders_pending_expires_idx" ON "orders" USING btree ("status","expires_at") WHERE "orders"."status" = 'pending_payment';--> statement-breakpoint
CREATE UNIQUE INDEX "orders_renewal_uq" ON "orders" USING btree ("renewal_membership_id","renewal_period_end_on") WHERE "orders"."renewal_membership_id" is not null and "orders"."status" in ('pending_payment', 'paid');--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_order_line_no_uq" UNIQUE("order_id","line_no");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_reference_unique" UNIQUE("reference");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_pay_token_hash_unique" UNIQUE("pay_token_hash");--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_session_chk" CHECK ("order_lines"."product_kind" not in ('session', 'night', 'ticket') or ("order_lines"."session_id" is not null and "order_lines"."quantity" = 1 and ("order_lines"."data"->'booking_ids' is null or (jsonb_typeof("order_lines"."data"->'booking_ids') = 'array' and jsonb_array_length("order_lines"."data"->'booking_ids') = 1))));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_renewal_chk" CHECK (("orders"."renewal_membership_id" is null) = ("orders"."renewal_period_end_on" is null));--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_custom_amount_chk" CHECK (not "products"."is_custom_amount" or ("products"."kind" = 'voucher' and 500 <= "products"."min_amount_cents" and "products"."min_amount_cents" <= "products"."max_amount_cents" and "products"."max_amount_cents" <= 100000));