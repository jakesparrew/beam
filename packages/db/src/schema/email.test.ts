import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMAIL_TOKENS } from "@beam/core/email";
import type { DbHandle } from "../client";
import { createTestDb, makePerson, makeUser } from "../testing";
import { APPEND_ONLY_TABLES, IMMUTABLE_TABLES, SENSITIVE_COLUMNS } from "./_shared";
import {
  campaignRecipients,
  campaigns,
  EMAIL_APPEND_ONLY_TABLES,
  emailAiDrafts,
  emailEvents,
  emailMessages,
  emailTemplates,
  emailTemplateVersions,
} from "./email";

/** The Postgres error behind a failed Drizzle query (message and SQLSTATE). */
async function pgError(promise: Promise<unknown>): Promise<{ message: string; code?: string }> {
  try {
    await promise;
  } catch (error) {
    const cause = (error as { cause?: { message?: string; code?: string } }).cause ?? (error as { message?: string; code?: string });
    return { message: String(cause.message ?? error), code: cause.code };
  }
  throw new Error("expected the query to fail");
}

let h: DbHandle;
let userId: string;
beforeAll(async () => {
  h = await createTestDb();
  userId = (await makeUser(h.db)).id;
});
afterAll(() => h.close());

let seq = 0;
const doc = { schemaVersion: 1 as const, locales: { en: [{ id: "hdg0000001", type: "heading" as const, level: 1 as const, text: "Hi" }] } };

async function marketingTemplate(purpose: "newsletter" | "events" = "newsletter") {
  const [t] = await h.db
    .insert(emailTemplates)
    .values({ slug: `campaign-${++seq}-test`, name: "Test", kind: "marketing", purpose })
    .returning();
  return t!;
}

async function version(templateId: string, n: number, publishedAt: Date | null = null) {
  const [v] = await h.db.insert(emailTemplateVersions).values({ templateId, version: n, document: doc, publishedAt }).returning();
  return v!;
}

async function campaign(overrides: Partial<typeof campaigns.$inferInsert> = {}) {
  const template = await marketingTemplate();
  const [c] = await h.db
    .insert(campaigns)
    .values({ name: "Autumn", templateId: template.id, purpose: "newsletter", createdByUserId: userId, ...overrides })
    .returning();
  return c!;
}

async function message(overrides: Partial<typeof emailMessages.$inferInsert>) {
  const [m] = await h.db
    .insert(emailMessages)
    .values({ kind: "transactional", locale: "en", idempotencyKey: `test:${randomUUID()}`, ...overrides })
    .returning();
  return m!;
}

