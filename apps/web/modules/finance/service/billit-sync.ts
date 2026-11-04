/**
 * Billit sync (finance spec rules 30 to 35, section 4.5 and 6; finance-P4): the handlers behind
 * `billit.push_customer`, `billit.push_invoice`, `billit.push_credit_note`, `billit.send_peppol`,
 * `billit.push_payment` and `billit.sync_pending`.
 *
 * Idempotency (rule 31, edge case 8): our number is Billit's order number and reference; before
 * any create the push re-reads `billit_id` and otherwise asks `findOrderByReference(number)`, so
 * a lost response never creates a duplicate; `billit_id` is also written outside the job
 * transaction right after create, before any follow-up (Peppol send) is queued. Parties are keyed
 * by `billit_parties.party_key` and pushed again only when the sha256 of the payload changed.
 *
 * With `settings.finance.billit_enabled = false` every handler succeeds without calling Billit
 * and documents stay `pending` (rule 34); `billit.sync_pending` re-queues them later.
 */
import { createHash } from "node:crypto";
import type { DbOrTx } from "@beam/db";
import { billitParties, companies, invoices, jobs, payments, persons } from "@beam/db/schema";
import { buildCustomerSnapshot, isAnonymisedSnapshot, type CompanyForBilling, type FullCustomerSnapshot, type InvoiceRecord, type PersonForBilling } from "@beam/core/finance";
import { localDateKey, wallClock, zonedTimeToUtc } from "@beam/core/platform";
import { IntegrationError } from "@beam/integrations/_shared";
import { isBillitAuthError, type BillitApi, type BillitPartyInput } from "@beam/integrations/billit";
import { and, asc, desc, enqueueJob, eq, inArray, isNotNull, lt, lte, ne, sql, writeDurably, type JobKind } from "@/lib/ctx";
import { RetryableError, type JobCtx } from "@/lib/job-runner";
import { logger } from "@/lib/logger";
import { getSetting } from "@/lib/settings";
import { recordBankTransferPaid } from "@/modules/commerce/api";
import { createTask } from "@/modules/crm/api";
import { readFile, notifySlack } from "@/modules/platform/api";
import {
  billitPartyKey,
  toBillitOrder,
  toBillitParty,
  toBillitPayment,
  type BillitPaymentPart,
} from "../../../../../packages/core/src/finance/billit-mapping";
import { raiseAuthAlert, withBillitFailure } from "./billit-failure";
import { enqueueFinanceJob, eventSubject, findInvoice, loadInvoice, updateInvoiceState, type InvoiceMutableFields } from "./invoice-state";
import { markInvoicePaidInternal } from "./settle";

export type FinanceSettingValue = Awaited<ReturnType<typeof financeSettings>>;
export const financeSettings = (tx: DbOrTx) => getSetting(tx, "finance");

const PUSH_KIND = { invoice: "billit.push_invoice", credit_note: "billit.push_credit_note" } as const;
export const billitDocumentKey = (doc: Pick<InvoiceRecord, "id" | "kind">) => `billit:${doc.kind}:${doc.id}`;
export const billitPaymentKey = (invoiceId: string) => `billit:payment:${invoiceId}`;
export const billitPeppolKey = (invoiceId: string) => `billit:peppol:${invoiceId}`;

/** The order's paid payments, for the `mixed` method and the split comment (rule 8a). */
export async function paidPaymentParts(tx: DbOrTx, orderId: string): Promise<BillitPaymentPart[]> {
  const rows = await tx
    .select({ provider: payments.provider, method: payments.method, amountCents: payments.amountCents, status: payments.status })
    .from(payments)
    .where(eq(payments.orderId, orderId));
  return rows.filter((r) => ["paid", "refunded", "partially_refunded"].includes(String(r.status))).map(({ provider, method, amountCents }) => ({ provider: String(provider), method, amountCents }));
}

/** 12:00 Brussels on a `YYYY-MM-DD` day (rule 26: Billit's paid date). */
export function brusselsNoon(day: string): Date {
  const [year, month, d] = day.split("-").map(Number);
  return zonedTimeToUtc({ year: year!, month: month!, day: d!, hour: 12, minute: 0 });
}

/** The Brussels date of an instant (`YYYY-MM-DD`). */
export function brusselsDay(at: Date): string {
  return localDateKey(wallClock(at));
}

