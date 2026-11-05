/**
 * crm-P10 AI reply drafts with the Claude fake (crm rules 3.51 and 3.58, edge case 29):
 * active articles in the thread's locale are in the prompt and inactive ones are not, the
 * knowledge context is cut at 20,000 characters, notes and older messages are left out; a
 * sensitive thread or a keyword match sends nothing; a budget stop marks the draft failed; a
 * draft is never sent without a staff action; `ai_requests.fields_sent` never names email or
 * phone; Send with the draft records `used`. Also the knowledge base, the job run twice and the
 * nav badges.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { aiRequests, auditLog, emailMessages, inboxMessages, inboxThreads, jobs, settings, supportKnowledgeArticles } from "@beam/db/schema";
import { DEFAULT_AI_PRICING } from "@beam/core/ai";
import type { ClaudeRequest } from "@beam/integrations/anthropic";

process.env.SENSITIVE_DATA_KEY_V1 ??= randomBytes(32).toString("base64");
vi.mock("next/server", () => ({ after: () => undefined }));
// `ai.draft_reply` is declared in crm's `jobs.ts` facade; until it is, the test registry carries
// the real definitions from `./jobs` (a registered definition wins).
vi.mock("@/registry/jobs.generated", async (importOriginal) => {
  const mod = await importOriginal<{ JOB_BY_KIND: Record<string, unknown> }>();
  const { INBOX_JOBS } = await import("./jobs");
  const added: Record<string, unknown> = {};
  for (const def of INBOX_JOBS) if (!mod.JOB_BY_KIND[def.kind]) added[def.kind] = def;
  return { ...mod, JOB_BY_KIND: { ...mod.JOB_BY_KIND, ...added } };
});

const draft = await import("./ai-draft");
const { listKnowledgeArticles } = await import("../knowledge/queries");
const { nav } = await import("../nav");
const { and, eq, flushDurableWrites, setAppDb, sql } = await import("@/lib/ctx");
const { rowsOf } = await import("@/lib/sensitive");
const { createFakeIntegrations, makeCtx, makeJobCtx, resetRuntime, runJobTwice, staffActor } = await import("@/lib/testing");

let h: DbHandle;
let agentId: string;
let agent: ReturnType<typeof staffActor>;

const AI_DEFAULT = {
  sensitive_enabled: false,
  purpose: null,
  dpia_reference: null,
  enabled_by_user_id: null,
  enabled_at: null,
  monthly_budget_cents: 1_000_000,
  daily_cap_calls: 10_000,
  pricing: { ...DEFAULT_AI_PRICING },
};

async function putSetting(key: string, value: unknown) {
  await h.db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
}

beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
  agentId = (await makeUser(h.db, { roleKey: "customer_service", locale: "en" })).id;
  agent = staffActor({ userId: agentId, roleKey: "customer_service", permissions: ["persons.read", "persons.write", "settings.write", "ai.use"] });
  await putSetting("inbox", { escalation_hours: 24, stale_pending_days: 14, default_assignee_role: "customer_service", meta_enabled: true });
});
beforeEach(async () => {
  await putSetting("ai", AI_DEFAULT);
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

const staff = () => makeCtx(h.db, { actor: agent });
const HOUR = 3_600_000;
const messageRow = async (id: string) => (await h.db.select().from(inboxMessages).where(eq(inboxMessages.id, id)))[0]!;
const promptOf = (r: ClaudeRequest) => `${r.system}\n${r.messages.map((m) => m.content).join("\n")}`;

/** An email thread with `bodies` (oldest first; `note:` and `out:` prefixes set the direction); returns the last inbound message. */
async function emailThread(opts: { bodies: string[]; personLocale?: "nl-BE" | "fr-BE" | "en"; linked?: boolean; isSensitive?: boolean }) {
  const p = await makePerson(h.db, { email: `ai-${randomUUID().slice(0, 8)}@example.com`, phoneE164: "+32470123456", firstName: "Sofie", lastName: "Peeters-Unique", locale: opts.personLocale ?? "nl-BE" });
  const start = Date.now() - opts.bodies.length * HOUR;
  const [t] = await h.db
    .insert(inboxThreads)
    .values({ channel: "email", externalThreadId: `<${randomUUID()}@example.com>`, personId: opts.linked === false ? null : p.id, fromAddress: p.email, subject: "Question", lastMessageAt: new Date(), lastInboundAt: new Date(), isSensitive: opts.isSensitive ?? false })
    .returning();
  let lastIn = "";
  for (const [i, raw] of opts.bodies.entries()) {
    const direction = raw.startsWith("note:") ? "note" : raw.startsWith("out:") ? "out" : "in";
    const body = raw.replace(/^(note|out):/, "");
    const [m] = await h.db
      .insert(inboxMessages)
      .values({ threadId: t!.id, direction, body, externalMessageId: direction === "in" ? `<${randomUUID()}@example.com>` : null, occurredAt: new Date(start + i * HOUR) })
      .returning();
    if (direction === "in") lastIn = m!.id;
  }
  return { person: p, threadId: t!.id, messageId: lastIn };
}