describe("email schema", () => {
  it("is built by createTestDb with every email table", async () => {
    const rows = await h.db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema = 'public' and (table_name like 'email_%' or table_name like 'campaign%') order by table_name`,
    );
    expect((rows as { rows: { table_name: string }[] }).rows.map((r) => r.table_name)).toEqual([
      "campaign_recipients",
      "campaigns",
      "email_ai_drafts",
      "email_events",
      "email_messages",
      "email_template_versions",
      "email_templates",
    ]);
  });

  it("declares email_events append-only and versions immutable", async () => {
    expect(EMAIL_APPEND_ONLY_TABLES.every((t) => (APPEND_ONLY_TABLES as readonly string[]).includes(t))).toBe(true);
    expect(IMMUTABLE_TABLES).toContain("email_template_versions");
    const t = await marketingTemplate();
    const v = await version(t.id, 1);
    const m = await message({ kind: "test", purpose: "newsletter", templateVersionId: v.id });
    const [e] = await h.db.insert(emailEvents).values({ emailMessageId: m.id, type: "delivered", source: "resend", resendEventId: `msg_${randomUUID()}`, occurredAt: new Date() }).returning();
    expect((await pgError(h.db.update(emailEvents).set({ url: "https://beam.be" }).where(eq(emailEvents.id, e!.id)))).message).toMatch(/append-only|not allowed|reject/i);
  });

  it("keeps EMAIL_TOKENS free of sensitive columns", () => {
    for (const c of SENSITIVE_COLUMNS) {
      expect(EMAIL_TOKENS as readonly string[]).not.toContain(c.column);
      expect(EMAIL_TOKENS as readonly string[]).not.toContain(`${c.table}.${c.column}`);
    }
  });
});

describe("email_templates", () => {
  it("accepts the transactional and marketing slug forms and refuses the others", async () => {
    const ok = [
      { slug: "booking.booking_confirmed", kind: "transactional" as const, purpose: null },
      { slug: "automation.event_reminder_7d", kind: "transactional" as const, purpose: null },
      { slug: "autumn-newsletter-2026", kind: "marketing" as const, purpose: "newsletter" as const },
    ];
    for (const values of ok) await h.db.insert(emailTemplates).values({ name: "T", ...values });
    const bad = [
      { slug: "booking/booking-confirmed", kind: "transactional" as const, purpose: null },
      { slug: "Booking.Confirmed", kind: "transactional" as const, purpose: null },
      { slug: "booking.booking_confirmed2", kind: "marketing" as const, purpose: "events" as const },
      { slug: "ab", kind: "marketing" as const, purpose: "events" as const },
    ];
    for (const values of bad) expect((await pgError(h.db.insert(emailTemplates).values({ name: "T", ...values }))).message).toContain("email_templates_slug_ck");
  });

  it("requires a purpose exactly for marketing templates", async () => {
    expect((await pgError(h.db.insert(emailTemplates).values({ name: "T", slug: "no-purpose", kind: "marketing" }))).message).toContain("email_templates_purpose_ck");
    expect((await pgError(h.db.insert(emailTemplates).values({ name: "T", slug: "crm.with_purpose", kind: "transactional", purpose: "b2b" }))).message).toContain(
      "email_templates_purpose_ck",
    );
  });

  it("points current_version_id at a version row", async () => {
    const t = await marketingTemplate();
    expect((await pgError(h.db.update(emailTemplates).set({ currentVersionId: randomUUID() }).where(eq(emailTemplates.id, t.id)))).code).toBe("23503");
    const v = await version(t.id, 1, new Date());
    await h.db.update(emailTemplates).set({ currentVersionId: v.id, status: "published" }).where(eq(emailTemplates.id, t.id));
  });
});

describe("email_template_versions", () => {
  it("refuses a second draft per template and allows many published versions", async () => {
    const t = await marketingTemplate();
    await version(t.id, 1, new Date("2026-11-01T10:00:00Z"));
    await version(t.id, 2, new Date("2026-11-02T10:00:00Z"));
    await version(t.id, 3);
    expect((await pgError(version(t.id, 4))).message).toContain("email_template_versions_one_draft_uq");
    expect((await pgError(version(t.id, 2, new Date()))).message).toContain("email_template_versions_template_version_uq");
  });

  it("requires exactly one body source", async () => {
    const t = await marketingTemplate();
    const base = { templateId: t.id, publishedAt: new Date() };
    await h.db.insert(emailTemplateVersions).values({ ...base, version: 1, document: doc });
    await h.db.insert(emailTemplateVersions).values({ ...base, version: 2, reactComponent: "booking.booking_confirmed", copy: { intro: { en: "Hi" } } });
    const both = h.db.insert(emailTemplateVersions).values({ ...base, version: 3, document: doc, reactComponent: "booking.booking_confirmed", copy: {} });
    expect((await pgError(both)).message).toContain("email_template_versions_body_ck");
    expect((await pgError(h.db.insert(emailTemplateVersions).values({ ...base, version: 4 }))).message).toContain("email_template_versions_body_ck");
    const noCopy = h.db.insert(emailTemplateVersions).values({ ...base, version: 5, reactComponent: "booking.booking_confirmed" });
    expect((await pgError(noCopy)).message).toContain("email_template_versions_copy_ck");
  });

  it("checks version > 0 and the locale list", async () => {
    const t = await marketingTemplate();
    expect((await pgError(version(t.id, 0))).message).toContain("email_template_versions_version_ck");
    const de = h.db.insert(emailTemplateVersions).values({ templateId: t.id, version: 1, document: doc, locales: ["en", "de"] });
    expect((await pgError(de)).message).toContain("email_template_versions_locales_ck");
    const ok = await h.db.insert(emailTemplateVersions).values({ templateId: t.id, version: 1, document: doc, locales: ["nl-BE", "fr-BE", "en"] }).returning();
    expect(ok[0]!.locales).toEqual(["nl-BE", "fr-BE", "en"]);
  });
});

describe("campaigns and recipients", () => {
  it("ties paused_reason to the paused status", async () => {
    await campaign({ status: "paused", pausedReason: "bounce_rate" });
    expect((await pgError(campaign({ status: "paused" }))).message).toContain("campaigns_paused_reason_ck");
    expect((await pgError(campaign({ status: "sending", pausedReason: "manual" }))).message).toContain("campaigns_paused_reason_ck");
  });

  it("checks the name length and defaults", async () => {
    expect((await pgError(campaign({ name: "" }))).message).toContain("campaigns_name_ck");
    expect((await pgError(campaign({ name: "x".repeat(161) }))).message).toContain("campaigns_name_ck");
    const c = await campaign();
    expect(c).toMatchObject({ status: "draft", version: 1, runNo: 1, recipientsCount: 0, excludeSegmentIds: [] });
  });

  it("refuses a duplicate (campaign_id, person_id) and checks locale and removal", async () => {
    const c = await campaign();
    const p = await makePerson(h.db);
    await h.db.insert(campaignRecipients).values({ campaignId: c.id, personId: p.id, locale: "nl-BE", chunkNo: 0 });
    const dup = h.db.insert(campaignRecipients).values({ campaignId: c.id, personId: p.id, locale: "nl-BE", chunkNo: 1 });
    expect((await pgError(dup)).message).toContain("campaign_recipients_campaign_person_uq");
    const p2 = await makePerson(h.db);
    expect((await pgError(h.db.insert(campaignRecipients).values({ campaignId: c.id, personId: p2.id, locale: "de", chunkNo: 0 }))).message).toContain(
      "campaign_recipients_locale_ck",
    );
    expect((await pgError(h.db.insert(campaignRecipients).values({ campaignId: c.id, personId: p2.id, locale: "en", chunkNo: 0, status: "removed" }))).message).toContain(
      "campaign_recipients_removed_ck",
    );
    await h.db.insert(campaignRecipients).values({ campaignId: c.id, personId: p2.id, locale: "en", chunkNo: 0, status: "removed", removedByUserId: userId, removedAt: new Date() });
  });

  it("deletes recipients with their campaign", async () => {
    const c = await campaign();
    await h.db.insert(campaignRecipients).values({ campaignId: c.id, personId: (await makePerson(h.db)).id, locale: "en", chunkNo: 0 });
    await h.db.delete(campaigns).where(eq(campaigns.id, c.id));
    expect(await h.db.select().from(campaignRecipients).where(eq(campaignRecipients.campaignId, c.id))).toHaveLength(0);
  });
});

describe("email_messages", () => {
  it("refuses a campaign message without purpose and accepts an automation message with null purpose", async () => {
    const t = await marketingTemplate();
    const v = await version(t.id, 1, new Date());
    const c = await campaign();
    const person = await makePerson(h.db);
    const noPurpose = message({ kind: "campaign", personId: person.id, templateVersionId: v.id, campaignId: c.id, fromDomain: "news.beam.be" });
    expect((await pgError(noPurpose)).message).toContain("email_messages_campaign_purpose_ck");
    const m = await message({ kind: "automation", personId: person.id, templateVersionId: v.id, enrolmentId: randomUUID(), purpose: null });
    expect(m).toMatchObject({ purpose: null, fromDomain: "mail.beam.be", attempt: 1, status: "queued", attachments: [] });
  });

  it("allows a transactional message without template version (Wave 0) and requires one for other kinds", async () => {
    await message({ kind: "transactional", toEmail: "a@example.com" });
    expect((await pgError(message({ kind: "test", purpose: "events" }))).message).toContain("email_messages_template_version_ck");
  });

  it("enforces unique keys and the attempt and send_at checks", async () => {
    const key = `booking:${randomUUID()}`;
    await message({ idempotencyKey: key, resendId: "re_dup", linkTokenHash: "a".repeat(64) });
    expect((await pgError(message({ idempotencyKey: key }))).message).toContain("email_messages_idempotency_key_unique");
    expect((await pgError(message({ resendId: "re_dup" }))).message).toContain("email_messages_resend_id_unique");
    expect((await pgError(message({ linkTokenHash: "a".repeat(64) }))).message).toContain("email_messages_link_token_hash_unique");
    expect((await pgError(message({ attempt: 3 }))).message).toContain("email_messages_attempt_ck");
    expect((await pgError(message({ sendAt: new Date(Date.now() + 401 * 86_400_000) }))).message).toContain("email_messages_send_at_ck");
    const original = await message({});
    await message({ attempt: 2, retryOfMessageId: original.id, sendAt: new Date(Date.now() + 3_600_000) });
  });

  it("links a recipient to at most one message and an AI draft to a campaign", async () => {
    const c = await campaign();
    const m = await message({});
    await h.db.insert(campaignRecipients).values({ campaignId: c.id, personId: (await makePerson(h.db)).id, locale: "en", chunkNo: 0, status: "sent", emailMessageId: m.id });
    const again = h.db.insert(campaignRecipients).values({ campaignId: c.id, personId: (await makePerson(h.db)).id, locale: "en", chunkNo: 0, status: "sent", emailMessageId: m.id });
    expect((await pgError(again)).message).toContain("campaign_recipients_email_message_id_unique");
    const inputs = { sessionIds: [], segmentId: null, purpose: "events" as const, locales: ["nl-BE", "fr-BE", "en"] };
    expect((await pgError(h.db.insert(emailAiDrafts).values({ brief: "too short", inputs, createdByUserId: userId }))).message).toContain("email_ai_drafts_brief_ck");
    const [draft] = await h.db.insert(emailAiDrafts).values({ campaignId: c.id, brief: "An autumn newsletter about the new sauna", inputs, createdByUserId: userId }).returning();
    expect(draft).toMatchObject({ status: "queued", campaignId: c.id });
  });
});
