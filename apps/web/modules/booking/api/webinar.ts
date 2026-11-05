/**
 * booking api, area `webinar` (R2, booking spec R64 and 4.9): the one `sessions` row of a webinar.
 * The webinar module owns registration; booking keeps a `sessions` row per webinar so calendars,
 * the events pages and email `event` blocks show it. The row is kind `event`, category
 * `webinar`, 0 seats, no credits, no product, published on creation, keyed by the partial unique
 * index on `sessions.webinar_id`. A session with `webinar_id` is never bookable here: booking's
 * actions refuse it with `conflict` reason `webinar_session`. Both functions run in the caller's
 * transaction, take the row lock and are idempotent. There is no `linkWebinarSession` (D50).
 */
import type { Tx } from "@beam/db";
import { sessions } from "@beam/db/schema";
import { BookingConflictError, sessionTransition } from "@beam/core/booking";
import { LocalizedTextSchema, type LocalizedText } from "@beam/core/i18n";
import { ValidationError, eq, type Ctx } from "@/lib/ctx";

type SessionRow = typeof sessions.$inferSelect;

/** The webinar's session row, locked, or null. */
async function lockWebinarSession(tx: Tx, webinarId: string): Promise<SessionRow | null> {
  const [row] = await tx.select().from(sessions).where(eq(sessions.webinarId, webinarId)).for("update");
  return row ?? null;
}

function assertInput(input: { title: LocalizedText; startsAt: Date; endsAt: Date }): void {
  const fields: Record<string, string> = {};
  if (!LocalizedTextSchema.safeParse(input.title).success || !Object.values(input.title).some((v) => typeof v === "string" && v.trim())) fields.title = "required";
  if (!(input.startsAt instanceof Date) || Number.isNaN(input.startsAt.getTime())) fields.startsAt = "invalid";
  if (!(input.endsAt instanceof Date) || Number.isNaN(input.endsAt.getTime())) fields.endsAt = "invalid";
  else if (!fields.startsAt && input.endsAt.getTime() <= input.startsAt.getTime()) fields.endsAt = "before_start";
  if (Object.keys(fields).length) throw new ValidationError("invalid_webinar_session", fields);
}

/**
 * R64: creates or updates the webinar's session (title and times). `sessionId`, when the webinar
 * already stores one, must be that row, else `conflict` reason `webinar_session_mismatch`; on a
 * create it is ignored. Returns `{ sessionId, created }`.
 */
export async function upsertWebinarSession(
  tx: Tx,
  ctx: Ctx,
  input: { webinarId: string; sessionId?: string; title: LocalizedText; startsAt: Date; endsAt: Date },
): Promise<{ sessionId: string; created: boolean }> {
  assertInput(input);
  const existing = await lockWebinarSession(tx, input.webinarId);
  if (input.sessionId && existing && existing.id !== input.sessionId) {
    throw new BookingConflictError("webinar_session_mismatch", { sessionId: existing.id });
  }
  if (input.sessionId && !existing) {
    // The webinar points at a row that is not its session (another webinar's, or an ordinary one).
    const [other] = await tx.select({ id: sessions.id, webinarId: sessions.webinarId }).from(sessions).where(eq(sessions.id, input.sessionId));
    if (other) throw new BookingConflictError("webinar_session_mismatch", { sessionId: other.id });
  }
  if (existing) {
    const unchanged =
      JSON.stringify(existing.title) === JSON.stringify(input.title) &&
      existing.startsAt.getTime() === input.startsAt.getTime() &&
      existing.endsAt.getTime() === input.endsAt.getTime();
    if (!unchanged) {
      await tx
        .update(sessions)
        .set({ title: input.title, startsAt: input.startsAt, endsAt: input.endsAt, updatedAt: ctx.now })
        .where(eq(sessions.id, existing.id));
    }
    return { sessionId: existing.id, created: false };
  }
  const [row] = await tx
    .insert(sessions)
    .values({
      kind: "event",
      eventCategory: "webinar",
      title: input.title,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      capacitySeats: 0,
      capacityBeds: null,
      creditKind: null,
      creditCost: 0,
      productId: null,
      status: "open",
      publishedAt: ctx.now,
      webinarId: input.webinarId,
    })
    .returning({ id: sessions.id });
  return { sessionId: row!.id, created: true };
}

/**
 * R64: sets the webinar's session `cancelled` with `cancel_reason = reason`. Keyed by
 * `webinarId`; `{ cancelled: false }` when the webinar has no session; a second call returns
 * `{ cancelled: true }` and changes nothing.
 */
export async function cancelWebinarSession(tx: Tx, ctx: Ctx, input: { webinarId: string; reason: string }): Promise<{ cancelled: boolean }> {
  const existing = await lockWebinarSession(tx, input.webinarId);
  if (!existing) return { cancelled: false };
  if (existing.status === "cancelled") return { cancelled: true };
  sessionTransition(existing.status, "cancelled");
  const reason = input.reason.trim() || "webinar_cancelled";
  await tx
    .update(sessions)
    .set({ status: "cancelled", cancelledAt: ctx.now, cancelReason: reason, updatedAt: ctx.now })
    .where(eq(sessions.id, existing.id));
  return { cancelled: true };
}