/** Next business day (Monday to Friday) after `now`, at 10:00 Brussels (rules 29 and 33). */
export function nextBusinessDayAt10(now: Date): Date {
  const local = wallClock(now);
  const noonUtc = new Date(Date.UTC(local.year, local.month - 1, local.day, 12));
  do noonUtc.setUTCDate(noonUtc.getUTCDate() + 1);
  while (noonUtc.getUTCDay() === 0 || noonUtc.getUTCDay() === 6);
  return zonedTimeToUtc({ year: noonUtc.getUTCFullYear(), month: noonUtc.getUTCMonth() + 1, day: noonUtc.getUTCDate(), hour: 10, minute: 0 });
}

/** A company document for a Belgian VAT-registered buyer (rule 19a). */
export function isBelgianVatBuyer(doc: InvoiceRecord): boolean {
  const s = doc.customerSnapshot;
  return !isAnonymisedSnapshot(s) && !!s.vat_number?.toUpperCase().startsWith("BE");
}

const hasVatNumber = (doc: InvoiceRecord) => {
  const s = doc.customerSnapshot;
  return !isAnonymisedSnapshot(s) && !!s.vat_number;
};

// ---------------------------------------------------------------------------
// Re-queueing pushes
// ---------------------------------------------------------------------------

/**
 * Enqueues a push for `doc` on `db` unless one is live (`pending` or `running`). The first push
 * uses `billit:<kind>:<id>`, later ones `...:r<n>`. With `skipPermanent`, a document whose newest
 * push died before using its attempts (a permanent 4xx, edge case 9) is left to staff's Retry.
 */
export async function enqueueBillitPush(
  db: DbOrTx,
  doc: Pick<InvoiceRecord, "id" | "kind">,
  opts: { requestId?: string; skipPermanent?: boolean; kind?: "document" | "payment" } = {},
): Promise<{ id: string; inserted: boolean } | null> {
  const kind: JobKind = opts.kind === "payment" ? "billit.push_payment" : PUSH_KIND[doc.kind];
  const base = opts.kind === "payment" ? billitPaymentKey(doc.id) : billitDocumentKey(doc);
  const rows = await db
    .select({ status: jobs.status, attempts: jobs.attempts, maxAttempts: jobs.maxAttempts })
    .from(jobs)
    .where(and(eq(jobs.kind, kind), sql`${jobs.payload}->>'invoiceId' = ${doc.id}`))
    .orderBy(desc(jobs.createdAt), desc(jobs.id));
  if (rows.some((r) => r.status === "pending" || r.status === "running")) return null;
  const newest = rows[0];
  if (opts.skipPermanent && newest?.status === "dead" && newest.attempts < newest.maxAttempts) return null;
  const key = rows.length === 0 ? base : `${base}:r${rows.length}`;
  return enqueueJob(db, { kind, payload: { invoiceId: doc.id }, key }, opts.requestId);
}

// ---------------------------------------------------------------------------
// Parties
// ---------------------------------------------------------------------------

const hashOf = (payload: BillitPartyInput) => createHash("sha256").update(JSON.stringify(payload)).digest("hex");

/**
 * Pushes the party for `key` when its payload hash changed (or it has no Billit id yet) and stores
 * `billit_party_id`, `snapshot_hash` and `synced_at`, in the job transaction and durably. An
 * anonymised party never sends email or phone again (edge case 31).
 */
export async function upsertBillitParty(
  ctx: JobCtx,
  api: BillitApi,
  key: string,
  payload: BillitPartyInput,
  links: { personId: string | null; companyId: string | null },
): Promise<{ partyId: string; pushed: boolean }> {
  const [row] = await ctx.tx.select().from(billitParties).where(eq(billitParties.partyKey, key));
  const body: BillitPartyInput = row?.isAnonymised ? { ...payload, Email: null, Phone: null, Mobile: null } : payload;
  const hash = hashOf(body);
  if (row?.billitPartyId && row.snapshotHash === hash) return { partyId: row.billitPartyId, pushed: false };

  const { partyId } = await api.upsertParty({ ...body, ...(row?.billitPartyId ? { PartyID: row.billitPartyId } : {}), ExternalProviderID: key });
  const write = async (db: DbOrTx) => {
    await db
      .insert(billitParties)
      .values({ partyKey: key, personId: row ? row.personId : links.personId, companyId: row ? row.companyId : links.companyId, billitPartyId: partyId, snapshotHash: hash, syncedAt: ctx.now, lastError: null })
      .onConflictDoUpdate({ target: billitParties.partyKey, set: { billitPartyId: partyId, snapshotHash: hash, syncedAt: ctx.now, lastError: null, updatedAt: sql`now()` } });
  };
  await write(ctx.tx);
  await writeDurably(ctx, write);
  return { partyId, pushed: true };
}

