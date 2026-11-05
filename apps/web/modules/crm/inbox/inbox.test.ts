/**
 * crm-P9 unified inbox (crm rules 3.49, 3.50, 3.57; edge cases 27 and 37): every state
 * transition, escalation after 24 opening hours exactly once (one task, one Slack line,
 * weekend hours not counted), linking by email, unknown senders, reopening on new inbound,
 * first response time, one email per reply, notes never sent, duplicate inbound ignored, the
 * Meta reply window and the reply templates.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { activityEvents, auditLog, consentRecords, emailMessages, inboxMessages, inboxThreads, jobs, persons, settings, tasks } from "@beam/db/schema";
import { zonedTimeToUtc } from "@beam/core/platform";

process.env.SENSITIVE_DATA_KEY_V1 ??= randomBytes(32).toString("base64");
vi.mock("next/server", () => ({ after: () => undefined }));
// `crm.send_meta_reply` is declared in crm's `jobs.ts` facade; until it is, the test registry
// carries a stand-in so the reply can be enqueued (the real definition wins once it exists).
vi.mock("@/registry/jobs.generated", async (importOriginal) => {
  const mod = await importOriginal<{ JOB_BY_KIND: Record<string, unknown> }>();
  const added: Record<string, unknown> = {};
  for (const kind of ["crm.send_meta_reply", "crm.close_stale_threads", "crm.escalate_threads"]) {
    if (!mod.JOB_BY_KIND[kind]) added[kind] = { kind, lane: "fast", priority: 5, input: z.object({}).passthrough(), run: () => Promise.resolve(null) };
  }
  return { ...mod, JOB_BY_KIND: { ...mod.JOB_BY_KIND, ...added } };
});

const api = await import("./api");
const { getThread, listThreads, countOpenUnassignedThreads, listReplyTemplates } = await import("./queries");
const { openingHoursDueAt, runCloseStaleThreads, runEscalateThreads } = await import("./jobs");
const { and, eq, setAppDb, sql } = await import("@/lib/ctx");
const { makeCtx, makeJobCtx, resetRuntime, staffActor } = await import("@/lib/testing");

let h: DbHandle;
let agentId: string;
let csId: string;
let agent: ReturnType<typeof staffActor>;

const MONDAY_TO_FRIDAY = {
  week: { 1: { opens_at: "09:00", closes_at: "17:00" }, 2: { opens_at: "09:00", closes_at: "17:00" }, 3: { opens_at: "09:00", closes_at: "17:00" }, 4: { opens_at: "09:00", closes_at: "17:00" }, 5: { opens_at: "09:00", closes_at: "17:00" }, 6: null, 7: null },
  reception_phone: null,
  note: null,
};
/** A Brussels wall-clock time in November 2026 (CET, no DST change inside the tests). */
const at = (day: number, hour: number, minute = 0) => zonedTimeToUtc({ year: 2026, month: 11, day, hour, minute });

async function putSetting(key: string, value: unknown) {
  await h.db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
}

beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
  agentId = (await makeUser(h.db, { roleKey: "customer_service", locale: "en" })).id;
  csId = agentId;
  await makeUser(h.db, { roleKey: "owner" });
  agent = staffActor({ userId: agentId, roleKey: "customer_service", permissions: ["persons.read", "persons.write", "settings.write"] });
  await putSetting("business_hours", MONDAY_TO_FRIDAY);
  await putSetting("inbox", { escalation_hours: 24, stale_pending_days: 14, default_assignee_role: "customer_service", meta_enabled: true });
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

const staff = (now: Date = at(10, 10)) => makeCtx(h.db, { actor: agent, now });
const system = (now: Date = at(10, 10)) => makeCtx(h.db, { now });
const thread = async (id: string) => (await h.db.select().from(inboxThreads).where(eq(inboxThreads.id, id)))[0]!;
const messagesOf = (threadId: string) => h.db.select().from(inboxMessages).where(eq(inboxMessages.threadId, threadId)).orderBy(inboxMessages.occurredAt, inboxMessages.createdAt);
const mid = () => `<${randomUUID()}@mail.example.com>`;

async function inbound(over: Partial<Parameters<typeof api.ingestInboundEmail>[2]> = {}, now = at(10, 10)) {
  const msg = { messageId: mid(), from: `sender-${randomUUID().slice(0, 8)}@example.com`, subject: "Question about my booking", text: "Hello, can I move my sauna slot?", attachmentCount: 0, receivedAt: now, ...over };
  const { threadId } = await api.ingestInboundEmail(h.db as never, system(now), msg);
  return { threadId, msg };
}

