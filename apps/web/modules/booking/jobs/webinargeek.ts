/**
 * `bookings.register_webinargeek` (owner requirement 5): registers a confirmed seat of a WebinarGeek
 * webinar (a session with `webinar_geek_broadcast_id`) in WebinarGeek through its API and keeps
 * the personal watch link on the booking. Enqueued by `sendConfirmationEmail` with the key
 * `booking:<id>:webinargeek`. Idempotent: a booking that already has its link, is no longer
 * confirmed, or whose session lost its broadcast id is skipped. Without `WEBINARGEEK_API_TOKEN`
 * the job does nothing (BEAM's plan may not include API access; staff then use the CSV export).
 */
import { z } from "zod";
import { bookings, persons, sessions } from "@beam/db/schema";
import { createWebinarGeekClient, createWebinarGeekFake, type WebinarGeekClient } from "@beam/integrations/webinargeek";
import type { JobCtx } from "@/lib/job-runner";
import { eq, sql } from "@/lib/ctx";
import { integrationMode, routedOnCall } from "@/lib/integrations";

export const RegisterWebinarGeekInput = z.object({ bookingId: z.uuid() });

let installed: WebinarGeekClient | undefined;
const processCache = globalThis as unknown as { __beamWebinarGeekFake?: WebinarGeekClient };

/** Tests install a client, usually `createWebinarGeekFake()`; `undefined` restores the default. */
export function setWebinarGeekClient(client: WebinarGeekClient | undefined): void {
  installed = client;
}

/** The client for one job (runbook 1.5 rule with `WEBINARGEEK_API_TOKEN`); null when real but not configured. */
export function webinarGeekFor(ctx: Pick<JobCtx, "integrationLog">, env: Readonly<Record<string, string | undefined>> = process.env): WebinarGeekClient | null {
  if (installed) return installed;
  if (integrationMode("webinargeek", "WEBINARGEEK_API_TOKEN", env) === "fake") {
    processCache.__beamWebinarGeekFake ??= createWebinarGeekFake({ onCall: routedOnCall });
    return processCache.__beamWebinarGeekFake;
  }
  if (!env.WEBINARGEEK_API_TOKEN) return null;
  return createWebinarGeekClient({ apiToken: env.WEBINARGEEK_API_TOKEN, onCall: (entry) => ctx.integrationLog(entry) });
}

export async function runRegisterWebinarGeek(ctx: JobCtx, input: z.infer<typeof RegisterWebinarGeekInput>): Promise<{ skipped: string } | { registered: string }> {
  const [row] = await ctx.tx
    .select({
      status: bookings.status,
      watchUrl: bookings.webinarGeekWatchUrl,
      broadcastId: sessions.webinarGeekBroadcastId,
      email: persons.email,
      firstName: persons.firstName,
      lastName: persons.lastName,
    })
    .from(bookings)
    .innerJoin(sessions, eq(sessions.id, bookings.sessionId))
    .innerJoin(persons, eq(persons.id, bookings.personId))
    .where(eq(bookings.id, input.bookingId));
  if (!row) return { skipped: "not_found" };
  // "" marks a registration whose response carried no watch link (the portal then shows the webinar link).
  if (row.watchUrl !== null) return { skipped: "registered" };
  if (row.status !== "confirmed") return { skipped: "not_confirmed" };
  if (!row.broadcastId) return { skipped: "no_broadcast" };
  if (!row.email) return { skipped: "no_email" };
  const client = webinarGeekFor(ctx);
  if (!client) return { skipped: "not_configured" };
  const sub = await client.subscribe(row.broadcastId, {
    email: row.email,
    firstName: row.firstName?.trim() || row.email.split("@")[0]!,
    lastName: row.lastName,
    externalId: input.bookingId,
  });
  await ctx.tx
    .update(bookings)
    .set({ webinarGeekWatchUrl: sub.watchUrl ?? "", version: sql`${bookings.version} + 1`, updatedAt: sql`now()` })
    .where(eq(bookings.id, input.bookingId));
  return { registered: sub.id };
}
