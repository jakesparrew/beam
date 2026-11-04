/**
 * Test fixtures of the ops dashboard tests (ops-P3). Persons, grants, memberships and orders
 * come from the shared factories; imported webinar registrations, payments, tasks and bookings
 * have no shared factory, so these helpers insert minimal valid rows.
 */
import { createHash, randomUUID } from "node:crypto";
import type { DbOrTx } from "@beam/db";
import { bookings, files, importedHistory, imports, payments, tasks } from "@beam/db/schema";
import { makePerson, makeSession, makeUser } from "@beam/db/testing";

export const DAY = 86_400_000;
export const ago = (days: number, from: Date = new Date()) => new Date(from.getTime() - days * DAY);
export const ahead = (days: number, from: Date = new Date()) => new Date(from.getTime() + days * DAY);

/** A non-tester person (the factory default is a tester). */
export const makeCustomer = (db: DbOrTx, over: Parameters<typeof makePerson>[1] = {}) => makePerson(db, { isTester: false, ...over });

const importIds = new WeakMap<object, string>();

/** One `webinar_tool` import to hang imported registrations on (one per database). */
async function anImport(db: DbOrTx): Promise<string> {
  const known = importIds.get(db);
  if (known) return known;
  const user = await makeUser(db, { roleKey: "technical_admin" });
  const bytes = Buffer.from("email\n");
  const [file] = await db
    .insert(files)
    .values({ kind: "import", name: "webinar.csv", mime: "text/csv", sizeBytes: bytes.length, bytes, sha256: createHash("sha256").update(bytes).digest("hex") } as typeof files.$inferInsert)
    .returning();
  const [row] = await db.insert(imports).values({ kind: "history", source: "webinar_tool", name: "Webinar registrations", fileId: file!.id, createdByUserId: user.id }).returning();
  importIds.set(db, row!.id);
  return row!.id;
}

/** An imported webinar registration of the person (rule 29, V1 source). */
export async function makeImportedRegistration(db: DbOrTx, input: { personId: string; registeredAt: Date; webinarStartsAt?: Date }) {
  const [row] = await db
    .insert(importedHistory)
    .values({
      personId: input.personId,
      importId: await anImport(db),
      source: "webinar_tool",
      kind: "webinar_registration",
      occurredAt: input.registeredAt,
      externalId: randomUUID(),
      data: { webinar_title: "Breathing basics", ...(input.webinarStartsAt ? { webinar_starts_at: input.webinarStartsAt.toISOString() } : {}) },
    })
    .returning();
  return row!;
}

/** A booking of the person on a new day session, made at `createdAt`. */
export async function makeBookingAt(db: DbOrTx, input: { personId: string; createdAt?: Date; startsAt?: Date }) {
  const session = await makeSession(db, { startsAt: input.startsAt ?? ahead(3) });
  const [row] = await db
    .insert(bookings)
    .values({ sessionId: session.id, personId: input.personId, status: "confirmed", paidWith: "free", source: "admin", ...(input.createdAt ? { createdAt: input.createdAt } : {}) })
    .returning();
  return row!;
}

/** A payment of the order. */
export async function makePayment(db: DbOrTx, input: { orderId: string; status: (typeof payments.$inferInsert)["status"]; amountCents?: number; createdAt?: Date; updatedAt?: Date }) {
  const [row] = await db
    .insert(payments)
    .values({
      orderId: input.orderId,
      provider: "mollie",
      status: input.status,
      amountCents: input.amountCents ?? 4_500,
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
      ...(input.updatedAt ? { updatedAt: input.updatedAt } : {}),
    })
    .returning();
  return row!;
}

/** An open crm task. */
export async function makeOpenTask(db: DbOrTx, input: { ownerUserId: string; personId?: string; dueAt: Date; title?: string }) {
  const [row] = await db
    .insert(tasks)
    .values({
      ownerUserId: input.ownerUserId,
      personId: input.personId ?? null,
      title: input.title ?? "Call back",
      kind: "call",
      dueAt: input.dueAt,
      source: "manual",
      createdBy: { kind: "system", id: null },
    })
    .returning();
  return row!;
}
