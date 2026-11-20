/**
 * The widget's other public routes:
 * - `contact`: the contact card. Finds or creates the CRM person, fills the acquisition origin
 *   (website, funnel `assistant`, the campaign when analytics was accepted), links the visitor and
 *   every earlier conversation, records newsletter consent only when the box was ticked (with the
 *   published wording), writes `assistant.lead_captured`, opens a task when a colleague was asked
 *   for, and analyses the conversation right away so the lead lands labelled in CRM.
 * - `history`: a returning visitor's open conversation, and new messages since a moment (polled
 *   while a colleague has taken over).
 * - `event`: thumbs up or down on an answer, and a click on a booking button.
 */
import "server-only";
import { z } from "zod";
import { LOCALES, type Locale } from "@beam/core/i18n";
import { assistantConversations, assistantMessages, assistantVisitors } from "@beam/db/schema";
import { and, desc, eq, gt, isNull, ne } from "@/lib/ctx";
import { rateLimit } from "@/lib/rate-limit";
import { createTask, currentWordingVersion, fillAcquisitionIfEmpty, findOrCreatePersonByEmail, recordConsent } from "@/modules/crm/api";
import { fail, inTx, json, openRequest, parseBody, visitorToken } from "./http";
import { findVisitor, logAction, publicMessages } from "./store";

const THANKS: Record<Locale, (name: string, handoff: boolean) => string> = {
  "nl-BE": (n, h) => (h ? `Dank je, ${n}. Een collega van BEAM neemt zo snel mogelijk contact met je op.` : `Dank je, ${n}. We houden je op de hoogte. Heb je nog een vraag, stel ze gerust hier.`),
  "fr-BE": (n, h) => (h ? `Merci, ${n}. Un collègue de BEAM vous recontacte au plus vite.` : `Merci, ${n}. Nous vous tiendrons au courant. Une autre question ? Posez-la ici.`),
  en: (n, h) => (h ? `Thank you, ${n}. A BEAM colleague will get back to you as soon as possible.` : `Thank you, ${n}. We'll keep you posted. Any other question? Just ask here.`),
};

const ContactBody = z.object({
  conversationId: z.uuid(),
  locale: z.enum(LOCALES),
  firstName: z.string().trim().min(1).max(80),
  email: z.email().max(200),
  phone: z.string().trim().max(40).optional().nullable(),
  newsletter: z.boolean(),
  website: z.string().max(200).optional(),
});

export async function handleContact(req: Request): Promise<Response> {
  const open = await openRequest(req);
  if (!open.ok) return open.response;
  const body = await parseBody(req, ContactBody);
  if (!body) return fail(400, "validation");
  if (body.website) return json({ ok: true });
  const { db, actor, ip } = open;
  const token = visitorToken(req);
  const out = await inTx(db, actor, ip, async (tx, ctx) => {
    const visitor = await findVisitor(tx, token);
    if (!visitor) return { error: "unknown_visitor" as const };
    if (!(await rateLimit(tx, { key: `assistant:contact:${visitor.id}`, limit: 5, windowSeconds: 3600 })).ok) return { error: "rate_limited" as const };
    const [conv] = await tx.select().from(assistantConversations).where(and(eq(assistantConversations.id, body.conversationId), eq(assistantConversations.visitorId, visitor.id)));
    if (!conv) return { error: "not_found" as const };

    const { personId, created } = await findOrCreatePersonByEmail(tx, ctx, {
      email: body.email,
      firstName: body.firstName,
      ...(body.phone ? { phone: body.phone } : {}),
      locale: body.locale,
    });
    const origin = visitor.origin ?? {};
    const utm = Object.fromEntries(["source", "medium", "campaign", "term", "content"].filter((k) => origin[`utm_${k}`]).map((k) => [k, origin[`utm_${k}`]!]));
    await fillAcquisitionIfEmpty(tx, ctx, personId, { source: "website", funnel: "assistant", ...(Object.keys(utm).length ? { utm } : {}), ...(origin.utm_campaign ? { campaign: origin.utm_campaign } : {}) });

    await tx.update(assistantVisitors).set({ personId, lastSeenAt: new Date() }).where(eq(assistantVisitors.id, visitor.id));
    await tx.update(assistantConversations).set({ personId, updatedAt: new Date() }).where(and(eq(assistantConversations.visitorId, visitor.id), isNull(assistantConversations.personId)));
    await tx.update(assistantConversations).set({ contactCapturedAt: new Date(), updatedAt: new Date() }).where(eq(assistantConversations.id, conv.id));
    await logAction(tx, { conversationId: conv.id, personId, kind: "contact_saved", detail: { created, phone: !!body.phone } });

    if (body.newsletter) {
      const wordingVersion = await currentWordingVersion(tx, "newsletter");
      if (wordingVersion) {
        const r = await recordConsent(tx, ctx, { personId, purpose: "newsletter", status: "granted", method: "form", source: "assistant", wordingVersion, ip, userAgent: (req.headers.get("user-agent") ?? "").slice(0, 300), ref: { type: "assistant_conversation", id: conv.id } });
        await logAction(tx, { conversationId: conv.id, personId, kind: "consent_recorded", detail: { purpose: "newsletter", outcome: r.outcome, wording: wordingVersion } });
      }
    }

    await ctx.recordEvent({ kind: "assistant.lead_captured", personId, data: { conversation_id: conv.id, role: conv.role, page: conv.page, newsletter: body.newsletter }, dedupeKey: `assistant:lead:${conv.id}` });

    const handoff = conv.status === "handoff";
    if (handoff) {
      const task = await createTask(tx, ctx, {
        title: `Chat opvolgen: ${body.firstName} wil een collega spreken`,
        kind: "follow_up",
        priority: "high",
        dueAt: new Date(),
        personId,
        source: "system",
        ref: { type: "assistant_conversation", id: conv.id },
        dedupeKey: `assistant:handoff:${conv.id}`,
      });
      if (task.created) await logAction(tx, { conversationId: conv.id, personId, kind: "task_created", detail: { task_id: task.taskId } });
    }
    const [msg] = await tx
      .insert(assistantMessages)
      .values({ conversationId: conv.id, author: "assistant", body: THANKS[body.locale](body.firstName, handoff), kind: "contact" })
      .returning({ id: assistantMessages.id, body: assistantMessages.body, createdAt: assistantMessages.createdAt });
    await ctx.enqueue({ kind: "assistant.analyse_conversation", payload: { conversation_id: conv.id, force: true }, key: `assistant.analyse:${conv.id}:contact` });
    return { message: { id: msg!.id, author: "assistant", body: msg!.body, cards: [], createdAt: msg!.createdAt.toISOString(), rating: null } };
  });
  if ("error" in out) return fail(out.error === "rate_limited" ? 429 : out.error === "unknown_visitor" ? 401 : 404, out.error!);
  return json({ ok: true, ...out });
}

