/**
 * Test fixtures for the automation-P3 suites (step execution, bulk jobs, sweep, webhook).
 * Imported by `*.test.ts` files of this module only; builds on automation-P2's fixtures.
 */
import { randomUUID } from "node:crypto";
import type { Db, DbOrTx, Tx } from "@beam/db";
import { automationEnrolments, automationRuns, bookings, emailMessages, tags, type RoleKey } from "@beam/db/schema";
import { makeSession, makeUser } from "@beam/db/testing";
import type { Definition, EventView } from "@beam/core/automation";
import { asc, eq, sql, type Actor } from "@/lib/ctx";
import { enrol } from "./enrol";

export { def, makeAutomation, makeEvent, makeGroup, maxEventId, resetAutomations, setCursor } from "./automation-p2.fixtures";

export const SYSTEM: Actor = { kind: "system", jobId: "" };

/** Enrols a person (source `staff` unless an event is given) and returns the enrolment id. */
export async function enrolInto(
  db: Db,
  automationId: string,
  personId: string,
  o: { now: Date; event?: EventView; anchorAt?: Date; subjectKey?: string } = { now: new Date() },
): Promise<string> {
  const res = await enrol(db as unknown as Tx, {
    automation: automationId,
    personId,
    source: o.event ? "trigger" : "staff",
    actor: SYSTEM,
    now: o.now,
    event: o.event ?? null,
    anchorAt: o.anchorAt ?? null,
    ...(o.subjectKey !== undefined ? { subjectKey: o.subjectKey } : {}),
  });
  if (res.status !== "enrolled") throw new Error(`enrolInto: ${res.outcome}`);
  return res.enrolmentId;
}

export async function enrolmentRow(db: Db, id: string) {
  const [row] = await db.select().from(automationEnrolments).where(eq(automationEnrolments.id, id));
  return row!;
}

export function runsOfEnrolment(db: Db, enrolmentId: string) {
  return db
    .select()
    .from(automationRuns)
    .where(eq(automationRuns.enrolmentId, enrolmentId))
    .orderBy(asc(automationRuns.occurredAt), asc(automationRuns.createdAt));
}

/** Step outcome runs only (no `entered`, `scheduled`), as `[step_key, outcome]`. */
export async function stepOutcomes(db: Db, enrolmentId: string): Promise<[string | null, string][]> {
  return (await runsOfEnrolment(db, enrolmentId)).filter((r) => r.outcome !== "entered" && r.outcome !== "scheduled").map((r) => [r.stepKey, r.outcome]);
}

/** Moves the next step of an enrolment to `at` (the step is due). */
export async function makeDue(db: Db, enrolmentId: string, at: Date): Promise<void> {
  await db.update(automationEnrolments).set({ nextStepAt: at }).where(eq(automationEnrolments.id, enrolmentId));
}

export async function makeTag(db: DbOrTx, key: string): Promise<void> {
  await db.insert(tags).values({ key, name: { en: key, "nl-BE": key, "fr-BE": key } }).onConflictDoNothing();
}

export async function makeStaff(db: DbOrTx, roleKey: RoleKey, name: string) {
  return makeUser(db, { roleKey, name });
}

/** A booking of a person on a new session (status as given). */
export async function makeBooking(db: DbOrTx, o: { personId: string; startsAt: Date; status: "reserved" | "confirmed" | "attended" | "no_show" | "cancelled"; kind?: "day" | "night" | "event" }) {
  const session = await makeSession(db, { kind: o.kind ?? "day", startsAt: o.startsAt });
  const [row] = await db
    .insert(bookings)
    .values({
      sessionId: session.id,
      personId: o.personId,
      status: o.status,
      paidWith: "free",
      source: "admin",
      ...(o.status === "reserved" ? { reservedUntil: new Date(o.startsAt.getTime() - 3_600_000) } : {}),
      ...(o.status === "attended" ? { attendedAt: o.startsAt } : {}),
      ...(o.status === "cancelled" ? { cancelledAt: new Date(o.startsAt.getTime() - 86_400_000), cancelReasonCode: "customer" as const } : {}),
    })
    .returning();
  return { booking: row!, session };
}

/** An `email_messages` row standing in for what email's queue functions create (FK target of runs). */
export async function insertEmailMessage(db: DbOrTx, o: { personId: string; enrolmentId: string; key: string }): Promise<string> {
  const id = randomUUID();
  await db
    .insert(emailMessages)
    .values({ id, personId: o.personId, kind: "transactional", enrolmentId: o.enrolmentId, locale: "nl-BE", idempotencyKey: o.key })
    .onConflictDoNothing();
  const [row] = await db.select({ id: emailMessages.id }).from(emailMessages).where(eq(emailMessages.idempotencyKey, o.key));
  return row!.id;
}

/** A definition with the given steps (manual trigger unless overridden). */
export function steps(list: Definition["steps"], over: Partial<Definition> = {}): Definition {
  return { schema_version: 1, trigger: { manual: true }, anchor: "enrolment", re_entry: "always", exit_on: [], steps: list, ...over };
}

/** Clears jobs and settings rows a suite writes. */
export async function resetJobs(db: Db): Promise<void> {
  await db.execute(sql`delete from jobs`);
}