async function article(key: string, body: Partial<Record<"nl-BE" | "fr-BE" | "en", string>>, isActive = true) {
  await h.db
    .insert(supportKnowledgeArticles)
    .values({ key, title: { "nl-BE": `Titel ${key}`, "fr-BE": `Titre ${key}`, en: `Title ${key}` }, body, isActive })
    .onConflictDoUpdate({ target: supportKnowledgeArticles.key, set: { body, isActive } });
}

/** Request a draft as staff, then run the job once with `integrations`. */
async function requestAndRun(messageId: string, integrations = createFakeIntegrations()) {
  const requested = await draft.requestDraft(staff(), { messageId });
  const ctx = makeJobCtx(h.db, "ai.draft_reply" as never, { integrations });
  const result = requested.jobId ? await draft.runDraftReply(ctx, { messageId }) : null;
  return { requested, result, integrations, ctx };
}

describe("buildDraftPrompt (rule 3.58)", () => {
  it("puts the articles in key order, the context JSON and the conversation in the prompt", () => {
    const at = new Date("2026-11-05T09:00:00Z");
    const p = draft.buildDraftPrompt(
      { first_name: "Sofie", locale: "fr-BE", credits_remaining: 3 },
      [
        { direction: "in", body: "Bonjour, puis-je déplacer ma séance ?", occurredAt: at },
        { direction: "out", body: "Bien sûr.", occurredAt: at },
      ],
      [
        { key: "zz-last", title: "Z", body: "Last policy" },
        { key: "aa-first", title: "A", body: "First policy" },
      ],
    );
    expect(p.system).toContain("French (Belgium)");
    expect(p.system).toContain('"first_name":"Sofie"');
    expect(p.system.indexOf("First policy")).toBeLessThan(p.system.indexOf("Last policy"));
    expect(p.user).toContain("[Customer, 2026-11-05T09:00:00.000Z]");
    expect(p.user).toContain("[BEAM, 2026-11-05T09:00:00.000Z]\nBien sûr.");
  });

  it("cuts the knowledge part at 20,000 characters and leaves later articles out", () => {
    const big = "x".repeat(15_000);
    const section = draft.knowledgeSection([
      { key: "b", title: "B", body: big },
      { key: "a", title: "A", body: big },
      { key: "c", title: "C", body: "never reached" },
    ]);
    expect(section.length).toBe(draft.KNOWLEDGE_CONTEXT_MAX_CHARS);
    expect(section.startsWith("### A [a]")).toBe(true);
    expect(section).toContain("### B [b]");
    expect(section).not.toContain("never reached");
  });
});

