CREATE TYPE "public"."partner_commissions_status" AS ENUM('accrued', 'approved', 'paid', 'void');--> statement-breakpoint
CREATE TYPE "public"."referral_attributions_source" AS ENUM('code', 'link', 'staff', 'import');--> statement-breakpoint
CREATE TYPE "public"."referral_attributions_status" AS ENUM('pending', 'qualified', 'rewarded', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."opportunities_stage" AS ENUM('target', 'prospect_identified', 'contact_identified', 'outreach', 'response', 'qualified', 'discovery', 'proposal', 'negotiation', 'won', 'lost', 'account_management', 'renewal');--> statement-breakpoint
CREATE TYPE "public"."playbook_stages_pipeline" AS ENUM('b2b', 'b2c');--> statement-breakpoint
CREATE TABLE "partner_commissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"partner_company_id" uuid NOT NULL,
	"attribution_id" uuid,
	"order_id" uuid NOT NULL,
	"refund_id" uuid,
	"base_cents" integer NOT NULL,
	"commission_pct" numeric(5, 2) NOT NULL,
	"amount_cents" integer NOT NULL,
	"status" "partner_commissions_status" DEFAULT 'accrued' NOT NULL,
	"period_month" date NOT NULL,
	"approved_by_user_id" uuid,
	"paid_at" timestamp with time zone,
	"note" text,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "partner_commissions_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "partner_commissions_pct_ck" CHECK ("partner_commissions"."commission_pct" between 0 and 100),
	CONSTRAINT "partner_commissions_refund_sign_ck" CHECK ("partner_commissions"."refund_id" is not null or "partner_commissions"."base_cents" >= 0),
	CONSTRAINT "partner_commissions_period_ck" CHECK (extract(day from "partner_commissions"."period_month") = 1),
	CONSTRAINT "partner_commissions_paid_ck" CHECK ("partner_commissions"."status" <> 'paid' or "partner_commissions"."paid_at" is not null),
	CONSTRAINT "partner_commissions_note_ck" CHECK ("partner_commissions"."note" is null or length("partner_commissions"."note") <= 1000)
);
--> statement-breakpoint
CREATE TABLE "referral_attributions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"referred_person_id" uuid NOT NULL,
	"code_id" uuid,
	"referrer_person_id" uuid,
	"partner_company_id" uuid,
	"source" "referral_attributions_source" NOT NULL,
	"status" "referral_attributions_status" DEFAULT 'pending' NOT NULL,
	"attributed_at" timestamp with time zone NOT NULL,
	"first_paid_order_id" uuid,
	"first_paid_at" timestamp with time zone,
	"qualifies_at" timestamp with time zone,
	"commission_until_at" timestamp with time zone,
	"rejected_reason" text,
	"referrer_reward_grant_id" uuid,
	"referee_reward_grant_id" uuid,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "referral_attributions_referred_person_id_unique" UNIQUE("referred_person_id"),
	CONSTRAINT "referral_attributions_party_ck" CHECK (num_nonnulls("referral_attributions"."referrer_person_id", "referral_attributions"."partner_company_id") >= 1),
	CONSTRAINT "referral_attributions_self_ck" CHECK ("referral_attributions"."referrer_person_id" is distinct from "referral_attributions"."referred_person_id"),
	CONSTRAINT "referral_attributions_qualified_ck" CHECK ("referral_attributions"."status" <> 'qualified' or ("referral_attributions"."first_paid_order_id" is not null and "referral_attributions"."first_paid_at" is not null and "referral_attributions"."qualifies_at" is not null)),
	CONSTRAINT "referral_attributions_rejected_ck" CHECK (("referral_attributions"."status" = 'rejected') = ("referral_attributions"."rejected_reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "referral_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"person_id" uuid,
	"partner_company_id" uuid,
	"referrer_reward" jsonb,
	"referee_reward" jsonb,
	"max_uses" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "referral_codes_code_ck" CHECK ("referral_codes"."code" ~ '^[A-Z0-9]{6,12}$'),
	CONSTRAINT "referral_codes_owner_ck" CHECK (num_nonnulls("referral_codes"."person_id", "referral_codes"."partner_company_id") = 1),
	CONSTRAINT "referral_codes_max_uses_ck" CHECK ("referral_codes"."max_uses" is null or "referral_codes"."max_uses" > 0)
);
--> statement-breakpoint
CREATE TABLE "opportunities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"title" text NOT NULL,
	"primary_contact_person_id" uuid,
	"stage" "opportunities_stage" DEFAULT 'target' NOT NULL,
	"stage_entered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"value_cents" integer DEFAULT 0 NOT NULL,
	"probability_pct" smallint DEFAULT 10 NOT NULL,
	"probability_set_manually_at" timestamp with time zone,
	"expected_close_on" date,
	"owner_user_id" uuid NOT NULL,
	"next_action" text,
	"next_action_at" timestamp with time zone,
	"lost_reason" text,
	"won_at" timestamp with time zone,
	"lost_at" timestamp with time zone,
	"source" text,
	"notes" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "opportunities_value_ck" CHECK ("opportunities"."value_cents" >= 0),
	CONSTRAINT "opportunities_probability_ck" CHECK ("opportunities"."probability_pct" between 0 and 100),
	CONSTRAINT "opportunities_lost_reason_ck" CHECK ("opportunities"."stage" <> 'lost' or "opportunities"."lost_reason" is not null),
	CONSTRAINT "opportunities_title_ck" CHECK (char_length("opportunities"."title") between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "playbook_stages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pipeline" "playbook_stages_pipeline" NOT NULL,
	"stage_key" text NOT NULL,
	"sort_order" smallint NOT NULL,
	"name" jsonb NOT NULL,
	"required_action" jsonb NOT NULL,
	"owner_role" text NOT NULL,
	"deadline_days" smallint DEFAULT 3 NOT NULL,
	"default_probability_pct" smallint,
	"automated_communication" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"human_communication" jsonb,
	"escalation" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"kpi" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "playbook_stages_deadline_ck" CHECK ("playbook_stages"."deadline_days" between 0 and 365),
	CONSTRAINT "playbook_stages_probability_ck" CHECK ("playbook_stages"."default_probability_pct" is null or ("playbook_stages"."pipeline" = 'b2b' and "playbook_stages"."default_probability_pct" between 0 and 100))
);
--> statement-breakpoint
ALTER TABLE "credit_grants" ADD COLUMN "referral_attribution_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "opportunity_id" uuid;--> statement-breakpoint
ALTER TABLE "partner_commissions" ADD CONSTRAINT "partner_commissions_partner_company_id_companies_id_fk" FOREIGN KEY ("partner_company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_commissions" ADD CONSTRAINT "partner_commissions_attribution_id_referral_attributions_id_fk" FOREIGN KEY ("attribution_id") REFERENCES "public"."referral_attributions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_commissions" ADD CONSTRAINT "partner_commissions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_commissions" ADD CONSTRAINT "partner_commissions_refund_id_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refunds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_commissions" ADD CONSTRAINT "partner_commissions_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_attributions" ADD CONSTRAINT "referral_attributions_referred_person_id_persons_id_fk" FOREIGN KEY ("referred_person_id") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_attributions" ADD CONSTRAINT "referral_attributions_code_id_referral_codes_id_fk" FOREIGN KEY ("code_id") REFERENCES "public"."referral_codes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_attributions" ADD CONSTRAINT "referral_attributions_referrer_person_id_persons_id_fk" FOREIGN KEY ("referrer_person_id") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_attributions" ADD CONSTRAINT "referral_attributions_partner_company_id_companies_id_fk" FOREIGN KEY ("partner_company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_attributions" ADD CONSTRAINT "referral_attributions_first_paid_order_id_orders_id_fk" FOREIGN KEY ("first_paid_order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_attributions" ADD CONSTRAINT "referral_attributions_referrer_reward_grant_id_credit_grants_id_fk" FOREIGN KEY ("referrer_reward_grant_id") REFERENCES "public"."credit_grants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_attributions" ADD CONSTRAINT "referral_attributions_referee_reward_grant_id_credit_grants_id_fk" FOREIGN KEY ("referee_reward_grant_id") REFERENCES "public"."credit_grants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_attributions" ADD CONSTRAINT "referral_attributions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_codes" ADD CONSTRAINT "referral_codes_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_codes" ADD CONSTRAINT "referral_codes_partner_company_id_companies_id_fk" FOREIGN KEY ("partner_company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_codes" ADD CONSTRAINT "referral_codes_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_primary_contact_person_id_persons_id_fk" FOREIGN KEY ("primary_contact_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbook_stages" ADD CONSTRAINT "playbook_stages_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "partner_commissions_partner_month_idx" ON "partner_commissions" USING btree ("partner_company_id","period_month");--> statement-breakpoint
CREATE INDEX "partner_commissions_order_idx" ON "partner_commissions" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "referral_attributions_referrer_idx" ON "referral_attributions" USING btree ("referrer_person_id");--> statement-breakpoint
CREATE INDEX "referral_attributions_partner_idx" ON "referral_attributions" USING btree ("partner_company_id");--> statement-breakpoint
CREATE INDEX "referral_attributions_status_qualifies_idx" ON "referral_attributions" USING btree ("status","qualifies_at");--> statement-breakpoint
CREATE UNIQUE INDEX "referral_codes_code_uq" ON "referral_codes" USING btree (upper("code"));--> statement-breakpoint
CREATE UNIQUE INDEX "referral_codes_person_active_uq" ON "referral_codes" USING btree ("person_id") WHERE "referral_codes"."is_active" and "referral_codes"."person_id" is not null;--> statement-breakpoint
CREATE INDEX "referral_codes_partner_idx" ON "referral_codes" USING btree ("partner_company_id");--> statement-breakpoint
CREATE INDEX "opportunities_stage_idx" ON "opportunities" USING btree ("stage");--> statement-breakpoint
CREATE INDEX "opportunities_owner_idx" ON "opportunities" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "opportunities_company_idx" ON "opportunities" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "opportunities_contact_idx" ON "opportunities" USING btree ("primary_contact_person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "playbook_stages_pipeline_stage_uq" ON "playbook_stages" USING btree ("pipeline","stage_key");--> statement-breakpoint
ALTER TABLE "credit_grants" ADD CONSTRAINT "credit_grants_referral_attribution_id_referral_attributions_id_fk" FOREIGN KEY ("referral_attribution_id") REFERENCES "public"."referral_attributions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tasks_opportunity_idx" ON "tasks" USING btree ("opportunity_id");