/** The Billit party of a document: its keyed party, else the original's Billit customer, else a one-off party. */
async function partyForDocument(ctx: JobCtx, api: BillitApi, doc: InvoiceRecord, original: InvoiceRecord | null): Promise<string> {
  const key = billitPartyKey(doc);
  const payload = toBillitParty(doc.customerSnapshot);
  if (key) {
    const links = key === "walk_in" || key.startsWith("vat:") ? { personId: null, companyId: null } : { personId: doc.personId, companyId: doc.companyId };
    return (await upsertBillitParty(ctx, api, key, payload, links)).partyId;
  }
  if (original?.billitId) {
    const o = await api.getOrder(original.billitId);
    if (o.CustomerPartyID) return o.CustomerPartyID;
  }
  logger.warn({ invoiceId: doc.id }, "billit: document without party key; pushing a one-off party");
  return (await api.upsertParty({ ...payload, ExternalProviderID: `invoice:${doc.id}` })).partyId;
}

/** `billit.push_customer` (`{ partyKey }`): refresh a person's or company's party from CRM (crm edits, ops rectification). */
export async function runPushCustomer(ctx: JobCtx, input: { partyKey: string }) {
  const settings = await financeSettings(ctx.tx);
  if (!settings.billit_enabled) return { status: "disabled" as const };
  const [row] = await ctx.tx.select().from(billitParties).where(eq(billitParties.partyKey, input.partyKey));
  if (!row) return { status: "no_party" as const };

  let snapshot: FullCustomerSnapshot | null = null;
  if (input.partyKey.startsWith("person:") && row.personId && !row.isAnonymised) {
    const [p] = await ctx.tx
      .select({ id: persons.id, firstName: persons.firstName, lastName: persons.lastName, email: persons.email, phone: persons.phone, address: persons.address, locale: persons.locale })
      .from(persons)
      .where(eq(persons.id, row.personId));
    if (p) snapshot = buildCustomerSnapshot({ person: p as PersonForBilling });
  } else if (input.partyKey.startsWith("company:") && row.companyId) {
    const [c] = await ctx.tx.select({ id: companies.id, name: companies.name, vatNumber: companies.vatNumber, address: companies.address }).from(companies).where(eq(companies.id, row.companyId));
    if (c) snapshot = buildCustomerSnapshot({ company: c as CompanyForBilling });
  }
  if (!snapshot) return { status: "unchanged" as const };
  const api = ctx.integrations.billit;
  const result = await upsertBillitParty(ctx, api, input.partyKey, toBillitParty(snapshot), { personId: row.personId, companyId: row.companyId }).catch(async (error: unknown) => {
    if (error instanceof IntegrationError) {
      await writeDurably(ctx, (db) => db.update(billitParties).set({ lastError: error.message.slice(0, 500), updatedAt: sql`now()` }).where(eq(billitParties.partyKey, input.partyKey)).then(() => undefined));
      if (isBillitAuthError(error)) await raiseAuthAlert(ctx);
    }
    throw error;
  });
  return { status: result.pushed ? ("pushed" as const) : ("unchanged" as const), partyId: result.partyId };
}

// ---------------------------------------------------------------------------
// push_invoice / push_credit_note
// ---------------------------------------------------------------------------

/**
 * Pushes one document (rules 30 to 33, edge cases 8 to 10, 29). A credit note waits for its
 * original (`RetryableError('original_not_synced')`, after queueing the original's push); every
 * document waits for its PDF. On success: `billit_id`, `billit_status = 'synced'`, the failure
 * streak cleared, `billit_payment_status = 'synced'` for a document created paid, and
 * `billit.send_peppol` for company documents with a VAT number.
 */