describe("rule 3.49: linking inbound messages", () => {
  it("3.49 links an inbound email to the active person with that address (case-insensitive) and records the event", async () => {
    const p = await makePerson(h.db, { email: `linked-${randomUUID().slice(0, 8)}@example.com` });
    const { threadId } = await inbound({ from: p.email!.toUpperCase(), fromName: "Sofie Peeters" });
    const t = await thread(threadId);
    expect(t).toMatchObject({ channel: "email", personId: p.id, status: "open", fromAddress: p.email });
    const events = await h.db.select().from(activityEvents).where(and(eq(activityEvents.personId, p.id), eq(activityEvents.kind, "inbox.message_received")));
    expect(events).toHaveLength(1);
  });

  it("3.49 an unknown sender stays unlinked: no person and no consent are created (edge case 27)", async () => {
    const before = await h.db.select({ n: sql<number>`count(*)::int` }).from(persons);
    const consentsBefore = await h.db.select({ n: sql<number>`count(*)::int` }).from(consentRecords);
    const { threadId } = await inbound({ from: "stranger@example.com" });
    expect((await thread(threadId)).personId).toBeNull();
    expect(await h.db.select({ n: sql<number>`count(*)::int` }).from(persons)).toEqual(before);
    expect(await h.db.select({ n: sql<number>`count(*)::int` }).from(consentRecords)).toEqual(consentsBefore);
  });

  it("3.49 does not link a merged or erased person", async () => {
    const winner = await makePerson(h.db);
    const merged = await makePerson(h.db, { email: `merged-${randomUUID().slice(0, 8)}@example.com` });
    await h.db.update(persons).set({ mergedIntoPersonId: winner.id }).where(eq(persons.id, merged.id));
    const { threadId } = await inbound({ from: merged.email! });
    expect((await thread(threadId)).personId).toBeNull();
  });

  it("staff link a thread to a person and the inbound messages are backfilled on the timeline", async () => {
    const { threadId } = await inbound({ from: "later@example.com" });
    const p = await makePerson(h.db);
    await api.linkStaffThreadPerson(staff(), { threadId, personId: p.id });
    expect((await thread(threadId)).personId).toBe(p.id);
    const events = await h.db.select().from(activityEvents).where(and(eq(activityEvents.personId, p.id), eq(activityEvents.kind, "inbox.message_received")));
    expect(events).toHaveLength(1);
    const [audit] = await h.db.select().from(auditLog).where(and(eq(auditLog.action, "inbox.link"), eq(auditLog.entityId, threadId)));
    expect(audit).toBeDefined();
  });

  it("staff create a person from the sender of an email thread", async () => {
    const email = `new-${randomUUID().slice(0, 8)}@example.com`;
    const { threadId } = await inbound({ from: email, fromName: "Lotte Janssens" });
    const { personId } = await api.linkStaffThreadPerson(staff(), { threadId, createFromSender: { locale: "fr-BE" } });
    const [p] = await h.db.select().from(persons).where(eq(persons.id, personId));
    expect(p).toMatchObject({ email, firstName: "Lotte", lastName: "Janssens", locale: "fr-BE" });
  });
});

