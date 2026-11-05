/**
 * Inbox reads (crm spec 4.3 and 5.1), crm-P9: `listThreads`, `getThread`, the reply templates,
 * the nav badge count and the linked-person summary of the sidebar (status, credits, next
 * booking through credits' and booking's apis).
 */
import type { DbOrTx } from "@beam/db";
import { inboxMessages, inboxReplyTemplates, inboxThreads, persons, users, type InboxChannel, type InboxMessageDirection, type InboxThreadStatus } from "@beam/db/schema";
import type { Locale, LocalizedText } from "@beam/core/i18n";
import { and, asc, desc, eq, isNotNull, isNull, sql, type SQL } from "@/lib/ctx";
import { META_WINDOW_MS, isMetaChannel, metaWindowOpen } from "./api";

export type ThreadFilter = {
  status?: InboxThreadStatus | "all";
  /** A user id, `me` (with `userId`), `unassigned` or `all`. */
  assignee?: string;
  userId?: string;
  channel?: InboxChannel | "all";
  escalatedOnly?: boolean;
  /** Hide Instagram and Messenger threads (flag `ff_crm_inbox_meta` off). */
  hideMeta?: boolean;
  limit?: number;
};

export type ThreadRow = {
  id: string;
  channel: InboxChannel;
  status: InboxThreadStatus;
  subject: string | null;
  sender: string;
  personId: string | null;
  personName: string | null;
  assigneeUserId: string | null;
  assigneeName: string | null;
  lastMessageAt: Date;
  lastMessagePreview: string;
  escalated: boolean;
};

const fullName = (first: string | null, last: string | null) => [first, last].filter((s) => !!s?.trim()).join(" ") || null;

/** The thread list (newest message first, at most `limit`, default 100). */
export async function listThreads(db: DbOrTx, filter: ThreadFilter = {}): Promise<ThreadRow[]> {
  const where: SQL[] = [];
  const status = filter.status ?? "open";
  if (status !== "all") where.push(eq(inboxThreads.status, status));
  if (filter.channel && filter.channel !== "all") where.push(eq(inboxThreads.channel, filter.channel));
  if (filter.hideMeta) where.push(sql`${inboxThreads.channel} not in ('instagram', 'messenger')`);
  if (filter.escalatedOnly) where.push(isNotNull(inboxThreads.escalatedAt));
  if (filter.assignee === "unassigned") where.push(isNull(inboxThreads.assigneeUserId));
  else if (filter.assignee === "me" && filter.userId) where.push(eq(inboxThreads.assigneeUserId, filter.userId));
  else if (filter.assignee && filter.assignee !== "all" && filter.assignee !== "me") where.push(eq(inboxThreads.assigneeUserId, filter.assignee));

  const rows = await db
    .select({
      t: inboxThreads,
      firstName: persons.firstName,
      lastName: persons.lastName,
      assigneeName: sql<string | null>`coalesce(${users.name}, ${users.email})`,
      preview: sql<string | null>`(select left(m.body, 160) from inbox_messages m where m.thread_id = ${inboxThreads.id} and m.direction <> 'note' order by m.occurred_at desc, m.id desc limit 1)`,
    })
    .from(inboxThreads)
    .leftJoin(persons, eq(persons.id, inboxThreads.personId))
    .leftJoin(users, eq(users.id, inboxThreads.assigneeUserId))
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(inboxThreads.lastMessageAt), desc(inboxThreads.id))
    .limit(Math.min(Math.max(filter.limit ?? 100, 1), 500));
  return rows.map(({ t, firstName, lastName, assigneeName, preview }) => {
    const personName = t.personId ? fullName(firstName, lastName) : null;
    return {
      id: t.id,
      channel: t.channel,
      status: t.status,
      subject: t.subject,
      sender: personName ?? t.fromName ?? t.fromAddress ?? "—",
      personId: t.personId,
      personName,
      assigneeUserId: t.assigneeUserId,
      assigneeName: t.assigneeUserId ? assigneeName : null,
      lastMessageAt: t.lastMessageAt,
      lastMessagePreview: (preview ?? "").replace(/\s+/g, " ").trim(),
      escalated: !!t.escalatedAt,
    };
  });
}

/** The nav badge: open threads nobody is assigned to. */
export async function countOpenUnassignedThreads(db: DbOrTx): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(inboxThreads)
    .where(and(eq(inboxThreads.status, "open"), isNull(inboxThreads.assigneeUserId)));
  return Number(row?.n ?? 0);
}

export type ThreadMessage = {
  id: string;
  direction: InboxMessageDirection;
  body: string;
  occurredAt: Date;
  sentByName: string | null;
  attachmentCount: number;
  deliveryError: string | null;
  /** `out` on a Meta thread: delivered once Meta gave it an id. */
  delivered: boolean | null;
  emailStatus: string | null;
};

