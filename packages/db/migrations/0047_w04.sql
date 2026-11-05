ALTER TABLE "invoices" DROP CONSTRAINT "chk_invoices_party";--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "chk_invoices_party" CHECK ("invoices"."person_id" is not null or "invoices"."company_id" is not null
        or coalesce(("invoices"."customer_snapshot"->>'is_reduced')::boolean, false)
        or coalesce(("invoices"."customer_snapshot"->>'anonymised')::boolean, false)
        or coalesce("invoices"."customer_snapshot"->>'kind' = 'walk_in', false)
        or coalesce("invoices"."customer_snapshot"->>'kind' = 'company' and nullif(btrim("invoices"."customer_snapshot"->>'vat_number'), '') is not null, false));