export async function runPushDocument(ctx: JobCtx, input: { invoiceId: string }) {
  const tx = ctx.tx;
  const settings = await financeSettings(tx);
  if (!settings.billit_enabled) return { status: "disabled" as const };
  const doc = await loadInvoice(tx, input.invoiceId, { forUpdate: true });
  if (doc.billitStatus === "synced" && doc.billitId) return { status: "already_synced" as const, billitId: doc.billitId };
  if (isAnonymisedSnapshot(doc.customerSnapshot)) return { status: "skipped_anonymised" as const };

  let original: InvoiceRecord | null = null;
  if (doc.kind === "credit_note" && doc.reversesInvoiceId) {
    original = await findInvoice(tx, doc.reversesInvoiceId);
    if (original && (original.billitStatus !== "synced" || !original.billitId)) {
      const o = original;
      await writeDurably(ctx, async (db) => void (await enqueueBillitPush(db, o, { requestId: ctx.requestId })));
      throw new RetryableError("billit.push_credit_note: original_not_synced");
    }
  }
  if (doc.pdfStatus !== "rendered" || !doc.pdfFileId) throw new RetryableError("billit.push: pdf_not_rendered");
  const file = await readFile(tx, doc.pdfFileId);
  if (!file) throw new RetryableError("billit.push: pdf_missing");
  const parts = await paidPaymentParts(tx, doc.orderId);
  const api = ctx.integrations.billit;

  const outcome = await withBillitFailure(ctx, doc.id, "document", async () => {
    const partyId = await partyForDocument(ctx, api, doc, original);
    let billitId = doc.billitId ?? (await api.findOrderByReference(doc.number))?.orderId ?? null;
    let created = false;
    if (!billitId) {
      const order = toBillitOrder(doc, partyId, file.bytes, { ...(original ? { originalNumber: original.number } : {}), payments: parts });
      try {
        billitId = (await api.createOrder(order)).orderId;
        created = true;
      } catch (error) {
        // 409/422 duplicate: the order exists after all (a lost response); re-fetch it by reference.
        if (!(error instanceof IntegrationError) || error.retryable || isBillitAuthError(error)) throw error;
        const found = await api.findOrderByReference(doc.number);
        if (!found) throw error;
        billitId = found.orderId;
      }
      const id = billitId;
      await writeDurably(ctx, async (db) => {
        const current = await findInvoice(db, doc.id);
        if (current && current.billitId === null) await updateInvoiceState(db as never, doc.id, { billitId: id });
      });
    }
    let paidInBillit = created;
    if (!created && doc.status === "paid" && doc.settledVia !== "billit") paidInBillit = (await api.getOrder(billitId)).Paid;
    return { billitId, paidInBillit };
  });

  const patch: InvoiceMutableFields = { billitId: outcome.billitId, billitStatus: "synced", billitSyncedAt: ctx.now, billitLastError: null, billitFailedSince: null };
  let pushPayment = false;
  if (doc.status === "paid" && doc.settledVia !== "billit") {
    patch.billitPaymentStatus = outcome.paidInBillit ? "synced" : "pending";
    pushPayment = !outcome.paidInBillit;
  }
  const peppol = settings.peppol_enabled && doc.isCompany && hasVatNumber(doc) && (doc.peppolStatus === "pending" || doc.peppolStatus === "not_applicable");
  if (peppol && doc.peppolStatus !== "pending") patch.peppolStatus = "pending";
  await updateInvoiceState(tx, doc.id, patch);

  if (pushPayment) await enqueueFinanceJob(ctx, { kind: "billit.push_payment", payload: { invoiceId: doc.id }, key: billitPaymentKey(doc.id) });
  if (peppol) await enqueueFinanceJob(ctx, { kind: "billit.send_peppol", payload: { invoiceId: doc.id }, key: billitPeppolKey(doc.id) });
  return { status: "synced" as const, billitId: outcome.billitId };
}

// ---------------------------------------------------------------------------
// send_peppol
// ---------------------------------------------------------------------------

/**
 * `sendOrder(billitId, 'Peppol')`, then `peppol_status = 'sent'` (rule 33). A permanent refusal
 * (receiver not on Peppol) is handled, not retried: `peppol_status = 'failed'`, the fallback
 * email (`peppol_fallback`), and for a `BE` buyer one High alert and a `follow_up` task.
 */