describe("ai.draft_reply job (rule 3.58)", () => {
  it("uses the active articles in the thread's locale, not inactive ones or other languages, and the last 10 non-note messages", async () => {
    await article("p10-cancel", { "nl-BE": "Annuleren kan tot 24 uur vooraf.", "fr-BE": "Annulation jusqu'à 24 heures avant.", en: "Cancel up to 24 hours before." });
    await article("p10-old-hours", { "nl-BE": "Oude openingsuren: gesloten op maandag.", "fr-BE": "Anciens horaires.", en: "Old hours." }, false);
    const bodies = [...Array.from({ length: 12 }, (_, i) => `Bericht nummer ${i + 1}.`), "note:INTERNAL-NOTE-ONLY-STAFF", "Kan ik mijn sessie verplaatsen?"];
    const t = await emailThread({ bodies, personLocale: "nl-BE" });
    const { requested, result, integrations } = await requestAndRun(t.messageId);
    expect(requested.status).toBe("pending");
    expect(result).toMatchObject({ status: "ready" });
    expect(integrations.anthropic.calls).toHaveLength(1);
    const req = integrations.anthropic.calls[0]!.input;
    expect(req).toMatchObject({ feature: "ai.draft_reply", model: "claude-opus-5-5" });
    const prompt = promptOf(req);
    expect(prompt).toContain("Annuleren kan tot 24 uur vooraf.");
    expect(prompt).not.toContain("Cancel up to 24 hours before.");
    expect(prompt).not.toContain("Oude openingsuren");
    expect(prompt).not.toContain("INTERNAL-NOTE-ONLY-STAFF");
    expect(prompt).toContain("Kan ik mijn sessie verplaatsen?");
    expect(prompt).toContain("Bericht nummer 12.");
    expect(prompt).toContain("Bericht nummer 4.");
    expect(prompt).not.toContain("Bericht nummer 3.");
    const m = await messageRow(t.messageId);
    expect(m.aiDraftStatus).toBe("ready");
    expect(m.aiDraft).toContain("Thank you for your message");
    expect(m.aiRequestId).toBe((result as { aiRequestId: string }).aiRequestId);
  });

  it("cuts the knowledge context at 20,000 characters", async () => {
    await h.db.update(supportKnowledgeArticles).set({ isActive: false });
    await article("p10-big-a", { "nl-BE": "A".repeat(4_999), "fr-BE": "a", en: "a" });
    await article("p10-big-b", { "nl-BE": "B".repeat(4_999), "fr-BE": "b", en: "b" });
    await article("p10-big-c", { "nl-BE": "C".repeat(4_999), "fr-BE": "c", en: "c" });
    await article("p10-big-d", { "nl-BE": "D".repeat(4_999), "fr-BE": "d", en: "d" });
    await article("p10-big-e", { "nl-BE": "EEEE-NOT-INCLUDED", "fr-BE": "e", en: "e" });
    const t = await emailThread({ bodies: ["Wat zijn jullie regels?"] });
    const { integrations } = await requestAndRun(t.messageId);
    const system = integrations.anthropic.calls[0]!.input.system;
    const knowledge = system.slice(system.indexOf("## BEAM policies\n") + "## BEAM policies\n".length, system.indexOf("\n\n## Customer context"));
    expect(knowledge.length).toBeLessThanOrEqual(draft.KNOWLEDGE_CONTEXT_MAX_CHARS);
    expect(knowledge.length).toBeGreaterThan(19_000);
    expect(knowledge).not.toContain("EEEE-NOT-INCLUDED");
    await h.db.update(supportKnowledgeArticles).set({ isActive: false }).where(sql`${supportKnowledgeArticles.key} like 'p10-big-%'`);
  });

  it("ai_requests.fields_sent names only allow-listed person fields, never email or phone", async () => {
    const t = await emailThread({ bodies: ["Hoeveel beurten heb ik nog?"] });
    const { result, integrations } = await requestAndRun(t.messageId);
    const [row] = await h.db.select().from(aiRequests).where(eq(aiRequests.id, (result as { aiRequestId: string }).aiRequestId));
    expect(row).toMatchObject({ feature: "ai.draft_reply", status: "ok", personId: t.person.id });
    expect(row!.fieldsSent).toContain("first_name");
    for (const f of ["email", "phone", "phone_e164", "last_name", "health_note"]) expect(row!.fieldsSent).not.toContain(f);
    const prompt = promptOf(integrations.anthropic.calls[0]!.input);
    expect(prompt).not.toContain(t.person.email!);
    expect(prompt).not.toContain("+32470123456");
    expect(prompt).not.toContain("Peeters-Unique");
  });

  it("drafts for an unlinked sender without any person field", async () => {
    const t = await emailThread({ bodies: ["What should I bring to the sauna?"], linked: false });
    const { result } = await requestAndRun(t.messageId);
    const [row] = await h.db.select().from(aiRequests).where(eq(aiRequests.id, (result as { aiRequestId: string }).aiRequestId));
    expect(row).toMatchObject({ personId: null, fieldsSent: [] });
  });
});

