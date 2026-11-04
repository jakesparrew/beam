/**
 * Applier for kind `bookings`: future bookings only (ops spec rule 49, booking R65). booking's
 * `importBooking` inserts a `confirmed` booking with no credit consumed (the opening balance
 * already excludes it, rule 48); ops passes no status. Outcomes: `created` imported, `existing`
 * skipped, `no_session` error, `over_capacity` imported with that message (listed in the report).
 * Past bookings are imported as `history` rows, never here (decision 23).
 */
import type { Tx } from "@beam/db";
import { bookings, sessions } from "@beam/db/schema";
import type { ImportMapping } from "@beam/core/ops";
import { and, eq, isNull, ne } from "@/lib/ctx";
import type { JobCtx } from "@/lib/job-runner";
import { importBooking } from "@/modules/booking/api";
import { assertNotErased, cell, parseInstantCell, requireEmail, resolvePersonByEmail, RowError, writeExternalId, type ImportRow, type RowOutcome } from "../apply";

type Kind = "day" | "night" | "event";
type PaidWith = "credit" | "order" | "free";

const KINDS: Record<string, Kind> = { day: "day", dag: "day", jour: "day", night: "night", nacht: "night", nuit: "night", event: "event", evenement: "event", événement: "event" };
const PAID: Record<string, PaidWith> = { credit: "credit", credits: "credit", package: "credit", pakket: "credit", order: "order", paid: "order", betaald: "order", free: "free", gratis: "free", gratuit: "free" };

export function sessionKindOf(value: string | null): Kind {
  if (!value) return "day";
  const v = value.trim().toLowerCase();
  const kind = KINDS[v] ?? (v.includes("night") || v.includes("nacht") || v.includes("nuit") ? "night" : v.includes("event") ? "event" : undefined);
  if (!kind) throw new RowError("invalid_session_kind");
  return kind;
}

function paidWithOf(value: string | null): PaidWith {
  if (!value) return "credit";
  const paid = PAID[value.trim().toLowerCase()];
  if (!paid) throw new RowError("invalid_paid_with");
  return paid;
}

export async function applyBookingRow(tx: Tx, ctx: JobCtx, row: ImportRow, opts: { dryRun: boolean; mapping: ImportMapping }): Promise<RowOutcome> {
  const email = requireEmail(row);
  await assertNotErased(tx, email);
  const startsAt = parseInstantCell(cell(row, "session_starts_at"), opts.mapping.options.dateFormat);
  if (!startsAt) throw new RowError("invalid_date");
  if (startsAt.getTime() <= ctx.now.getTime()) throw new RowError("past_booking");
  const kind = sessionKindOf(cell(row, "session_kind"));
  const paidWith = paidWithOf(cell(row, "paid_with"));
  const externalRef = (cell(row, "external_id") ?? `import:${row.importId}:row:${row.rowNumber}`).slice(0, 200);

  if (opts.dryRun) {
    const [existing] = await tx.select({ id: bookings.id }).from(bookings).where(eq(bookings.externalRef, externalRef)).limit(1);
    if (existing) return { status: "skipped", message: "existing", entityType: "booking", entityId: existing.id };
    const [session] = await tx
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.kind, kind), eq(sessions.startsAt, startsAt), ne(sessions.status, "cancelled"), isNull(sessions.webinarId)))
      .limit(1);
    if (!session) return { status: "error", message: "no_session", entityType: "booking" };
    const { personId } = await resolvePersonByEmail(tx, ctx, row, email, opts);
    return { status: "imported", entityType: "booking", ...(personId ? { personId } : {}) };
  }

  const { personId } = await resolvePersonByEmail(tx, ctx, row, email, opts);
  const result = await importBooking(tx, ctx, { externalRef, personId: personId!, kind, startsAt, paidWith });
  switch (result.outcome) {
    case "created":
    case "over_capacity":
      await writeExternalId(tx, row, "booking", result.bookingId!);
      return { status: "imported", ...(result.outcome === "over_capacity" ? { message: "over_capacity" } : {}), personId: personId!, entityType: "booking", entityId: result.bookingId! };
    case "existing":
      return { status: "skipped", message: "existing", personId: personId!, entityType: "booking", ...(result.bookingId ? { entityId: result.bookingId } : {}) };
    default:
      // Rolls the savepoint back, so a person created for this row does not stay behind.
      throw new RowError("no_session");
  }
}