describe("rules 3.50 and 3.57: replies, notes and states", () => {
  it("3.57 every state transition: open → pending → open → resolved → open, staff reopen, and refused moves", async () => {
    const p = await makePerson(h.db);
    const { threadId, msg } = await inbound({ from: p.email! }, at(10, 9));
    expect((await thread(threadId)).status).toBe("open");

    await api.replyStaffThread(staff(at(10, 11)), { threadId, body: "Of course, which day suits you?" });
    expect((await thread(threadId)).status).toBe("pending");

    await inbound({ from: p.email!, inReplyTo: msg.messageId, subject: "Re: Question about my booking" }, at(10, 12));
    expect((await thread(threadId)).status).toBe("open");

    await api.updateStaffThread(staff(at(10, 13)), { threadId, status: "resolved" });
    expect(await thread(threadId)).toMatchObject({ status: "resolved", resolvedAt: at(10, 13) });

    await inbound({ from: p.email!, inReplyTo: msg.messageId }, at(10, 14));
    expect(await thread(threadId)).toMatchObject({ status: "open", resolvedAt: null });

    await api.updateStaffThread(staff(at(10, 15)), { threadId, status: "resolved" });
    await api.updateStaffThread(staff(at(10, 16)), { threadId, status: "open" });
    expect(await thread(threadId)).toMatchObject({ status: "open", resolvedAt: null });

    await expect(api.updateStaffThread(staff(), { threadId, status: "pending" })).rejects.toMatchObject({ code: "conflict" });
    await api.replyStaffThread(staff(at(10, 16, 30)), { threadId, body: "Done." });
    await api.updateStaffThread(staff(at(10, 17)), { threadId, status: "resolved" });
    await expect(api.updateStaffThread(staff(), { threadId, status: "pending" })).rejects.toMatchObject({ code: "conflict" });
    const audits = await h.db.select().from(auditLog).where(and(eq(auditLog.action, "inbox.update"), eq(auditLog.entityId, threadId)));
    expect(audits.length).toBe(4);
  });

  it("3.57 crm.close_stale_threads resolves pending threads after 14 days without a message, not before", async () => {
    const { threadId: stale } = await inbound({}, at(1, 10));
    await api.replyStaffThread(staff(at(1, 11)), { threadId: stale, body: "Can you send the booking number?" });
    const { threadId: fresh } = await inbound({}, at(10, 10));
    await api.replyStaffThread(staff(at(10, 11)), { threadId: fresh, body: "We will check." });
    const result = await runCloseStaleThreads(makeJobCtx(h.db, "crm.close_stale_threads" as never, { now: at(15, 12) }), {});
    expect(result.resolved).toBeGreaterThanOrEqual(1);
    expect(await thread(stale)).toMatchObject({ status: "resolved", resolvedAt: at(15, 12) });
    expect((await thread(fresh)).status).toBe("pending");
  });

  it("3.50 the first reply sets first_response_at once", async () => {
    const { threadId } = await inbound({}, at(10, 9));
    await api.replyStaffThread(staff(at(10, 9, 45)), { threadId, body: "First answer" });
    await api.replyStaffThread(staff(at(10, 11)), { threadId, body: "Second answer" });
    const t = await thread(threadId);
    expect(t.firstResponseAt).toEqual(at(10, 9, 45));
    expect(t.firstResponseAt!.getTime() - t.createdAt.getTime()).not.toBeNaN();
  });

  it("3.50 an email reply queues exactly one crm.inbox_reply email with threading headers", async () => {
    const p = await makePerson(h.db, { locale: "fr-BE" });
    const { threadId, msg } = await inbound({ from: p.email! });
    const { messageId } = await api.replyStaffThread(staff(), { threadId, body: "Bonjour, c'est noté." });
    const sent = await h.db.select().from(emailMessages).where(eq(emailMessages.idempotencyKey, `inbox_reply:${messageId}`));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ toEmail: p.email, locale: "fr-BE", replyTo: api.INBOX_REPLY_TO, extraHeaders: { "In-Reply-To": msg.messageId, References: msg.messageId } });
    const [m] = await h.db.select().from(inboxMessages).where(eq(inboxMessages.id, messageId));
    expect(m).toMatchObject({ direction: "out", emailMessageId: sent[0]!.id, sentByUserId: agentId });
    const sendJobs = await h.db.select().from(jobs).where(and(eq(jobs.kind, "email.send"), sql`${jobs.payload}->>'emailMessageId' = ${sent[0]!.id}`));
    expect(sendJobs.length).toBeLessThanOrEqual(1);
    const events = await h.db.select().from(activityEvents).where(and(eq(activityEvents.personId, p.id), eq(activityEvents.kind, "inbox.reply_sent")));
    expect(events).toHaveLength(1);
  });

  it("3.50 an internal note is never sent", async () => {
    const { threadId } = await inbound();
    const emailsBefore = await h.db.select({ n: sql<number>`count(*)::int` }).from(emailMessages);
    const jobsBefore = await h.db.select({ n: sql<number>`count(*)::int` }).from(jobs);
    const { messageId } = await api.addStaffThreadNote(staff(), { threadId, body: "Customer called as well." });
    expect(await h.db.select({ n: sql<number>`count(*)::int` }).from(emailMessages)).toEqual(emailsBefore);
    expect(await h.db.select({ n: sql<number>`count(*)::int` }).from(jobs)).toEqual(jobsBefore);
    const t = await thread(threadId);
    expect(t).toMatchObject({ status: "open", firstResponseAt: null });
    const [m] = await h.db.select().from(inboxMessages).where(eq(inboxMessages.id, messageId));
    expect(m!.direction).toBe("note");
    const [audit] = await h.db.select().from(auditLog).where(and(eq(auditLog.action, "inbox.note"), eq(auditLog.entityId, threadId)));
    expect(JSON.stringify(audit?.newValue)).not.toContain("Customer called");
  });

  it("3.49 a duplicate inbound email (same Message-ID) is ignored", async () => {
    const { threadId, msg } = await inbound();
    const again = await api.ingestInboundEmail(h.db as never, system(), msg);
    expect(again.threadId).toBe(threadId);
    expect(await messagesOf(threadId)).toHaveLength(1);
  });

  it("joins a reply by In-Reply-To, else by sender and subject, else starts a thread", async () => {
    const { threadId, msg } = await inbound({ subject: "Gift voucher" });
    const byHeader = await inbound({ from: "other@example.com", inReplyTo: msg.messageId, subject: "anything" });
    expect(byHeader.threadId).toBe(threadId);
    const bySubject = await inbound({ from: msg.from, subject: "RE: Fwd: gift voucher" });
    expect(bySubject.threadId).toBe(threadId);
    const separate = await inbound({ from: msg.from, subject: "Another question" });
    expect(separate.threadId).not.toBe(threadId);
  });

  it("creates one form thread per submission (cross-module D62)", async () => {
    const p = await makePerson(h.db);
    const submissionId = randomUUID();
    const first = await api.createInboxThreadFromForm(h.db as never, system(), { personId: p.id, submissionId, subject: "Contact form", body: "Please call me back." });
    const second = await api.createInboxThreadFromForm(h.db as never, system(), { personId: p.id, submissionId, subject: "Contact form", body: "Please call me back." });
    expect(second.threadId).toBe(first.threadId);
    expect(await thread(first.threadId)).toMatchObject({ channel: "form", personId: p.id, fromAddress: p.email });
    expect(await messagesOf(first.threadId)).toHaveLength(1);
  });

  it("3.50 a Meta reply is queued inside the 24-hour window and refused after it", async () => {
    const now = at(10, 10);
    const { threadId } = await api.ingestMetaMessage(h.db as never, system(now), { channel: "instagram", mid: `m_${randomUUID()}`, senderId: `psid-${randomUUID()}`, recipientId: "page", text: "Hi!", attachmentCount: 1, sentAt: now });
    const { messageId } = await api.replyStaffThread(staff(at(10, 20)), { threadId, body: "Hello!" });
    const [job] = await h.db.select().from(jobs).where(eq(jobs.idempotencyKey, `meta_reply:${messageId}`));
    expect(job).toMatchObject({ kind: "crm.send_meta_reply", priority: 1 });
    await expect(api.replyStaffThread(staff(at(11, 10, 1)), { threadId, body: "Too late" })).rejects.toMatchObject({ code: "conflict", message: "meta_window_closed" });
    expect((await getThread(h.db, threadId, at(11, 10, 1)))!.replyBlockedReason).toBe("meta_window_closed");
  });
});

