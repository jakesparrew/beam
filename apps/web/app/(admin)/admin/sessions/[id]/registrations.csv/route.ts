/**
 * `GET /admin/sessions/[id]/registrations.csv` (owner requirement 5): the live registrations of an
 * event or webinar, to import into WebinarGeek. Staff with `bookings.read`; audited as
 * `data.exported`; `no-store`.
 */
import { sessions } from "@beam/db/schema";
import { brusselsDate } from "@beam/core/booking";
import { toCsv } from "@beam/core/ops";
import { actorFromSession, getSession, hasPermission } from "@/lib/auth";
import { createCtx, eq, getAppDb } from "@/lib/ctx";
import { EVENT_REGISTRATION_COLUMNS, listEventRegistrations } from "@/modules/booking/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  const actor = actorFromSession(await getSession());
  if (!actor || actor.kind !== "staff") return new Response("Unauthorized", { status: 401, headers: { "cache-control": "no-store" } });
  if (!hasPermission(actor, "bookings.read")) return new Response("Forbidden", { status: 403, headers: { "cache-control": "no-store" } });
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response("Not found", { status: 404 });

  const db = await getAppDb();
  const [session] = await db.select({ id: sessions.id, startsAt: sessions.startsAt }).from(sessions).where(eq(sessions.id, id));
  if (!session) return new Response("Not found", { status: 404 });
  const rows = await listEventRegistrations(db, id);
  await db.transaction(async (tx) => {
    const ctx = createCtx({ tx, actor });
    await ctx.audit({ action: "data.exported", entityType: "session", entityId: id, newValue: { entity: "event_registrations", rows: rows.length } });
  });

  const body = toCsv([...EVENT_REGISTRATION_COLUMNS], rows);
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for await (const chunk of body) controller.enqueue(chunk);
      controller.close();
    },
  });
  const filename = `registrations-${brusselsDate(session.startsAt)}-${id.slice(0, 8)}.csv`;
  return new Response(stream, {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${filename}"`, "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
  });
}