export async function runSendPeppol(ctx: JobCtx, input: { invoiceId: string }) {
  const tx = ctx.tx;
  const settings = await financeSettings(tx);
  if (!settings.billit_enabled || !settings.peppol_enabled) return { status: "disabled" as const };
  const doc = await loadInvoice(tx, input.invoiceId, { forUpdate: true });
  if (doc.peppolStatus === "sent" || doc.peppolStatus === "failed") return { status: doc.peppolStatus };
  if (!doc.billitId || doc.billitStatus !== "synced") throw new RetryableError("billit.send_peppol: not_synced");

  try {
    await ctx.integrations.billit.sendOrder(doc.billitId, "Peppol");
  } catch (error) {
    if (isBillitAuthError(error)) await raiseAuthAlert(ctx);
    if (error instanceof IntegrationError && !error.retryable && !isBillitAuthError(error)) {
      await peppolFailed(ctx, doc);
      return { status: "failed" as const };
    }
    throw error;
  }
  await updateInvoiceState(tx, doc.id, { peppolStatus: "sent" });
  return { status: "sent" as const };
}

async function peppolFailed(ctx: JobCtx, doc: InvoiceRecord): Promise<void> {
  await updateInvoiceState(ctx.tx, doc.id, { peppolStatus: "failed" });
  if (isBelgianVatBuyer(doc)) {
    await notifySlack(ctx, { fingerprint: `peppol-failed:${doc.id}`, severity: "high", text: `Peppol delivery failed for ${doc.number}` });
    const subject = eventSubject(doc);
    await createTask(ctx.tx, ctx, {
      title: `Fix Peppol delivery ${doc.number}`,
      kind: "follow_up",
      priority: "high",
      dueAt: nextBusinessDayAt10(ctx.now),
      ownerRole: "finance",
      source: "system",
      ref: { type: "invoice", id: doc.id },
      ...(subject ?? {}),
      dedupeKey: `invoice:${doc.id}:peppol_task`,
    });
  }
  await ctx.enqueue({ kind: "finance.send_invoice_email", payload: { invoiceId: doc.id, reason: "peppol_fallback" }, key: `invoice_email:${doc.id}:peppol_fallback` });
}

// ---------------------------------------------------------------------------
// push_payment
// ---------------------------------------------------------------------------

/** Registers a payment settled in BEAM after the push (rule 30a, edge case 29). */
export async function runPushPayment(ctx: JobCtx, input: { invoiceId: string }) {
  const tx = ctx.tx;
  const settings = await financeSettings(tx);
  if (!settings.billit_enabled) return { status: "disabled" as const };
  const doc = await loadInvoice(tx, input.invoiceId, { forUpdate: true });
  if (doc.billitPaymentStatus === "synced" || doc.status !== "paid") return { status: "noop" as const };
  if (!doc.billitId || doc.billitStatus !== "synced") throw new RetryableError("billit.push_payment: not_synced");
  if (doc.billitPaymentStatus === "not_applicable" || doc.settledVia === "billit") return { status: "noop" as const };

  const billitId = doc.billitId;
  const parts = await paidPaymentParts(tx, doc.orderId);
  await withBillitFailure(ctx, doc.id, "payment", () => ctx.integrations.billit.registerPayment(billitId, toBillitPayment(doc, parts)));
  await updateInvoiceState(tx, doc.id, { billitPaymentStatus: "synced", billitLastError: null });
  return { status: "synced" as const };
}

// ---------------------------------------------------------------------------
// sync_pending
// ---------------------------------------------------------------------------

export const SYNC_PAGE = 100;
export const STUCK_AFTER_MINUTES = 15;

/** What is left to pay on an open invoice: total minus its credit notes (`v_invoice_balances.remaining_cents`). */
async function amountDueCents(tx: DbOrTx, invoice: InvoiceRecord): Promise<number> {
  const [row] = await tx
    .select({ credited: sql<string>`coalesce(-sum(${invoices.totalCents}), 0)` })
    .from(invoices)
    .where(and(eq(invoices.kind, "credit_note"), eq(invoices.reversesInvoiceId, invoice.id)));
  return invoice.totalCents - Number(row?.credited ?? 0);
}

/**
 * `billit.sync_pending` (rules 26, 28, 34, 35): (a) open invoices in Billit settle when Billit
 * reports at least the amount due, through commerce's paid transaction; (b) pending or failed
 * pushes older than 15 minutes without a live job are re-queued; (c) documents failing for
 * `alert_after_minutes` raise `billit-failing:<id>` (one line per invoice per hour). More than
 * 100 open invoices continue in a follow-up job with `offset`.
 */
