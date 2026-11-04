create or replace function invoices_guard_immutable() returns trigger
language plpgsql as $$
declare
  rewrite boolean := coalesce(current_setting('beam.allow_rewrite', true), '') = 'on';
  anonymised jsonb := '{"anonymised": true}'::jsonb;
  changed text;
begin
  if tg_op = 'TRUNCATE' then
    if rewrite then return null; end if;
    raise exception 'invoice_immutable: truncate is not allowed' using errcode = '55000';
  end if;
  if tg_op = 'DELETE' then
    if rewrite then return old; end if;
    raise exception 'invoice_immutable: delete of % is not allowed', old.number
      using errcode = '55000', hint = 'Only the retention sweep deletes, under SET LOCAL beam.allow_rewrite = ''on''.';
  end if;

  select string_agg(n.key, ', ' order by n.key) into changed
    from jsonb_each(to_jsonb(new) - array['status', 'paid_at', 'settled_via', 'pdf_status', 'emailed_at', 'billit_id', 'billit_status', 'billit_synced_at', 'billit_attempts', 'billit_last_error', 'billit_failed_since', 'billit_payment_status', 'peppol_status', 'updated_at', 'payment_id', 'payment_provider', 'payment_method', 'payment_transaction_ref', 'seller_snapshot', 'pdf_file_id', 'person_id', 'customer_snapshot', 'company_id']::text[]) n
    where n.value is distinct from (to_jsonb(old) -> n.key);
  if changed is not null then
    raise exception 'invoice_immutable: % of % cannot change after issue', changed, old.number using errcode = '55000';
  end if;

  if new.status is distinct from old.status and not (
        (old.kind = 'invoice' and old.status = 'open' and new.status = 'paid')
        or (old.kind = 'invoice' and old.status = 'open' and new.status = 'cancelled')
        or (old.kind = 'invoice' and old.status = 'paid' and new.status = 'cancelled')
        or (old.kind = 'credit_note' and old.status = 'issued' and new.status = 'paid')) then
    raise exception 'invoice_immutable: status % -> % of % is not a valid transition', old.status, new.status, old.number
      using errcode = '55000';
  end if;
  if (old.payment_id is not null and new.payment_id is distinct from old.payment_id)
     or (old.payment_provider is not null and new.payment_provider is distinct from old.payment_provider)
     or (old.payment_method is not null and new.payment_method is distinct from old.payment_method)
     or (old.payment_transaction_ref is not null and new.payment_transaction_ref is distinct from old.payment_transaction_ref) then
    raise exception 'invoice_immutable: payment columns of % are set once', old.number using errcode = '55000';
  end if;
  if new.seller_snapshot is distinct from old.seller_snapshot
     and (old.pdf_status = 'rendered' or old.billit_id is not null) then
    raise exception 'invoice_immutable: seller_snapshot of % is frozen once rendered or in Billit', old.number using errcode = '55000';
  end if;
  if new.person_id is distinct from old.person_id and not (rewrite and new.person_id is null) then
    raise exception 'invoice_immutable: person_id of % changes only to null under beam.allow_rewrite', old.number using errcode = '55000';
  end if;
  if new.customer_snapshot is distinct from old.customer_snapshot and not (
       rewrite and (new.customer_snapshot = anonymised
         or (old.customer_snapshot is distinct from anonymised and coalesce((new.customer_snapshot ->> 'is_reduced')::boolean, false)))) then
    raise exception 'invoice_immutable: customer_snapshot of % changes only to the reduced or anonymised form under beam.allow_rewrite', old.number
      using errcode = '55000';
  end if;
  if new.company_id is distinct from old.company_id
     and not (rewrite and new.company_id is null and new.customer_snapshot = anonymised) then
    raise exception 'invoice_immutable: company_id of % changes only in the retention sweep', old.number using errcode = '55000';
  end if;
  if new.pdf_file_id is distinct from old.pdf_file_id and (
       (new.pdf_file_id is null and not (rewrite and new.customer_snapshot = anonymised))
       or (new.pdf_file_id is not null and old.customer_snapshot = anonymised)) then
    raise exception 'invoice_immutable: pdf_file_id of % cannot change this way', old.number using errcode = '55000';
  end if;
  return new;
end
$$;

drop trigger if exists invoices_guard_immutable on invoices;
create trigger invoices_guard_immutable before update or delete on invoices
  for each row execute function invoices_guard_immutable();
drop trigger if exists invoices_guard_truncate on invoices;
create trigger invoices_guard_truncate before truncate on invoices
  for each statement execute function invoices_guard_immutable();