describe("rule 3.57: escalation after 24 opening hours", () => {
  it("counts only opening hours: weekends do not count", () => {
    // Friday 13 November 15:00: 2 h on Friday, 8 h Monday, 8 h Tuesday, 6 h Wednesday.
    expect(openingHoursDueAt(at(13, 15), 24, MONDAY_TO_FRIDAY)).toEqual(at(18, 15));
    // A message on Saturday starts counting on Monday at opening time.
    expect(openingHoursDueAt(at(14, 11), 24, MONDAY_TO_FRIDAY)).toEqual(at(18, 17));
    expect(openingHoursDueAt(at(13, 15), 24, { week: { 1: null, 2: null, 3: null, 4: null, 5: null, 6: null, 7: null } })).toBeNull();
  });

  it("escalates exactly once with one high task, one Slack line and one event, and not before 24 opening hours", async () => {
    const p = await makePerson(h.db);
    const { threadId, msg } = await inbound({ from: p.email! }, at(13, 15));
    const run = (now: Date) => runEscalateThreads(makeJobCtx(h.db, "crm.escalate_threads" as never, { now }), {});

    await run(at(16, 12)); // 69 wall-clock hours, 2 + 3 opening hours
    expect((await thread(threadId)).escalatedAt).toBeNull();
    await run(at(18, 14, 59));
    expect((await thread(threadId)).escalatedAt).toBeNull();

    await run(at(18, 15));
    expect((await thread(threadId)).escalatedAt).toEqual(at(18, 15));
    await run(at(18, 16));
    await inbound({ from: p.email!, inReplyTo: msg.messageId }, at(19, 9));
    await run(at(25, 9)); // edge case 37: stays open, no second escalation

    const key = `inbox:${threadId}:escalated`;
    const escalationTasks = await h.db.select().from(tasks).where(eq(tasks.dedupeKey, key));
    expect(escalationTasks).toHaveLength(1);
    expect(escalationTasks[0]).toMatchObject({ kind: "follow_up", priority: "high", ownerUserId: csId, personId: p.id });
    const slack = await h.db.select().from(jobs).where(and(eq(jobs.kind, "notify.slack"), sql`${jobs.payload}->>'fingerprint' = ${key}`));
    expect(slack).toHaveLength(1);
    const events = await h.db.select().from(activityEvents).where(and(eq(activityEvents.personId, p.id), eq(activityEvents.kind, "inbox.escalated")));
    expect(events).toHaveLength(1);
    expect((await thread(threadId)).status).toBe("open");
  });

  it("does not escalate a thread whose inbound message was answered, and gives the task to the assignee", async () => {
    const answered = await inbound({}, at(2, 10));
    await api.replyStaffThread(staff(at(2, 11)), { threadId: answered.threadId, body: "Answered" });
    await api.updateStaffThread(staff(at(2, 11)), { threadId: answered.threadId, status: "open" }).catch(() => undefined);
    const assignee = (await makeUser(h.db, { roleKey: "reception" })).id;
    const waiting = await inbound({}, at(2, 10));
    await api.updateStaffThread(staff(at(2, 10, 5)), { threadId: waiting.threadId, assigneeUserId: assignee });
    await runEscalateThreads(makeJobCtx(h.db, "crm.escalate_threads" as never, { now: at(9, 10) }), {});
    expect((await thread(answered.threadId)).escalatedAt).toBeNull();
    const [task] = await h.db.select().from(tasks).where(eq(tasks.dedupeKey, `inbox:${waiting.threadId}:escalated`));
    expect(task?.ownerUserId).toBe(assignee);
  });
});