describe("rule 3.51: the sensitive screen and staff approval", () => {
  it("a thread marked sensitive is blocked at once: no job, nothing sent to Claude", async () => {
    const t = await emailThread({ bodies: ["Kan ik verplaatsen?"], isSensitive: true });
    const before = (await h.db.select().from(aiRequests)).length;
    const { requested, integrations } = await requestAndRun(t.messageId);
    expect(requested).toEqual({ jobId: null, status: "blocked_sensitive" });
    expect(integrations.anthropic.calls).toHaveLength(0);
    expect((await h.db.select().from(aiRequests)).length).toBe(before);
    expect((await messageRow(t.messageId)).aiDraftStatus).toBe("blocked_sensitive");
    expect(await h.db.select().from(jobs).where(eq(jobs.idempotencyKey, `ai:draft_reply:${t.messageId}`))).toHaveLength(0);
    const [audit] = await h.db.select().from(auditLog).where(and(eq(auditLog.action, "ai.request"), eq(auditLog.entityId, t.messageId)));
    expect(audit).toBeTruthy();
  });

  it("a customer message about burn-out is blocked by the keyword screen (edge case 29)", async () => {
    const t = await emailThread({ bodies: ["Ik zit thuis met een burn-out, kan ik mijn abonnement pauzeren?"] });
    const { requested, integrations } = await requestAndRun(t.messageId);
    expect(requested.status).toBe("blocked_sensitive");
    expect(integrations.anthropic.calls).toHaveLength(0);
  });

  it("the job screens again: a thread marked sensitive after the request sends nothing", async () => {
    const t = await emailThread({ bodies: ["Wanneer zijn jullie open?"] });
    const requested = await draft.requestDraft(staff(), { messageId: t.messageId });
    expect(requested.status).toBe("pending");
    await h.db.update(inboxThreads).set({ isSensitive: true }).where(eq(inboxThreads.id, t.threadId));
    const integrations = createFakeIntegrations();
    const result = await draft.runDraftReply(makeJobCtx(h.db, "ai.draft_reply" as never, { integrations }), { messageId: t.messageId });
    expect(result).toMatchObject({ status: "blocked_sensitive" });
    expect(integrations.anthropic.calls).toHaveLength(0);
    expect((await messageRow(t.messageId)).aiDraftStatus).toBe("blocked_sensitive");
  });

  it("with settings.ai.sensitive_enabled the keyword screen does not block", async () => {
    await putSetting("ai", { ...AI_DEFAULT, sensitive_enabled: true });
    const t = await emailThread({ bodies: ["Ik ben zwanger, mag ik nog in de sauna?"] });
    const { requested, result } = await requestAndRun(t.messageId);
    expect(requested.status).toBe("pending");
    expect(result).toMatchObject({ status: "ready" });
  });

  it("a budget stop marks the draft failed (PermanentError)", async () => {
    await putSetting("ai", { ...AI_DEFAULT, monthly_budget_cents: 0 });
    const t = await emailThread({ bodies: ["Wat kost een beurt?"] });
    await draft.requestDraft(staff(), { messageId: t.messageId });
    const integrations = createFakeIntegrations();
    let ctx: ReturnType<typeof makeJobCtx> | undefined;
    await expect(
      h.db.transaction(async (tx) => {
        ctx = makeJobCtx(h.db, "ai.draft_reply" as never, { integrations, tx });
        await draft.runDraftReply(ctx, { messageId: t.messageId });
      }),
    ).rejects.toMatchObject({ name: "PermanentError", message: "budget" });
    await flushDurableWrites(h.db, ctx!);
    expect((await messageRow(t.messageId)).aiDraftStatus).toBe("failed");
    expect(integrations.anthropic.calls).toHaveLength(0);
    const rows = await h.db.select().from(aiRequests).where(and(eq(aiRequests.feature, "ai.draft_reply"), eq(aiRequests.status, "budget_exceeded")));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    // A failed draft can be requested again (a new job key).
    await putSetting("ai", AI_DEFAULT);
    const again = await draft.requestDraft(staff(), { messageId: t.messageId });
    expect(again.status).toBe("pending");
    const [job] = await h.db.select().from(jobs).where(eq(jobs.id, again.jobId!));
    expect(job!.idempotencyKey).toBe(`ai:draft_reply:${t.messageId}:r1`);
  });

  it("a ready draft is never sent without a staff action", async () => {
    const t = await emailThread({ bodies: ["Hoe laat sluiten jullie?"] });
    await requestAndRun(t.messageId);
    expect((await messageRow(t.messageId)).aiDraftStatus).toBe("ready");
    const outs = await h.db.select().from(inboxMessages).where(and(eq(inboxMessages.threadId, t.threadId), eq(inboxMessages.direction, "out")));
    expect(outs).toHaveLength(0);
    expect(await h.db.select().from(emailMessages).where(eq(emailMessages.personId, t.person.id))).toHaveLength(0);
    const queued = rowsOf<{ kind: string }>(await h.db.execute(sql`select kind from jobs where payload->>'messageId' = ${t.messageId}`));
    expect(queued.map((j) => j.kind)).toEqual(["ai.draft_reply"]);
  });

  it("Send with the draft records used; a second request is refused", async () => {
    const t = await emailThread({ bodies: ["Mag ik een vriend meebrengen?"] });
    await requestAndRun(t.messageId);
    const edited = `${(await messageRow(t.messageId)).aiDraft} (edited by staff)`;
    const { messageId: outId } = await draft.replyWithDraft(staff(), { threadId: t.threadId, body: edited, usedAiDraftMessageId: t.messageId });
    expect((await messageRow(t.messageId)).aiDraftStatus).toBe("used");
    const out = await messageRow(outId);
    expect(out).toMatchObject({ direction: "out", body: edited, sentByUserId: agentId });
    await expect(draft.requestDraft(staff(), { messageId: t.messageId })).rejects.toMatchObject({ code: "conflict" });
  });

  it("a reply naming a draft of another thread does not mark it used", async () => {
    const a = await emailThread({ bodies: ["Vraag A"] });
    const b = await emailThread({ bodies: ["Vraag B"] });
    await requestAndRun(a.messageId);
    await draft.replyWithDraft(staff(), { threadId: b.threadId, body: "Antwoord B", usedAiDraftMessageId: a.messageId });
    expect((await messageRow(a.messageId)).aiDraftStatus).toBe("ready");
  });

  it("discard drops a ready draft; discarding nothing is a conflict; a pending draft cannot be requested twice", async () => {
    const t = await emailThread({ bodies: ["Hebben jullie handdoeken?"] });
    await expect(draft.discardDraft(staff(), { messageId: t.messageId })).rejects.toMatchObject({ code: "conflict" });
    await draft.requestDraft(staff(), { messageId: t.messageId });
    await expect(draft.requestDraft(staff(), { messageId: t.messageId })).rejects.toMatchObject({ code: "conflict" });
    await draft.runDraftReply(makeJobCtx(h.db, "ai.draft_reply" as never), { messageId: t.messageId });
    await draft.discardDraft(staff(), { messageId: t.messageId });
    expect(await messageRow(t.messageId)).toMatchObject({ aiDraftStatus: "discarded", aiDraft: null });
    expect(await draft.getAiDraftState(h.db, t.threadId)).toMatchObject({ messageId: t.messageId, status: "discarded", draft: null });
  });

  it("only an inbound message can get a draft", async () => {
    const t = await emailThread({ bodies: ["Vraag", "out:Antwoord"] });
    const [out] = await h.db.select().from(inboxMessages).where(and(eq(inboxMessages.threadId, t.threadId), eq(inboxMessages.direction, "out")));
    await expect(draft.requestDraft(staff(), { messageId: out!.id })).rejects.toMatchObject({ code: "validation" });
  });
});

