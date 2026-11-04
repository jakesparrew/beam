"use server";
/**
 * Notes and interactions (crm spec 4.1, rule 3.26), crm-P7. Both write one timeline event on the
 * person (a merged id resolves to its winner) or the company. A sensitive note needs
 * `persons.sensitive_read` and a person, and is stored as an `is_sensitive` event whose `data` is
 * `{ body_enc, key_version }` (platform's `encryptNote`). The audit rows (`note.add`,
 * `interaction.log`) never carry the body; the wrapper's automatic row is off because it would
 * copy the input.
 */
import { z } from "zod";
import { companies, persons } from "@beam/db/schema";
import { action } from "@/lib/action";
import { AppError, ConflictError, eq, NotFoundError, type Ctx } from "@/lib/ctx";
import { encryptNote } from "@/modules/platform/api";
import { TIMELINE_CATEGORIES } from "@beam/core/crm";
import { resolveCanonicalPersonId } from "../persons/api";
import type { TimelineRowView } from "../ui/timeline/event-row";
import { listTimeline } from "./api";
import { toTimelineRows } from "./queries";

const Subject = z.object({ personId: z.uuid().optional(), companyId: z.uuid().optional() });

/** The active subject of a note or interaction: the canonical person and/or an existing company. */
async function subjectOf(ctx: Ctx, input: z.infer<typeof Subject>): Promise<{ personId?: string; companyId?: string }> {
  if (!input.personId && !input.companyId) throw new AppError("validation", "subject_required", { personId: "required" });
  const out: { personId?: string; companyId?: string } = {};
  if (input.personId) {
    const id = await resolveCanonicalPersonId(ctx.tx, input.personId);
    const [p] = await ctx.tx.select({ id: persons.id, erasedAt: persons.erasedAt }).from(persons).where(eq(persons.id, id));
    if (!p) throw new NotFoundError("person_not_found");
    if (p.erasedAt) throw new ConflictError("person_erased");
    out.personId = p.id;
  }
  if (input.companyId) {
    const [c] = await ctx.tx.select({ id: companies.id }).from(companies).where(eq(companies.id, input.companyId));
    if (!c) throw new NotFoundError("company_not_found");
    out.companyId = c.id;
  }
  return out;
}

const eventIdOf = (id: bigint | null): string => {
  if (id === null) throw new ConflictError("event_not_recorded");
  return id.toString();
};

export const addNote = action(
  {
    name: "crm.add_note",
    audience: "staff",
    permission: "persons.write",
    input: Subject.extend({ body: z.string().trim().min(1).max(10_000), isSensitive: z.boolean() }),
    audit: false,
  },
  async (ctx, input): Promise<{ eventId: string }> => {
    if (input.isSensitive) {
      ctx.require("persons.sensitive_read");
      if (!input.personId) throw new AppError("validation", "sensitive_note_needs_person", { personId: "required" });
    }
    const subject = await subjectOf(ctx, input);
    const { id } = input.isSensitive
      ? await ctx.recordEvent({ kind: "note.added", ...subject, isSensitive: true, data: encryptNote(subject.personId!, input.body) })
      : await ctx.recordEvent({ kind: "note.added", ...subject, data: { body: input.body } });
    const eventId = eventIdOf(id);
    await ctx.audit({
      action: "note.add",
      entityType: subject.personId ? "person" : "company",
      entityId: subject.personId ?? subject.companyId ?? null,
      personId: subject.personId ?? null,
      oldValue: null,
      newValue: { event_id: eventId, is_sensitive: input.isSensitive, ...(subject.companyId ? { company_id: subject.companyId } : {}) },
    });
    return { eventId };
  },
);

export const logInteraction = action(
  {
    name: "crm.log_interaction",
    audience: "staff",
    permission: "persons.write",
    input: Subject.extend({
      channel: z.enum(["call", "email", "whatsapp", "in_person", "meeting", "other"]),
      purpose: z.enum(["service", "sales_follow_up", "reactivation", "b2b"]),
      summary: z.string().trim().min(1).max(2000),
      occurredAt: z.coerce.date().optional(),
    }),
    audit: false,
  },
  async (ctx, input): Promise<{ eventId: string }> => {
    if (input.occurredAt && input.occurredAt.getTime() > ctx.now.getTime() + 5 * 60_000) {
      throw new AppError("validation", "occurred_in_future", { occurredAt: "future" });
    }
    const subject = await subjectOf(ctx, input);
    const { id } = await ctx.recordEvent({
      kind: "interaction.logged",
      ...subject,
      ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
      data: { channel: input.channel, purpose: input.purpose, summary: input.summary },
    });
    const eventId = eventIdOf(id);
    await ctx.audit({
      action: "interaction.log",
      entityType: subject.personId ? "person" : "company",
      entityId: subject.personId ?? subject.companyId ?? null,
      personId: subject.personId ?? null,
      oldValue: null,
      newValue: { event_id: eventId, channel: input.channel, purpose: input.purpose, occurred_at: (input.occurredAt ?? ctx.now).toISOString() },
    });
    return { eventId };
  },
);

/**
 * The 360 timeline's "show older activity" and category chips (rule 3.37): one page of display
 * rows after the cursor. A read, so no audit row.
 */
export const loadTimeline = action(
  {
    name: "crm.load_timeline",
    audience: "staff",
    permission: "persons.read",
    input: Subject.extend({
      before: z.object({ occurredAt: z.coerce.date(), id: z.string().regex(/^([0-9]+|automation:[0-9a-f-]{36})$/) }).optional(),
      categories: z.array(z.enum(TIMELINE_CATEGORIES)).max(TIMELINE_CATEGORIES.length).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    audit: false,
  },
  async (ctx, input): Promise<{ rows: TimelineRowView[]; nextBefore: { occurredAt: string; id: string } | null }> => {
    if (!input.personId === !input.companyId) throw new AppError("validation", "subject_required", { personId: "required" });
    const page = await listTimeline(ctx.tx, {
      ...(input.personId ? { personId: input.personId } : { companyId: input.companyId! }),
      ...(input.before ? { before: input.before } : {}),
      ...(input.categories?.length ? { categories: input.categories } : {}),
      limit: input.limit ?? 50,
    });
    const rows = await toTimelineRows(ctx.tx, page.items, ctx.locale);
    return { rows, nextBefore: page.nextBefore ? { occurredAt: page.nextBefore.occurredAt.toISOString(), id: page.nextBefore.id } : null };
  },
);