export type ThreadDetail = {
  id: string;
  channel: InboxChannel;
  status: InboxThreadStatus;
  subject: string | null;
  fromAddress: string | null;
  fromName: string | null;
  personId: string | null;
  assigneeUserId: string | null;
  isSensitive: boolean;
  firstResponseAt: Date | null;
  escalatedAt: Date | null;
  resolvedAt: Date | null;
  createdAt: Date;
  /** Rule 3.50: why replying is not possible now, else null. */
  replyBlockedReason: "meta_window_closed" | "no_recipient" | null;
  /** Meta threads: when the 24-hour window closes. */
  metaWindowClosesAt: Date | null;
  messages: ThreadMessage[];
};

/** One thread with its messages, oldest first (null when unknown). */
export async function getThread(db: DbOrTx, id: string, now: Date = new Date()): Promise<ThreadDetail | null> {
  const [t] = await db.select().from(inboxThreads).where(eq(inboxThreads.id, id));
  if (!t) return null;
  const rows = await db
    .select({
      m: inboxMessages,
      sentByName: sql<string | null>`coalesce(${users.name}, ${users.email})`,
      emailStatus: sql<string | null>`(select e.status::text from email_messages e where e.id = ${inboxMessages.emailMessageId})`,
    })
    .from(inboxMessages)
    .leftJoin(users, eq(users.id, inboxMessages.sentByUserId))
    .where(eq(inboxMessages.threadId, id))
    .orderBy(asc(inboxMessages.occurredAt), asc(inboxMessages.createdAt), asc(inboxMessages.id));
  const meta = isMetaChannel(t.channel);
  const replyBlockedReason = meta ? (metaWindowOpen(t.lastInboundAt, now) ? null : "meta_window_closed") : !t.fromAddress && !t.personId ? "no_recipient" : null;
  return {
    id: t.id,
    channel: t.channel,
    status: t.status,
    subject: t.subject,
    fromAddress: t.fromAddress,
    fromName: t.fromName,
    personId: t.personId,
    assigneeUserId: t.assigneeUserId,
    isSensitive: t.isSensitive,
    firstResponseAt: t.firstResponseAt,
    escalatedAt: t.escalatedAt,
    resolvedAt: t.resolvedAt,
    createdAt: t.createdAt,
    replyBlockedReason,
    metaWindowClosesAt: meta && t.lastInboundAt ? new Date(t.lastInboundAt.getTime() + META_WINDOW_MS) : null,
    messages: rows.map(({ m, sentByName, emailStatus }) => ({
      id: m.id,
      direction: m.direction,
      body: m.body,
      occurredAt: m.occurredAt,
      sentByName: m.sentByUserId ? sentByName : null,
      attachmentCount: m.attachmentCount,
      deliveryError: m.deliveryError,
      delivered: meta && m.direction === "out" ? !!m.externalMessageId : null,
      emailStatus,
    })),
  };
}

export type ReplyTemplateRow = { id: string; key: string; name: LocalizedText; body: LocalizedText; isActive: boolean };

/** Reply templates by key (active only unless `includeInactive`). */
export async function listReplyTemplates(db: DbOrTx, opts: { includeInactive?: boolean } = {}): Promise<ReplyTemplateRow[]> {
  return db
    .select({ id: inboxReplyTemplates.id, key: inboxReplyTemplates.key, name: inboxReplyTemplates.name, body: inboxReplyTemplates.body, isActive: inboxReplyTemplates.isActive })
    .from(inboxReplyTemplates)
    .where(opts.includeInactive ? undefined : eq(inboxReplyTemplates.isActive, true))
    .orderBy(asc(inboxReplyTemplates.key));
}

export type PersonSidebar = {
  id: string;
  name: string;
  email: string | null;
  locale: Locale;
  status: string;
  credits: { kind: string; remainingUnits: number }[];
  membership: string | null;
  nextBookingAt: Date | null;
};

/** The linked person's summary (status, credits, next booking), or null for an unknown id. */
export async function getPersonSidebar(db: DbOrTx, personId: string): Promise<PersonSidebar | null> {
  const [p] = await db
    .select({ id: persons.id, firstName: persons.firstName, lastName: persons.lastName, email: persons.email, locale: persons.locale })
    .from(persons)
    .where(eq(persons.id, personId));
  if (!p) return null;
  const [{ getPersonCreditSummary }, { getNextBooking }] = await Promise.all([import("@/modules/credits/api"), import("@/modules/booking/api")]);
  const [credits, next] = await Promise.all([getPersonCreditSummary(db, personId), getNextBooking(db, personId)]);
  return {
    id: p.id,
    name: fullName(p.firstName, p.lastName) ?? p.email ?? "—",
    email: p.email,
    locale: p.locale,
    status: credits.status,
    credits: credits.byKind.filter((c) => c.remainingUnits > 0).map((c) => ({ kind: c.kind, remainingUnits: c.remainingUnits })),
    membership: credits.membership?.status ?? null,
    nextBookingAt: next?.startsAt ?? null,
  };
}

/** Staff the thread can be assigned to (anyone who may reply). */
export async function listInboxAssignees(db: DbOrTx): Promise<{ userId: string; name: string }[]> {
  const { listStaffForAssignment } = await import("@/modules/platform/api");
  return (await listStaffForAssignment(db, { permission: "persons.write" })).map((s) => ({ userId: s.userId, name: s.name }));
}