describe("ai.draft_reply runs twice", () => {
  it("the second run changes nothing and calls Claude once", async () => {
    const t = await emailThread({ bodies: ["Zijn jullie open op zondag?"] });
    await draft.requestDraft(staff(), { messageId: t.messageId });
    const integrations = createFakeIntegrations();
    let afterFirst: unknown;
    const snapshot = async () => (await h.db.select({ s: inboxMessages.aiDraftStatus, d: inboxMessages.aiDraft, r: inboxMessages.aiRequestId }).from(inboxMessages).where(eq(inboxMessages.id, t.messageId)))[0];
    const { first, second } = await runJobTwice(h.db, "ai.draft_reply" as never, { messageId: t.messageId }, { integrations, between: async () => void (afterFirst = await snapshot()) });
    expect(first).toMatchObject({ status: "ready" });
    expect(second).toMatchObject({ status: "skipped", current: "ready" });
    expect(await snapshot()).toEqual(afterFirst);
    expect(integrations.anthropic.calls).toHaveLength(1);
  });

  it("a dead job marks a pending draft failed", async () => {
    const t = await emailThread({ bodies: ["Hallo?"] });
    await draft.requestDraft(staff(), { messageId: t.messageId });
    await draft.onDraftReplyDead(makeJobCtx(h.db, "ai.draft_reply" as never), { messageId: t.messageId });
    expect((await messageRow(t.messageId)).aiDraftStatus).toBe("failed");
  });
});

