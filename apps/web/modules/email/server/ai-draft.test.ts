/**
 * email-P10 AI campaign drafts with the Claude fake (email spec sections 4 and 6, decision 47):
 * a draft becomes `ready` with a valid three-locale document; invalid model output ends `failed`
 * after the retry; a budget stop ends `failed` with `budget`; `fieldsSent` and the prompt carry no
 * person-level field, no person value and no `SENSITIVE_COLUMNS` member; accept creates a `draft`
 * campaign and a draft version with `ai_draft_id`, never scheduled; discard; the actions require
 * `email.write` and, for request and accept, `ai.use`. Also the job run twice and the seed's
 * `email_brand` defaults.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson, makeSession, makeUser } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { aiRequests, auditLog, campaigns, emailAiDrafts, emailTemplateVersions, jobs, roles, SENSITIVE_COLUMNS, settings } from "@beam/db/schema";
import { AI_ALLOWED_FIELDS, DEFAULT_AI_PRICING } from "@beam/core/ai";
import { isSensitiveKey } from "@beam/core/privacy";
import type { ClaudeRequest } from "@beam/integrations/anthropic";

process.env.SENSITIVE_DATA_KEY_V1 ??= randomBytes(32).toString("base64");
const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.56" })),
}));
vi.mock("next/server", () => ({ after: () => undefined }));

const draftApi = await import("./ai-draft");
const { buildDraftPrompt, AiCampaignDraftSchema, draftDocumentIssues } = await import("../../../../../packages/core/src/email/ai");
const actions = await import("../actions");
const { listAiDrafts } = await import("../queries");
const { EMAIL_BRAND_DEFAULTS, insertEmailBrandDefaults } = await import("@beam/db/seed/email");
const { createAuthSession, SESSION_COOKIE } = await import("@/lib/auth");
const { and, eq, setAppDb } = await import("@/lib/ctx");
const { createFakeIntegrations, makeCtx, makeJobCtx, resetRuntime, runJobTwice, staffActor } = await import("@/lib/testing");
const { bulkPersons, staticSegment } = await import("../email-p6.fixtures");

let h: DbHandle;
let userId: string;
let sessionId: string;
let segmentId: string;

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

const id10 = (n: number) => `blk${String(n).padStart(7, "0")}`;
const doc = (session?: string) => {
  const blocks = (loc: string, n: number) => [
    { id: id10(n), type: "heading", level: 1, text: `Titel ${loc}` },
    { id: id10(n + 1), type: "text", markdown: `Tekst ${loc}` },
    ...(session ? [{ id: id10(n + 2), type: "event", sessionId: session, ctaLabel: `Boek ${loc}` }] : []),
  ];
  return { schemaVersion: 1, locales: { "nl-BE": blocks("nl", 10), "fr-BE": blocks("fr", 20), en: blocks("en", 30) } };
};
const validDraft = (session?: string, segment: string | null = null) => ({
  subject: { "nl-BE": "Nieuw dit najaar", "fr-BE": "Nouveau cet automne", en: "New this autumn" },
  preheader: { "nl-BE": "Ontdek het aanbod", "fr-BE": "Découvrez l'offre", en: "Discover the offer" },
  document: doc(session),
  segment: { segmentId: segment, description: "Active members who visited recently" },
  suggestedSendAt: "2026-11-10T09:30:00+01:00",
  timingRationale: "Tuesday morning, a week before the event.",
  notes: "Check the event date.",
});

beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
  userId = (await makeUser(h.db, { roleKey: "marketing", email: "p10-marketing@demo.beam.be" })).id;
  const s = await makeSession(h.db, { kind: "event", publishedAt: new Date(Date.now() - 86_400_000), startsAt: new Date(Date.now() + 7 * 86_400_000), location: "BEAM Gent" });
  sessionId = s.id;
  const ids = await bulkPersons(h.db, 4, { tag: "p10", locale: "fr-BE" });
  segmentId = await staticSegment(h.db, "P10 Members", ids);
  await makePerson(h.db, { email: "p10-unique-person@example.com", firstName: "Zeldzaam", lastName: "Achternaamtest" });
});
beforeEach(async () => {
  await putSetting("ai", AI_DEFAULT);
  jar.clear();
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

const marketer = (perms: string[] = ["email.write", "ai.use"]) => makeCtx(h.db, { actor: staffActor({ userId, roleKey: "marketing", permissions: perms }) });
const draftRow = async (id: string) => (await h.db.select().from(emailAiDrafts).where(eq(emailAiDrafts.id, id)))[0]!;
const promptOf = (r: ClaudeRequest) => `${r.system}\n${r.messages.map((m) => m.content).join("\n")}`;

async function requestAndRun(opts: { script?: unknown; attempt?: number; sessionIds?: string[]; segmentId?: string | null } = {}) {
  const integrations = createFakeIntegrations();
  if (opts.script !== undefined) integrations.anthropic.script("ai.draft_email", opts.script as Record<string, unknown>);
  const { draftId } = await draftApi.requestAiDraftRecord(marketer(), {
    brief: "Autumn newsletter announcing the new strength classes for members.",
    purpose: "newsletter",
    sessionIds: opts.sessionIds ?? [sessionId],
    segmentId: opts.segmentId === undefined ? segmentId : opts.segmentId,
  });
  const ctx = makeJobCtx(h.db, "ai.draft_email", { integrations, attempt: opts.attempt ?? 1 });
  const run = draftApi.runDraftEmail(ctx, { draftId });
  return { draftId, integrations, run };
}

describe("buildDraftPrompt and the output schema", () => {
  it("lists only non-personal context keys in fieldsSent", () => {
    const p = buildDraftPrompt({
      brand: { tone_of_voice: "Warm", guidelines: "Short", do_not_say: ["miracle"], sample_phrases: [{ "nl-BE": "Hallo", "fr-BE": "Bonjour", en: "Hello" }] },
      previousCampaigns: [{ name: "Spring", subject: "Lente", preheader: "Nieuw", text: "Tekst", sentAt: new Date("2026-04-01T08:00:00Z"), openRate: 0.42, clickRate: 0.05 }],
      sessions: [{ sessionId, title: { "nl-BE": "Lezing" }, startsAt: new Date("2026-11-20T18:00:00Z"), endsAt: new Date("2026-11-20T20:00:00Z"), location: null, isMemberOnly: false, isLeadMagnet: false, availabilityBand: "available" }],
      segments: {
        list: [{ id: segmentId, name: "Members", description: null, count: 4 }],
        chosen: { id: segmentId, name: "Members", total: 4, byStatus: { lead: 4, customer: 0, member: 0 }, byLocale: { "nl-BE": 0, "fr-BE": 4, en: 0 }, medianDaysSinceLastVisit: null },
      },
      purpose: "newsletter",
      brief: "A brief of at least ten characters.",
    });
    expect(p.fieldsSent).toEqual(expect.arrayContaining(["brand.tone_of_voice", "previous_campaigns[].open_rate_pct", "sessions[].title.nl-BE", "chosen_segment.count_by_commercial_status.member", "purpose", "locales[]", "brief"]));
    const personFields = new Set<string>([...AI_ALLOWED_FIELDS, "email", "email_hash", "phone", "phone_e164", "first_name", "last_name", "person_id", "birth_date", "address"]);
    const sensitiveColumns = new Set(SENSITIVE_COLUMNS.map((c) => c.column));
    for (const key of p.fieldsSent) {
      const last = key.split(".").pop()!.replace(/\[\]$/, "");
      expect(personFields.has(last), key).toBe(false);
      expect(sensitiveColumns.has(last), key).toBe(false);
      expect(isSensitiveKey(key), key).toBe(false);
    }
    expect(p.system).toContain("nl-BE");
    expect(p.user).toContain("A brief of at least ten characters.");
  });

  it("requires all three locales and allows only the AI block types", () => {
    expect(AiCampaignDraftSchema.safeParse(validDraft()).success).toBe(true);
    const missing = validDraft();
    delete (missing.subject as Record<string, string>).en;
    expect(AiCampaignDraftSchema.safeParse(missing).success).toBe(false);
    const noFr = validDraft();
    (noFr.document.locales as Record<string, unknown[]>)["fr-BE"] = [];
    expect(AiCampaignDraftSchema.safeParse(noFr).success).toBe(false);
    const parsed = AiCampaignDraftSchema.parse(validDraft("00000000-0000-4000-8000-000000000001"));
    expect(draftDocumentIssues(parsed.document, [sessionId])).toHaveLength(3);
    expect(draftDocumentIssues(AiCampaignDraftSchema.parse(validDraft(sessionId)).document, [sessionId])).toEqual([]);
  });
});

describe("ai.draft_email", () => {
  it("stores a ready draft with a valid three-locale document and links the ai_requests row", async () => {
    const { draftId, integrations, run } = await requestAndRun({ script: validDraft(sessionId, segmentId) });
    await expect(run).resolves.toMatchObject({ status: "ready" });
    const row = await draftRow(draftId);
    expect(row.status).toBe("ready");
    expect(AiCampaignDraftSchema.safeParse(row.output).success).toBe(true);
    expect(row.aiRequestId).toBeTruthy();
    const [req] = await h.db.select().from(aiRequests).where(eq(aiRequests.id, row.aiRequestId!));
    expect(req).toMatchObject({ feature: "ai.draft_email", model: "claude-opus-5-5", status: "ok", personId: null });
    expect(req!.fieldsSent).toEqual([]);

    const call = integrations.anthropic.calls.at(-1)!.input;
    const prompt = promptOf(call);
    expect(prompt).toContain("P10 Members");
    expect(prompt).toContain("Session test"); // the event's French title from the session card
    expect(prompt).toContain('"fr-BE": 4'); // segment counts per language, no member rows
    for (const leak of ["p10-unique-person@example.com", "Zeldzaam", "Achternaamtest", "@example.com", "First0"]) expect(prompt).not.toContain(leak);
    const [job] = await h.db.select().from(jobs).where(eq(jobs.idempotencyKey, `ai:draft:${draftId}`));
    expect(job).toMatchObject({ kind: "ai.draft_email", lane: "fast", priority: 5, maxAttempts: 2 });
  });

  it("invalid model output retries once, then ends failed with invalid_output", async () => {
    const bad = { subject: { en: "Only English" }, notes: "x" };
    const first = await requestAndRun({ script: bad, attempt: 1 });
    await expect(first.run).rejects.toThrow(/invalid_output/);
    expect((await draftRow(first.draftId)).status).toBe("queued");
    const last = await requestAndRun({ script: bad, attempt: 2 });
    await expect(last.run).resolves.toEqual({ status: "failed", error: "invalid_output" });
    expect(await draftRow(last.draftId)).toMatchObject({ status: "failed", error: "invalid_output", output: null });
  });

  it("an event block of a session that was not chosen is invalid output", async () => {
    const other = await makeSession(h.db, { kind: "event", publishedAt: new Date(Date.now() - 86_400_000) });
    const r = await requestAndRun({ script: validDraft(other.id), attempt: 2 });
    await expect(r.run).resolves.toEqual({ status: "failed", error: "invalid_output" });
  });

  it("a budget stop ends failed with budget and calls nobody", async () => {
    await putSetting("ai", { ...AI_DEFAULT, monthly_budget_cents: 0 });
    const r = await requestAndRun({ script: validDraft(sessionId) });
    await expect(r.run).resolves.toEqual({ status: "failed", error: "budget" });
    expect(await draftRow(r.draftId)).toMatchObject({ status: "failed", error: "budget" });
    expect(r.integrations.anthropic.calls).toHaveLength(0);
  });

  it("a provider outage on the last attempt ends failed; earlier attempts retry", async () => {
    const integrations = createFakeIntegrations();
    integrations.anthropic.failNext("overloaded");
    const { draftId } = await draftApi.requestAiDraftRecord(marketer(), { brief: "Another brief for the outage case.", purpose: "newsletter", sessionIds: [] });
    await expect(draftApi.runDraftEmail(makeJobCtx(h.db, "ai.draft_email", { integrations, attempt: 1 }), { draftId })).rejects.toThrow();
    integrations.anthropic.failNext("overloaded");
    await expect(draftApi.runDraftEmail(makeJobCtx(h.db, "ai.draft_email", { integrations, attempt: 2 }), { draftId })).resolves.toEqual({ status: "failed", error: "ai_unavailable" });
  });

  it("runs twice with the same result (second run skips)", async () => {
    const { draftId } = await draftApi.requestAiDraftRecord(marketer(), { brief: "Twice-run brief for the job test.", purpose: "newsletter", sessionIds: [sessionId] });
    const integrations = createFakeIntegrations();
    integrations.anthropic.script("ai.draft_email", validDraft(sessionId));
    const { first, second } = await runJobTwice(h.db, "ai.draft_email", { draftId }, { integrations });
    expect(first).toMatchObject({ status: "ready" });
    expect(second).toEqual({ status: "skipped", current: "ready" });
    const row = await draftRow(draftId);
    expect(row.status).toBe("ready");
    // The ai_requests row is written after the job's transaction; the draft still links it.
    expect(row.aiRequestId).toBeTruthy();
    expect(integrations.anthropic.calls).toHaveLength(1);
  });
});

describe("accept and discard", () => {
  async function readyDraft(segment: string | null = segmentId) {
    const r = await requestAndRun({ script: validDraft(sessionId, segment) });
    await r.run;
    return r.draftId;
  }

  it("accept creates a draft campaign and a draft version with ai_draft_id, never scheduled", async () => {
    const draftId = await readyDraft();
    const { campaignId } = await draftApi.acceptAiDraftRecord(marketer(), { draftId, campaignName: "Autumn AI campaign" });
    const [c] = await h.db.select().from(campaigns).where(eq(campaigns.id, campaignId));
    expect(c).toMatchObject({ status: "draft", scheduledAt: null, aiDraftId: draftId, segmentId, purpose: "newsletter", name: "Autumn AI campaign" });
    const versions = await h.db.select().from(emailTemplateVersions).where(eq(emailTemplateVersions.templateId, c!.templateId));
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ publishedAt: null, aiDraftId: draftId });
    expect(versions[0]!.subject).toEqual(validDraft().subject);
    expect(Object.keys(versions[0]!.document!.locales).sort()).toEqual(["en", "fr-BE", "nl-BE"]);
    expect(await draftRow(draftId)).toMatchObject({ status: "accepted", campaignId, decidedByUserId: userId });
    const audits = await h.db.select().from(auditLog).where(and(eq(auditLog.entityId, draftId), eq(auditLog.action, "email.ai_draft_accept")));
    expect(audits).toHaveLength(1);
    // No planning job: scheduling stays a human action.
    const plan = await h.db.select().from(jobs).where(eq(jobs.kind, "campaign.plan"));
    expect(plan.filter((j) => (j.payload as { campaignId?: string }).campaignId === campaignId)).toEqual([]);
    // Accepting twice is refused.
    await expect(draftApi.acceptAiDraftRecord(marketer(), { draftId, campaignName: "Again" })).rejects.toThrow(/ai_draft_not_ready/);
  });

  it("accept ignores a suggested segment that does not exist", async () => {
    const draftId = await readyDraft(null);
    await h.db.update(emailAiDrafts).set({ output: { ...validDraft(sessionId, "00000000-0000-4000-8000-0000000000aa") } }).where(eq(emailAiDrafts.id, draftId));
    await h.db.update(emailAiDrafts).set({ inputs: { sessionIds: [sessionId], segmentId: null, purpose: "newsletter", locales: ["nl-BE", "fr-BE", "en"] } }).where(eq(emailAiDrafts.id, draftId));
    const { campaignId } = await draftApi.acceptAiDraftRecord(marketer(), { draftId, campaignName: "No segment" });
    const [c] = await h.db.select().from(campaigns).where(eq(campaigns.id, campaignId));
    expect(c!.segmentId).toBeNull();
  });

  it("discard marks the draft discarded; an accepted draft cannot be discarded", async () => {
    const draftId = await readyDraft();
    await expect(draftApi.discardAiDraftRecord(marketer(["email.write"]), { draftId })).resolves.toEqual({ ok: true });
    expect(await draftRow(draftId)).toMatchObject({ status: "discarded", decidedByUserId: userId });
    await expect(draftApi.acceptAiDraftRecord(marketer(), { draftId, campaignName: "Late" })).rejects.toThrow(/ai_draft_not_ready/);
    const accepted = await readyDraft();
    await draftApi.acceptAiDraftRecord(marketer(), { draftId: accepted, campaignName: "Kept" });
    await expect(draftApi.discardAiDraftRecord(marketer(), { draftId: accepted })).rejects.toThrow(/ai_draft_accepted/);
  });

  it("listAiDrafts returns the user's newest drafts with their parsed output", async () => {
    const rows = await listAiDrafts(h.db, { createdByUserId: userId, limit: 50 });
    expect(rows.length).toBeGreaterThan(0);
    for (let i = 1; i < rows.length; i++) expect(rows[i - 1]!.createdAt.getTime()).toBeGreaterThanOrEqual(rows[i]!.createdAt.getTime());
    expect(rows.find((r) => r.status === "ready")?.output?.subject.en).toBe("New this autumn");
    expect(rows.filter((r) => r.status === "failed").every((r) => r.output === null)).toBe(true);
  });
});

describe("permissions (email spec section 7)", () => {
  async function asStaff(perms: string[]) {
    const user = await makeUser(h.db, { roleKey: "sales" });
    await h.db.update(roles).set({ permissions: perms }).where(eq(roles.key, "sales"));
    const { token } = await createAuthSession(h.db, { userId: user.id, audience: "staff", roleKey: "sales", now: new Date(), mfaAt: new Date() });
    jar.set(SESSION_COOKIE, token);
    return user;
  }
  const brief = { brief: "Permission test brief text.", purpose: "newsletter" as const, sessionIds: [] };

  it("requestAiDraft needs email.write and ai.use", async () => {
    await asStaff(["ai.use"]);
    expect(await actions.requestAiDraft(brief)).toMatchObject({ ok: false, error: { code: "forbidden" } });
    await asStaff(["email.write"]);
    expect(await actions.requestAiDraft(brief)).toMatchObject({ ok: false, error: { code: "forbidden" } });
    await asStaff(["email.write", "ai.use"]);
    const ok = await actions.requestAiDraft(brief);
    expect(ok.ok).toBe(true);
  });

  it("acceptAiDraft needs ai.use too; discardAiDraft needs email.write", async () => {
    const r = await requestAndRun({ script: validDraft(sessionId) });
    await r.run;
    await asStaff(["email.write"]);
    expect(await actions.acceptAiDraft({ draftId: r.draftId, campaignName: "x" })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    await asStaff(["ai.use"]);
    expect(await actions.discardAiDraft({ draftId: r.draftId })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect((await draftRow(r.draftId)).status).toBe("ready");
    await asStaff(["email.write", "ai.use"]);
    expect(await actions.acceptAiDraft({ draftId: r.draftId, campaignName: "Via action" })).toMatchObject({ ok: true });
  });
});

describe("email_brand seed", () => {
  it("writes the defaults once and keeps a staff edit", async () => {
    await h.db.delete(settings).where(eq(settings.key, "email_brand"));
    await insertEmailBrandDefaults(h.db);
    const [row] = await h.db.select().from(settings).where(eq(settings.key, "email_brand"));
    expect((row!.value as { tone_of_voice: string }).tone_of_voice).toBe(EMAIL_BRAND_DEFAULTS.tone_of_voice);
    await h.db.update(settings).set({ value: { ...EMAIL_BRAND_DEFAULTS, tone_of_voice: "Edited" } }).where(eq(settings.key, "email_brand"));
    await insertEmailBrandDefaults(h.db);
    const [again] = await h.db.select().from(settings).where(eq(settings.key, "email_brand"));
    expect((again!.value as { tone_of_voice: string }).tone_of_voice).toBe("Edited");
  });
});
