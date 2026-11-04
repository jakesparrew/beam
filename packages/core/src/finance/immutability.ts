/**
 * Column-level immutability of `invoices` after issue (finance section 2.2), enforced twice:
 * in code by `assertMutableUpdate()` (called by `updateInvoiceState()`, the only writer) and in
 * the database by trigger `invoices_guard_immutable()`, whose SQL is `INVOICES_GUARD_TRIGGER_SQL`
 * (the orchestrator puts it in the custom migration `finance_invoices_guard.sql`). Both use the
 * column lists below, and every column not listed is frozen, new columns included.
 *
 * - Always mutable: `status` (per the transition table), `paid_at`, `settled_via`, `pdf_status`,
 *   `emailed_at`, `billit_*`, `peppol_status`, `updated_at`.
 * - `payment_id`, `payment_provider`, `payment_method`, `payment_transaction_ref`: only from null.
 * - `seller_snapshot`: only while `pdf_status <> 'rendered' and billit_id is null`.
 * - `pdf_file_id`: to a file unless the document was anonymised by the retention sweep.
 * - Under `SET LOCAL beam.allow_rewrite = 'on'` (mode `rewrite`): `person_id` to null and
 *   `customer_snapshot` to the reduced form (erasure); for the retention sweep only, with the
 *   snapshot `{ "anonymised": true }`, also `company_id` and `pdf_file_id` to null. Deletes are
 *   refused except under `beam.allow_rewrite`.
 */
import { isAnonymisedSnapshot, isReducedSnapshot } from "./snapshot";
import { INVOICE_TRANSITIONS, nextInvoiceStatus } from "./transitions";
import type { InvoiceRecord, InvoiceStatus } from "./types";

/** Columns any update may change (snake_case SQL names). */
export const INVOICE_MUTABLE_COLUMNS = [
  "status",
  "paid_at",
  "settled_via",
  "pdf_status",
  "emailed_at",
  "billit_id",
  "billit_status",
  "billit_synced_at",
  "billit_attempts",
  "billit_last_error",
  "billit_failed_since",
  "billit_payment_status",
  "peppol_status",
  "updated_at",
] as const;

/** Settlement snapshot columns: set once, from null to a value. */
export const INVOICE_SET_ONCE_COLUMNS = ["payment_id", "payment_provider", "payment_method", "payment_transaction_ref"] as const;

/** Columns with their own rule (see the file comment). */
export const INVOICE_CONDITIONAL_COLUMNS = ["seller_snapshot", "pdf_file_id", "person_id", "customer_snapshot", "company_id"] as const;

/** Every column the frozen-columns comparison skips. */
export const INVOICE_UNGUARDED_COLUMNS: readonly string[] = [...INVOICE_MUTABLE_COLUMNS, ...INVOICE_SET_ONCE_COLUMNS, ...INVOICE_CONDITIONAL_COLUMNS];

export class InvoiceImmutableError extends Error {
  override readonly name: string = "InvoiceImmutableError";
  readonly code = "conflict" as const;
  readonly column: string;
  readonly reason: string;
  constructor(column: string, reason: string) {
    super("finance.errors.invoice_immutable");
    this.column = column;
    this.reason = reason;
  }
}

const snake = (key: string) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const camel = (key: string) => key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

function same(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) {
    const ta = a instanceof Date ? a.getTime() : a == null ? a : new Date(a as string).getTime();
    const tb = b instanceof Date ? b.getTime() : b == null ? b : new Date(b as string).getTime();
    return ta === tb;
  }
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
    );
  }
  return v ?? null;
}

/**
 * Throws `InvoiceImmutableError` when `patch` (Drizzle property names or snake_case column
 * names) changes a column that `mode` does not allow for `current`. Unchanged values pass.
 */
export function assertMutableUpdate(patch: Record<string, unknown>, current: InvoiceRecord, mode: "normal" | "rewrite"): void {
  const cur = current as unknown as Record<string, unknown>;
  const changes = new Map<string, unknown>();
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const column = snake(camel(key));
    if (!same(value, cur[camel(column)])) changes.set(column, value);
  }
  const anonymising = changes.has("customer_snapshot") ? isAnonymisedSnapshot(changes.get("customer_snapshot")) : isAnonymisedSnapshot(current.customerSnapshot);
  const refuse = (column: string, reason: string): never => {
    throw new InvoiceImmutableError(column, reason);
  };

  for (const [column, value] of changes) {
    if ((INVOICE_MUTABLE_COLUMNS as readonly string[]).includes(column)) {
      if (column === "status") {
        try {
          nextInvoiceStatus(current.kind, current.status, value as InvoiceStatus);
        } catch {
          refuse(column, "invalid_transition");
        }
      }
      continue;
    }
    if ((INVOICE_SET_ONCE_COLUMNS as readonly string[]).includes(column)) {
      if (cur[camel(column)] != null) refuse(column, "set_once");
      continue;
    }
    switch (column) {
      case "seller_snapshot":
        if (current.pdfStatus === "rendered" || current.billitId != null) refuse(column, "already_rendered_or_synced");
        break;
      case "pdf_file_id":
        if (value === null) {
          if (mode !== "rewrite" || !anonymising) refuse(column, "retention_only");
        } else if (isAnonymisedSnapshot(current.customerSnapshot)) {
          refuse(column, "anonymised");
        }
        break;
      case "person_id":
        if (mode !== "rewrite" || value !== null) refuse(column, "rewrite_to_null_only");
        break;
      case "company_id":
        if (mode !== "rewrite" || value !== null || !anonymising) refuse(column, "retention_only");
        break;
      case "customer_snapshot":
        if (mode !== "rewrite") refuse(column, "rewrite_only");
        if (!isAnonymisedSnapshot(value) && !isReducedSnapshot(value)) refuse(column, "reduced_or_anonymised_only");
        if (isAnonymisedSnapshot(current.customerSnapshot) && !isAnonymisedSnapshot(value)) refuse(column, "anonymised");
        break;
      default:
        refuse(column, "frozen");
    }
  }
}

const list = (cols: readonly string[]) => cols.map((c) => `'${c}'`).join(", ");

const transitionSql = INVOICE_TRANSITIONS.filter(([, from]) => from !== null)
  .map(([kind, from, to]) => `(old.kind = '${kind}' and old.status = '${from}' and new.status = '${to}')`)
  .join("\n        or ");

/** The guard trigger (custom migration `finance_invoices_guard.sql`); idempotent. */
export const INVOICES_GUARD_TRIGGER_SQL = `create or replace function invoices_guard_immutable() returns trigger
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
    from jsonb_each(to_jsonb(new) - array[${list(INVOICE_UNGUARDED_COLUMNS)}]::text[]) n
    where n.value is distinct from (to_jsonb(old) -> n.key);
  if changed is not null then
    raise exception 'invoice_immutable: % of % cannot change after issue', changed, old.number using errcode = '55000';
  end if;

  if new.status is distinct from old.status and not (
        ${transitionSql}) then
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
`;
