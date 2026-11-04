create or replace view v_finance_billit_backlog as
select i.id, i.number, i.kind, i.billit_status, i.billit_attempts, i.billit_last_error,
  i.billit_failed_since, i.created_at,
  (extract(epoch from now() - i.created_at) / 60)::int as age_minutes,
  (extract(epoch from now() - i.billit_failed_since) / 60)::int as failing_minutes
from invoices i
where i.billit_status <> 'synced';
--> statement-breakpoint
create or replace view v_finance_invoice_lines as
select i.id as invoice_id, i.number, i.kind, i.issued_on, i.fiscal_year, i.status, i.payment_method, i.is_company,
  l.order_line_id, l.product_id, l.sku, l.category, l.description, l.quantity, l.unit_amount_cents, l.discount_cents,
  l.line_total_cents, l.vat_rate_pct, l.vat_cents, l.net_cents, l.credit_kind, l.credit_units
from invoices i
cross join lateral jsonb_to_recordset(i.lines) as l(order_line_id uuid, product_id uuid, sku text, category text, description text,
  quantity numeric, unit_amount_cents int, discount_cents int, line_total_cents int, vat_rate_pct numeric, vat_cents int, net_cents int,
  credit_kind text, credit_units int);
--> statement-breakpoint
create or replace view v_invoice_balances as
select i.id as invoice_id, i.total_cents,
  (-coalesce(sum(cn.total_cents), 0))::int as credited_cents,
  (i.total_cents + coalesce(sum(cn.total_cents), 0))::int as remaining_cents,
  (i.total_cents + coalesce(sum(cn.total_cents), 0)) = 0 as is_fully_credited
from invoices i
left join invoices cn on cn.reverses_invoice_id = i.id and cn.kind = 'credit_note'
where i.kind = 'invoice'
group by i.id, i.total_cents;
--> statement-breakpoint
create or replace view v_finance_open_invoices as
select i.id, i.number, i.person_id, i.company_id, i.customer_snapshot ->> 'name' as customer_name,
  i.issued_on, i.total_cents, b.remaining_cents as amount_due_cents, i.due_on,
  greatest(0, (now() at time zone 'Europe/Brussels')::date - i.due_on)::int as days_overdue,
  i.payment_reference, i.billit_status
from invoices i
join v_invoice_balances b on b.invoice_id = i.id
where i.status = 'open';
--> statement-breakpoint
create or replace view v_finance_vat_summary as
select date_trunc('month', l.issued_on)::date as month,
  extract(quarter from l.issued_on)::int as quarter,
  l.fiscal_year, l.kind, l.vat_rate_pct,
  sum(l.net_cents)::int as net_cents,
  sum(l.vat_cents)::int as vat_cents,
  sum(l.line_total_cents)::int as gross_cents
from v_finance_invoice_lines l
group by 1, 2, l.fiscal_year, l.kind, l.vat_rate_pct;