describe("knowledge base", () => {
  const full = (s: string) => ({ "nl-BE": `${s} nl`, "fr-BE": `${s} fr`, en: `${s} en` });

  it("saves an article in every language, audits it, and lists it", async () => {
    const { articleId } = await draft.saveKnowledge(staff(), { key: "p10-what-to-bring", title: full("Meebrengen"), body: full("Handdoek en badslippers"), isActive: true });
    const rows = await listKnowledgeArticles(h.db);
    expect(rows.find((r) => r.id === articleId)).toMatchObject({ key: "p10-what-to-bring", isActive: true, updatedByName: expect.any(String) });
    await draft.saveKnowledge(staff(), { id: articleId, key: "p10-what-to-bring", title: full("Meebrengen"), body: full("Alleen een handdoek"), isActive: false });
    expect((await listKnowledgeArticles(h.db)).some((r) => r.id === articleId)).toBe(false);
    expect((await listKnowledgeArticles(h.db, { includeInactive: true })).find((r) => r.id === articleId)).toMatchObject({ isActive: false, body: full("Alleen een handdoek") });
    const audits = await h.db.select().from(auditLog).where(and(eq(auditLog.action, "knowledge.save"), eq(auditLog.entityId, articleId)));
    expect(audits).toHaveLength(2);
  });

  it("refuses a missing locale, a body over 5,000 characters and a taken key", async () => {
    await expect(draft.saveKnowledge(staff(), { key: "p10-partial", title: { en: "Only English" }, body: full("x"), isActive: true })).rejects.toMatchObject({ code: "validation", fields: { title: "missing_locales" } });
    await expect(draft.saveKnowledge(staff(), { key: "p10-long", title: full("t"), body: { ...full("x"), en: "y".repeat(5_001) }, isActive: true })).rejects.toMatchObject({ code: "validation", fields: { body: "too_long" } });
    await draft.saveKnowledge(staff(), { key: "p10-taken", title: full("t"), body: full("b"), isActive: true });
    await expect(draft.saveKnowledge(staff(), { key: "p10-taken", title: full("t"), body: full("b"), isActive: true })).rejects.toMatchObject({ code: "validation", fields: { key: "taken" } });
  });
});

describe("nav badges", () => {
  it("Inbox counts open unassigned threads; Tasks counts the user's own overdue tasks", async () => {
    const inbox = nav.find((n) => n.key === "crm.inbox") as { badge?: (i: { db: unknown; actor: unknown }) => Promise<number> };
    const tasksEntry = nav.find((n) => n.key === "crm.tasks") as { badge?: (i: { db: unknown; actor: unknown }) => Promise<number> };
    const [{ n }] = rowsOf<{ n: number }>(await h.db.execute(sql`select count(*)::int as n from inbox_threads where status = 'open' and assignee_user_id is null`)) as [{ n: number }];
    expect(await inbox.badge!({ db: h.db, actor: agent })).toBe(n);
    expect(n).toBeGreaterThan(0);
    expect(await tasksEntry.badge!({ db: h.db, actor: agent })).toBe(0);
    expect(await tasksEntry.badge!({ db: h.db, actor: { kind: "public" } })).toBe(0);
    expect(nav.find((e) => e.key === "crm.inbox_knowledge")).toMatchObject({ href: "/admin/inbox/knowledge", flag: "ff_crm_inbox" });
  });
});
