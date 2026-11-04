CREATE TYPE "public"."billit_reconcile_runs_status" AS ENUM('ok', 'issues', 'failed');--> statement-breakpoint
CREATE TYPE "public"."finance_exports_kind" AS ENUM('invoices', 'invoice_lines', 'vat_summary', 'payments', 'deferred_revenue', 'breakage', 'voucher_redemptions');--> statement-breakpoint
CREATE TYPE "public"."finance_exports_status" AS ENUM('queued', 'running', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."invoice_requests_status" AS ENUM('requested', 'approved', 'rejected', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."invoices_billit_payment_status" AS ENUM('not_applicable', 'pending', 'synced', 'failed');--> statement-breakpoint
CREATE TYPE "public"."invoices_pdf_status" AS ENUM('pending', 'rendered', 'failed');--> statement-breakpoint
CREATE TYPE "public"."invoices_peppol_status" AS ENUM('not_applicable', 'pending', 'sent', 'failed');--> statement-breakpoint
CREATE TYPE "public"."invoices_settled_via" AS ENUM('provider', 'billit', 'manual', 'credit_note');--> statement-breakpoint
CREATE TABLE "billit_parties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"party_key" text NOT NULL,
	"person_id" uuid,
	"company_id" uuid,
	"billit_party_id" text,
	"snapshot_hash" text,
	"synced_at" timestamp with time zone,
	"last_error" text,
	"is_anonymised" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billit_parties_party_key_unique" UNIQUE("party_key"),
	CONSTRAINT "billit_parties_billit_party_id_unique" UNIQUE("billit_party_id"),
	CONSTRAINT "chk_billit_parties_key" CHECK ("billit_parties"."party_key" = 'walk_in' or "billit_parties"."party_key" ~ '^(person|company):[0-9a-f-]{36}$' or "billit_parties"."party_key" ~ '^vat:[A-Z]{2}[0-9A-Z+*]{2,13}$')
);
--> statement-breakpoint
CREATE TABLE "billit_reconcile_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_on" date NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"status" "billit_reconcile_runs_status" NOT NULL,
	"checked_count" integer DEFAULT 0 NOT NULL,
	"issues_count" integer DEFAULT 0 NOT NULL,
	"issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billit_reconcile_runs_run_on_unique" UNIQUE("run_on"),
	CONSTRAINT "chk_billit_reconcile_runs_counts" CHECK ("billit_reconcile_runs"."checked_count" >= 0 and "billit_reconcile_runs"."issues_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "finance_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "finance_exports_kind" NOT NULL,
	"period_from" date NOT NULL,
	"period_to" date NOT NULL,
	"status" "finance_exports_status" DEFAULT 'queued' NOT NULL,
	"file_id" uuid,
	"row_count" integer,
	"error" text,
	"requested_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_finance_exports_period" CHECK ("finance_exports"."period_to" >= "finance_exports"."period_from" and "finance_exports"."period_to" - "finance_exports"."period_from" <= 365),
	CONSTRAINT "chk_finance_exports_row_count" CHECK ("finance_exports"."row_count" is null or "finance_exports"."row_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "invoice_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"person_id" uuid,
	"billing" jsonb NOT NULL,
	"status" "invoice_requests_status" DEFAULT 'requested' NOT NULL,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"credit_note_id" uuid,
	"new_invoice_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_invoice_requests_decided" CHECK ("invoice_requests"."status" not in ('approved', 'rejected') or "invoice_requests"."decided_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "order_billing_details" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"is_company" boolean DEFAULT false NOT NULL,
	"legal_name" text NOT NULL,
	"vat_number" text,
	"address" jsonb NOT NULL,
	"billing_email" text,
	"purchase_order_ref" text,
	"peppol_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_billing_details_order_id_unique" UNIQUE("order_id"),
	CONSTRAINT "chk_obd_company_vat" CHECK (not "order_billing_details"."is_company" or "order_billing_details"."vat_number" is not null),
	CONSTRAINT "chk_obd_legal_name" CHECK (length(trim("order_billing_details"."legal_name")) >= 2),
	CONSTRAINT "chk_obd_vat_format" CHECK ("order_billing_details"."vat_number" is null or "order_billing_details"."vat_number" ~ '^[A-Z]{2}[0-9A-Z+*]{2,13}$')
);
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "fiscal_year" smallint NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "sequence_number" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "replaces_invoice_id" uuid;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "payment_id" uuid;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "refund_id" uuid;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "is_company" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "locale" "locale" NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "currency" char(3) DEFAULT 'EUR' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "seller_snapshot" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "issued_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "paid_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "settled_via" "invoices_settled_via";--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "payment_provider" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "payment_method" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "payment_transaction_ref" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "payment_reference" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "pdf_status" "invoices_pdf_status" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "emailed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "billit_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "billit_last_error" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "billit_failed_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "billit_payment_status" "invoices_billit_payment_status" DEFAULT 'not_applicable' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "peppol_status" "invoices_peppol_status" DEFAULT 'not_applicable' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "issued_by" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "billit_parties" ADD CONSTRAINT "billit_parties_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billit_parties" ADD CONSTRAINT "billit_parties_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_exports" ADD CONSTRAINT "finance_exports_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_exports" ADD CONSTRAINT "finance_exports_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_requests" ADD CONSTRAINT "invoice_requests_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_requests" ADD CONSTRAINT "invoice_requests_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_requests" ADD CONSTRAINT "invoice_requests_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_requests" ADD CONSTRAINT "invoice_requests_credit_note_id_invoices_id_fk" FOREIGN KEY ("credit_note_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_requests" ADD CONSTRAINT "invoice_requests_new_invoice_id_invoices_id_fk" FOREIGN KEY ("new_invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_billing_details" ADD CONSTRAINT "order_billing_details_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_billit_parties_person" ON "billit_parties" USING btree ("person_id") WHERE "billit_parties"."person_id" is not null;--> statement-breakpoint
CREATE INDEX "ix_finance_exports_created" ON "finance_exports" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_invoice_requests_pending" ON "invoice_requests" USING btree ("invoice_id") WHERE "invoice_requests"."status" = 'requested';--> statement-breakpoint
CREATE INDEX "ix_invoice_requests_status" ON "invoice_requests" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "ix_invoice_requests_person" ON "invoice_requests" USING btree ("person_id") WHERE "invoice_requests"."person_id" is not null;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_replaces_invoice_id_invoices_id_fk" FOREIGN KEY ("replaces_invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_refund_id_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refunds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_invoices_person" ON "invoices" USING btree ("person_id","issued_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ix_invoices_company" ON "invoices" USING btree ("company_id") WHERE "invoices"."company_id" is not null;--> statement-breakpoint
CREATE INDEX "ix_invoices_open" ON "invoices" USING btree ("due_on") WHERE "invoices"."status" = 'open';--> statement-breakpoint
CREATE INDEX "ix_invoices_billit_backlog" ON "invoices" USING btree ("billit_status","created_at") WHERE "invoices"."billit_status" <> 'synced';--> statement-breakpoint
CREATE INDEX "ix_invoices_pdf_pending" ON "invoices" USING btree ("created_at") WHERE "invoices"."pdf_status" <> 'rendered';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_invoices_kind_year_sequence" ON "invoices" USING btree ("kind","fiscal_year","sequence_number");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_invoices_order_live" ON "invoices" USING btree ("order_id") WHERE "invoices"."kind" = 'invoice' and "invoices"."status" <> 'cancelled';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_invoices_refund" ON "invoices" USING btree ("refund_id") WHERE "invoices"."refund_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_invoices_payment_reference" ON "invoices" USING btree ("payment_reference") WHERE "invoices"."payment_reference" is not null;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "chk_invoices_kind_amounts" CHECK (("invoices"."kind" = 'invoice' and "invoices"."total_cents" >= 0 and "invoices"."subtotal_cents" >= 0) or ("invoices"."kind" = 'credit_note' and "invoices"."total_cents" <= 0 and "invoices"."subtotal_cents" <= 0));--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "chk_invoices_vat_sign" CHECK (("invoices"."kind" = 'invoice' and "invoices"."vat_cents" >= 0) or ("invoices"."kind" = 'credit_note' and "invoices"."vat_cents" <= 0));--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "chk_invoices_reverses" CHECK (("invoices"."kind" = 'credit_note') = ("invoices"."reverses_invoice_id" is not null));--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "chk_invoices_replaces" CHECK ("invoices"."replaces_invoice_id" is null or "invoices"."kind" = 'invoice');--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "chk_invoices_refund" CHECK ("invoices"."refund_id" is null or "invoices"."kind" = 'credit_note');--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "chk_invoices_reason" CHECK ("invoices"."kind" = 'invoice' or coalesce(length(trim("invoices"."reason")), 0) >= 3);--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "chk_invoices_open_due" CHECK ("invoices"."status" <> 'open' or ("invoices"."kind" = 'invoice' and "invoices"."due_on" is not null));--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "chk_invoices_paid_at" CHECK ("invoices"."status" <> 'paid' or "invoices"."paid_at" is not null);--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "chk_invoices_number_prefix" CHECK ("invoices"."number" like case "invoices"."kind" when 'invoice' then 'BEAM-%' else 'CN-%' end);--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "chk_invoices_number_format" CHECK ("invoices"."number" = (case "invoices"."kind" when 'invoice' then 'BEAM-' else 'CN-' end) || "invoices"."fiscal_year"::text || '-' || lpad("invoices"."sequence_number"::text, 6, '0'));--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "chk_invoices_status_kind" CHECK (("invoices"."kind" = 'invoice' and "invoices"."status" in ('paid', 'open', 'cancelled')) or ("invoices"."kind" = 'credit_note' and "invoices"."status" in ('issued', 'paid')));--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "chk_invoices_party" CHECK ("invoices"."person_id" is not null or "invoices"."company_id" is not null
        or coalesce(("invoices"."customer_snapshot"->>'is_reduced')::boolean, false)
        or coalesce(("invoices"."customer_snapshot"->>'anonymised')::boolean, false)
        or coalesce("invoices"."customer_snapshot"->>'kind' = 'walk_in', false));--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "chk_invoices_sequence_number" CHECK ("invoices"."sequence_number" > 0);--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "chk_invoices_fiscal_year" CHECK ("invoices"."fiscal_year" = extract(year from "invoices"."issued_on")::int);--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "chk_invoices_currency" CHECK ("invoices"."currency" = 'EUR');--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "chk_invoices_lines" CHECK (case when jsonb_typeof("invoices"."lines") = 'array' then jsonb_array_length("invoices"."lines") >= 1 else false end);--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "chk_invoices_billit_attempts" CHECK ("invoices"."billit_attempts" >= 0);