const HistoryBody = z.object({ conversationId: z.uuid().nullable().optional(), role: z.enum(["guide", "coach"]).default("guide"), after: z.iso.datetime().nullable().optional() });

export async function handleHistory(req: Request): Promise<Response> {
  const open = await openRequest(req);
  if (!open.ok) return open.response;
  const body = await parseBody(req, HistoryBody);
  if (!body) return fail(400, "validation");
  const visitor = await findVisitor(open.db, visitorToken(req));
  if (!visitor) return json({ ok: true, conversation: null, messages: [] });
  const fortnight = new Date(Date.now() - 14 * 86_400_000);
  const [conv] = body.conversationId
    ? await open.db.select().from(assistantConversations).where(and(eq(assistantConversations.id, body.conversationId), eq(assistantConversations.visitorId, visitor.id)))
    : await open.db
        .select()
        .from(assistantConversations)
        .where(and(eq(assistantConversations.visitorId, visitor.id), eq(assistantConversations.role, body.role), ne(assistantConversations.status, "closed"), gt(assistantConversations.lastMessageAt, fortnight)))
        .orderBy(desc(assistantConversations.lastMessageAt))
        .limit(1);
  if (!conv) return json({ ok: true, conversation: null, messages: [] });
  const messages = await publicMessages(open.db, conv.id, body.after ? new Date(body.after) : undefined);
  return json({
    ok: true,
    conversation: { id: conv.id, status: conv.status, takenOver: !!conv.takenOverByUserId, contactKnown: !!conv.personId },
    messages,
  });
}

const EventBody = z.discriminatedUnion("type", [
  z.object({ type: z.literal("rating"), messageId: z.uuid(), rating: z.union([z.literal(1), z.literal(-1)]) }),
  z.object({ type: z.literal("click"), conversationId: z.uuid(), href: z.string().max(300) }),
]);

export async function handleEvent(req: Request): Promise<Response> {
  const open = await openRequest(req);
  if (!open.ok) return open.response;
  const body = await parseBody(req, EventBody);
  if (!body) return fail(400, "validation");
  const visitor = await findVisitor(open.db, visitorToken(req));
  if (!visitor) return fail(401, "unknown_visitor");
  if (body.type === "rating") {
    const [row] = await open.db
      .select({ id: assistantMessages.id, conversationId: assistantMessages.conversationId })
      .from(assistantMessages)
      .innerJoin(assistantConversations, eq(assistantConversations.id, assistantMessages.conversationId))
      .where(and(eq(assistantMessages.id, body.messageId), eq(assistantConversations.visitorId, visitor.id), eq(assistantMessages.author, "assistant")));
    if (!row) return fail(404, "not_found");
    await open.db.update(assistantMessages).set({ rating: body.rating }).where(eq(assistantMessages.id, row.id));
    return json({ ok: true });
  }
  const [conv] = await open.db
    .select({ id: assistantConversations.id, personId: assistantConversations.personId, clicked: assistantConversations.bookingLinkClickedAt })
    .from(assistantConversations)
    .where(and(eq(assistantConversations.id, body.conversationId), eq(assistantConversations.visitorId, visitor.id)));
  if (!conv) return fail(404, "not_found");
  if (!conv.clicked) {
    await open.db.update(assistantConversations).set({ bookingLinkClickedAt: new Date() }).where(eq(assistantConversations.id, conv.id));
    await logAction(open.db, { conversationId: conv.id, personId: conv.personId, kind: "booking_link_clicked", detail: { href: body.href } });
  }
  return json({ ok: true });
}
