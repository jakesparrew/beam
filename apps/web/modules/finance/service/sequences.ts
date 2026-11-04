/**
 * Gapless document numbers (finance rules 9 to 11, section 2.3). The counter row of `(year,
 * kind)` is created on first use and locked `for update` inside the issuing transaction, so a
 * second issuer waits and gets the next number, and a rolled-back transaction rolls the counter
 * back with it: no duplicate, no gap. Rows are never deleted.
 */
import type { Tx } from "@beam/db";
import { invoices, invoiceSequences } from "@beam/db/schema";
import { brusselsDateOf, fiscalYearOf, FIRST_FISCAL_YEAR, LAST_FISCAL_YEAR, MAX_SEQUENCE_NUMBER, type InvoiceKind } from "@beam/core/finance";
import { and, eq, sql, type Ctx } from "@/lib/ctx";

export type AllocatedNumber = { fiscalYear: number; sequenceNumber: number; issuedAt: Date; issuedOn: string };

/**
 * Allocates the next number of `kind` and the document's issue instant together (rule 12: a
 * higher number never has an earlier `issued_at`). The fiscal year is the Brussels year of
 * `ctx.now`; once the counter row is locked, the instant is clamped to the previous document of
 * the same `(year, kind)`, so an issuer whose context was created before another issuer took the
 * lock cannot get an earlier `issued_at` or `issued_on` than that issuer's lower number. Without
 * an inversion the instant is `ctx.now` unchanged (seeded backdating keeps working).
 */
export async function allocateNumberAndInstant(tx: Tx, ctx: Pick<Ctx, "now">, kind: InvoiceKind): Promise<AllocatedNumber> {
  const fiscalYear = fiscalYearOf(ctx.now);
  const sequenceNumber = await allocateNumber(tx, kind, fiscalYear);
  const [prev] =
    sequenceNumber > 1
      ? await tx
          .select({ issuedAt: invoices.issuedAt })
          .from(invoices)
          .where(and(eq(invoices.kind, kind), eq(invoices.fiscalYear, fiscalYear), eq(invoices.sequenceNumber, sequenceNumber - 1)))
      : [];
  const issuedAt = prev && prev.issuedAt > ctx.now ? prev.issuedAt : ctx.now;
  return { fiscalYear, sequenceNumber, issuedAt, issuedOn: brusselsDateOf(issuedAt) };
}

/** The next number of `kind` in fiscal year `year` (1 for the first document of the year). */
export async function allocateNumber(tx: Tx, kind: InvoiceKind, year: number): Promise<number> {
  if (!Number.isInteger(year) || year < FIRST_FISCAL_YEAR || year > LAST_FISCAL_YEAR) {
    throw new RangeError(`allocateNumber: fiscal year ${year} is outside ${FIRST_FISCAL_YEAR}..${LAST_FISCAL_YEAR}`);
  }
  await tx.insert(invoiceSequences).values({ kind, year }).onConflictDoNothing({ target: [invoiceSequences.year, invoiceSequences.kind] });
  const where = and(eq(invoiceSequences.year, year), eq(invoiceSequences.kind, kind));
  const [locked] = await tx.select({ lastNumber: invoiceSequences.lastNumber }).from(invoiceSequences).where(where).for("update");
  if (!locked) throw new Error(`allocateNumber: sequence ${kind} ${year} missing after insert`);
  if (locked.lastNumber >= MAX_SEQUENCE_NUMBER) throw new RangeError(`allocateNumber: sequence ${kind} ${year} is exhausted`);
  const [row] = await tx
    .update(invoiceSequences)
    .set({ lastNumber: sql`${invoiceSequences.lastNumber} + 1`, updatedAt: sql`now()` })
    .where(where)
    .returning({ lastNumber: invoiceSequences.lastNumber });
  return row!.lastNumber;
}
