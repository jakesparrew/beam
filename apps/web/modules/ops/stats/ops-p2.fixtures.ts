/**
 * Test fixtures of the ops stats tests (ops-P2). Orders come from
 * `@beam/db/testing/commerce-factories`; bookings, imports and imported history have no shared
 * factory, so these helpers insert minimal valid rows.
 */
import { createHash, randomUUID } from "node:crypto";
import type { DbOrTx } from "@beam/db";
import { bookings, files, importedHistory, imports } from "@beam/db/schema";
import { makePerson, makeSession, makeUser } from "@beam/db/testing";

export const DAY = 86_400_000;
export const daysAgo = (days: number, from: Date = new Date()) => new Date(from.getTime() - days * DAY);
export const daysAhead = (days: number, from: Date = new Date()) => new Date(from.getTime() + days * DAY);

/** A non-tester person (the factory default is a tester). */
export const makeCustomer = (db: DbOrTx, over: Parameters<typeof makePerson>[1] = {}) => makePerson(db, { isTester: false, ...over });

/** A booking on a new session of `kind` starting at `startsAt`. */
export async function makeBooking(
  db: DbOrTx,
  input: {
    personId: string;
    startsAt: Date;
    status: "reserved" | "confirmed" | "cancelled" | "late_cancelled" | "no_show" | "attended";
    kind?: "day" | "night" | "event";
    guestOfBookingId?: string;
    sessionId?: string;
    createdAt?: Date;
  },
) {
  const sessionId = input.sessionId ?? (await makeSession(db, { kind: input.kind ?? "day", startsAt: input.startsAt })).id;
  const [row] = await db
    .insert(bookings)
    .values({
      sessionId,
      personId: input.personId,
      status: input.status,
      paidWith: input.guestOfBookingId ? "guest" : "free",
      source: "admin",
      guestOfBookingId: input.guestOfBookingId ?? null,
      ...(input.status === "reserved" ? { reservedUntil: daysAhead(1) } : {}),
      ...(input.status === "attended" ? { attendedAt: input.startsAt } : {}),
      ...(input.status === "no_show" ? { noShowMarkedAt: input.startsAt } : {}),
      ...(input.status === "cancelled" || input.status === "late_cancelled" ? { cancelledAt: daysAgo(1, input.startsAt), cancelReasonCode: "customer" as const } : {}),
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    })
    .returning();
  return row!;
}

let importId: string | undefined;

/** One import row to hang imported history on (created once per database). */
async function anImport(db: DbOrTx): Promise<string> {
  if (importId) {
    const [found] = await db.select({ id: imports.id }).from(imports).limit(1);
    if (found) return found.id;
  }
  const user = await makeUser(db, { roleKey: "technical_admin" });
  const bytes = Buffer.from("email\n");
  const [file] = await db
    .insert(files)
    .values({ kind: "import", name: "history.csv", mime: "text/csv", sizeBytes: bytes.length, bytes, sha256: createHash("sha256").update(bytes).digest("hex") } as typeof files.$inferInsert)
    .returning();
  const [row] = await db.insert(imports).values({ kind: "history", source: "simplybook", name: "History", fileId: file!.id, createdByUserId: user.id }).returning();
  importId = row!.id;
  return importId;
}

/** An `imported_history` row of `kind` for the person. */
export async function makeHistory(
  db: DbOrTx,
  input: { personId: string; kind: (typeof importedHistory.$inferInsert)["kind"]; occurredAt: Date; amountCents?: number },
) {
  const [row] = await db
    .insert(importedHistory)
    .values({
      personId: input.personId,
      importId: await anImport(db),
      source: "simplybook",
      kind: input.kind,
      occurredAt: input.occurredAt,
      externalId: randomUUID(),
      amountCents: input.amountCents ?? null,
      productKind: input.kind === "purchase" ? "package" : null,
    })
    .returning();
  return row!;
}