describe("queries and templates", () => {
  it("lists threads by status, assignee and escalation and counts open unassigned threads", async () => {
    const { threadId } = await inbound({ subject: "List me" });
    const open = await listThreads(h.db, { status: "open", limit: 500 });
    expect(open.find((r) => r.id === threadId)).toMatchObject({ subject: "List me", status: "open", assigneeUserId: null });
    expect(await countOpenUnassignedThreads(h.db)).toBeGreaterThanOrEqual(1);
    await api.updateStaffThread(staff(), { threadId, assigneeUserId: agentId });
    const mine = await listThreads(h.db, { status: "all", assignee: "me", userId: agentId, limit: 500 });
    expect(mine.map((r) => r.id)).toContain(threadId);
    const unassigned = await listThreads(h.db, { status: "all", assignee: "unassigned", limit: 500 });
    expect(unassigned.map((r) => r.id)).not.toContain(threadId);
    const detail = await getThread(h.db, threadId);
    expect(detail).toMatchObject({ id: threadId, replyBlockedReason: null });
    expect(detail!.messages[0]).toMatchObject({ direction: "in", body: "Hello, can I move my sauna slot?" });
  });

  it("saves reply templates with every locale and refuses an incomplete one", async () => {
    const text = { "nl-BE": "Bedankt voor je bericht.", "fr-BE": "Merci pour votre message.", en: "Thank you for your message." };
    const { templateId } = await api.saveStaffReplyTemplate(staff(), { key: "thanks", name: { "nl-BE": "Bedankt", "fr-BE": "Merci", en: "Thanks" }, body: text, isActive: true });
    await expect(api.saveStaffReplyTemplate(staff(), { key: "thanks-2", name: { "nl-BE": "Bedankt", en: "Thanks" }, body: text, isActive: true })).rejects.toMatchObject({ code: "validation" });
    await expect(api.saveStaffReplyTemplate(staff(), { key: "thanks", name: text, body: text, isActive: true })).rejects.toMatchObject({ code: "validation" });
    await api.saveStaffReplyTemplate(staff(), { id: templateId, key: "thanks", name: text, body: text, isActive: false });
    expect((await listReplyTemplates(h.db)).map((t) => t.key)).not.toContain("thanks");
    expect((await listReplyTemplates(h.db, { includeInactive: true })).map((t) => t.key)).toContain("thanks");
  });

  it("marks a thread sensitive with an audit row", async () => {
    const { threadId } = await inbound();
    await api.markStaffThreadSensitive(staff(), { threadId, isSensitive: true });
    expect((await thread(threadId)).isSensitive).toBe(true);
    const rows = await h.db.select().from(auditLog).where(and(eq(auditLog.action, "inbox.sensitive"), eq(auditLog.entityId, threadId)));
    expect(rows).toHaveLength(1);
  });
});