export async function runSyncPending(ctx: JobCtx, input: { offset?: number }) {
  const tx = ctx.tx;
  const settings = await financeSettings(tx);
  if (!settings.billit_enabled) return { status: "disabled" as const };
  const api = ctx.integrations.billit;
  const offset = input.offset ?? 0;

  const open = (await tx
    .select()
    .from(invoices)
    .where(and(eq(invoices.kind, "invoice"), eq(invoices.status, "open"), isNotNull(invoices.billitId)))
    .orderBy(asc(invoices.issuedAt), asc(invoices.id))
    .limit(SYNC_PAGE + 1)
    .offset(offset)) as InvoiceRecord[];

  let settled = 0;
  let partial = 0;
  for (const invoice of open.slice(0, SYNC_PAGE)) {
    let order;
    try {
      order = await api.getOrder(invoice.billitId!);
    } catch (error) {
      if (isBillitAuthError(error)) {
        await raiseAuthAlert(ctx);
        throw error;
      }
      if (error instanceof IntegrationError && error.retryable) throw error;
      logger.warn({ invoiceId: invoice.id }, "billit.sync_pending: order not readable");
      continue;
    }
    const due = await amountDueCents(tx, invoice);
    const total = Math.round(order.TotalIncl * 100);
    const paidCents = order.ToPay !== undefined ? total - Math.round(order.ToPay * 100) : order.Paid ? total : 0;
    if (order.Paid || (paidCents > 0 && paidCents >= due)) {
      const paidOn = order.PaidDate ?? brusselsDay(ctx.now);
      const { changed } = await markInvoicePaidInternal(tx, ctx, { invoiceId: invoice.id, paidAt: brusselsNoon(paidOn), settledVia: "billit" });
      if (changed) await recordBankTransferPaid(tx, ctx, { orderId: invoice.orderId, paidOn, reference: invoice.number });
      settled += 1;
    } else if (paidCents > 0) {
      partial += 1;
    }
  }
  if (open.length > SYNC_PAGE) {
    const base = ctx.job.key.replace(/:o\d+$/, "");
    await ctx.enqueue({ kind: "billit.sync_pending", payload: { offset: offset + SYNC_PAGE }, key: `${base}:o${offset + SYNC_PAGE}` });
  }
  if (offset > 0) return { status: "ok" as const, settled, partial, requeued: 0, alerted: 0 };

  // (b) stuck pushes
  const cutoff = new Date(ctx.now.getTime() - STUCK_AFTER_MINUTES * 60_000);
  const stuck = await tx
    .select({ id: invoices.id, kind: invoices.kind })
    .from(invoices)
    .where(and(inArray(invoices.billitStatus, ["pending", "failed"]), eq(invoices.pdfStatus, "rendered"), lt(invoices.createdAt, cutoff)))
    .orderBy(asc(invoices.createdAt))
    .limit(500);
  let requeued = 0;
  for (const doc of stuck) if ((await enqueueBillitPush(tx, doc, { requestId: ctx.requestId, skipPermanent: true }))?.inserted) requeued += 1;
  const payments_ = await tx
    .select({ id: invoices.id, kind: invoices.kind })
    .from(invoices)
    .where(and(eq(invoices.billitStatus, "synced"), inArray(invoices.billitPaymentStatus, ["pending", "failed"]), lt(invoices.updatedAt, cutoff)))
    .limit(500);
  for (const doc of payments_) if ((await enqueueBillitPush(tx, doc, { requestId: ctx.requestId, skipPermanent: true, kind: "payment" }))?.inserted) requeued += 1;

  // (c) failing for longer than the alert time
  const alertCutoff = new Date(ctx.now.getTime() - settings.alert_after_minutes * 60_000);
  const failing = await tx
    .select({ id: invoices.id, number: invoices.number, since: invoices.billitFailedSince })
    .from(invoices)
    .where(and(ne(invoices.billitStatus, "synced"), isNotNull(invoices.billitFailedSince), lte(invoices.billitFailedSince, alertCutoff)))
    .limit(200);
  for (const f of failing) {
    const minutes = Math.floor((ctx.now.getTime() - f.since!.getTime()) / 60_000);
    await notifySlack(ctx, { fingerprint: `billit-failing:${f.id}`, severity: "high", text: `Billit sync failing for ${f.number} for ${minutes} minutes` });
  }
  return { status: "ok" as const, settled, partial, requeued, alerted: failing.length };
}
