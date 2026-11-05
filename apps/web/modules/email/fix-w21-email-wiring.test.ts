/**
 * fix-w21-email-wiring: the email requests of docs/build/requests.md served by the wiring fixer.
 *
 * - SI-1 (platform-P12): a stored document that fails validation ends the message `failed` with
 *   `invalid_document` (written durably) and the job dies with the `PermanentError`.
 * - email-P8: `resolveCardsFor` copies booking's `opensForCustomersAt`; `webinarCardsFor` binds
 *   `webinar.getWebinarCards`, so previews (and publish) render webinar cards.
 * - email-P8: documents with a lead-window event block are compiled again at send time with
 *   today's cards (`email.send` and `campaign.send_chunk`), instead of the html frozen at publish.
 * - email-P5: `kind = test` messages render for the persona `sendTestEmail` stored (sample or
 *   real contact: status variant and tokens) with the template's marketing footer (rule 60).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makeSession, makeUser } from "@beam/db/testing";
import type { DbHandle, Tx } from "@beam/db";
import { campaigns, emailTemplateVersions, sessions, settings } from "@beam/db/schema";
import type { Block, BlockDocument } from "@beam/core/email";
import { PermanentError } from "@beam/core/errors";
import { LOCALES, type Locale } from "@beam/core/i18n";
import { eq } from "@/lib/ctx";
import { createFakeIntegrations, makeCtx, makeJobCtx, resetRuntime, staffActor, type FakeIntegrations } from "@/lib/testing";
import { makeWebinar } from "@/modules/webinar/test/factories";
import { seedTemplate, sendTransactional } from "./api";
import { completeCompany, messageOf, personWith, resetEmailTables } from "./email-p3.fixtures";
import { campaignOf, grant, staff, staticSegment } from "./email-p6.fixtures";
import { sendEmailMessage } from "./jobs";
import { createCampaignRecord, scheduleCampaignRecord, updateCampaignRecord } from "./server/campaigns";
import { dispatchDueCampaigns, planCampaign } from "./server/plan";
import { buildPreview, resolveCardsFor, samplePersona, webinarCardsFor } from "./server/preview";
import { sendChunk } from "./server/send-chunk";
import { sendTestEmailRecord } from "./server/templates";

let h: DbHandle;
let fakes: FakeIntegrations;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const CTA = "Book your seat";
const OPENS = "Opens for you on";
const each = (text: string) => Object.fromEntries(LOCALES.map((l) => [l, `${text} ${l}`]));
let n = 0;
const uniq = () => `${++n}${Date.now().toString(36)}`;

beforeAll(async () => {
  h = await createTestDb();
  await completeCompany(h.db);
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
  await resetEmailTables(h.db);
  fakes = createFakeIntegrations();
  vi.stubEnv("APP_ENV", "local");
  vi.stubEnv("EMAIL_SINK", "");
  vi.stubEnv("INTEGRATIONS", "fake");
  vi.stubEnv("APP_URL", "https://beam.be");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const run = (emailMessageId: string, template: string) => sendEmailMessage(makeJobCtx(h.db, "email.send", { integrations: fakes }), { emailMessageId, template });
const sentTo = (to: string) => fakes.resend.sent.filter((m) => m.to === to || (Array.isArray(m.to) && m.to.includes(to)));

/** `sendTestEmail` to a fresh staff address, then `email.send` of each message. */
async function sendTest(templateId: string, slug: string, as: Parameters<typeof sendTestEmailRecord>[1]["as"], permissions = ["email.write"], locale: Locale = "en") {
  const user = await makeUser(h.db, { roleKey: "marketing", email: `fixw21-${uniq()}@demo.beam.be` });
  const ctx = makeCtx(h.db, staffActor({ userId: user.id, permissions }));
  const { messageIds } = await sendTestEmailRecord(ctx, { templateId, use: "current", locales: [locale], to: [user.email], as });
  for (const id of messageIds) await run(id, slug);
  return { to: user.email, messageIds };
}

/** A Lead Magnet event with every seat reserved for leads: customers wait for the window end. */
async function leadMagnet() {
  return makeSession(h.db, {
    kind: "event",
    creditKind: null,
    creditCost: 0,
    capacitySeats: 2,
    startsAt: new Date(Date.now() + 5 * DAY),
    isLeadMagnet: true,
    leadReservedSeats: 2,
    leadWindowStartAt: new Date(Date.now() - 2 * DAY),
    leadWindowEndAt: new Date(Date.now() + DAY),
  });
}
const release = (sessionId: string) =>
  h.db.update(sessions).set({ leadWindowStartAt: new Date(Date.now() - 3 * DAY), leadWindowEndAt: new Date(Date.now() - HOUR) }).where(eq(sessions.id, sessionId));

const eventDoc = (sessionId: string, showLeadWindow: boolean): BlockDocument => ({
  schemaVersion: 1,
  locales: Object.fromEntries(
    LOCALES.map((l) => [
      l,
      [
        { id: "tx00000001", type: "text", markdown: `Join us, {{first_name|friend}} (${l}).` },
        { id: "ev00000001", type: "event", sessionId, ctaLabel: CTA, ...(showLeadWindow ? { showLeadWindow: true } : {}) },
      ] satisfies Block[],
    ]),
  ),
});

/** Freezes stale html into the published version, as if publish had compiled it long ago. */
async function freezeStale(versionId: string, paths: readonly string[]) {
  const html = Object.fromEntries(LOCALES.map((l) => [l, Object.fromEntries(paths.map((p) => [p, `<html lang="${l}"><body>STALE PRECOMPILED</body></html>`]))]));
  const text = Object.fromEntries(LOCALES.map((l) => [l, Object.fromEntries(paths.map((p) => [p, "STALE PRECOMPILED"]))]));
  await h.db.update(emailTemplateVersions).set({ htmlByLocale: html, textByLocale: text }).where(eq(emailTemplateVersions.id, versionId));
}

async function currentVersionId(templateId: string): Promise<string> {
  const rows = await h.db.select({ id: emailTemplateVersions.id }).from(emailTemplateVersions).where(eq(emailTemplateVersions.templateId, templateId));
  return rows[0]!.id;
}

describe("SI-1: an invalid stored document ends the message failed", () => {
  it("email.send writes failed / invalid_document and dies with the PermanentError", async () => {
    const slug = `fixwiring.bad_document_${uniq()}`;
    await seedTemplate(h.db as unknown as Tx, {
      slug,
      name: "Bad document",
      kind: "transactional",
      purpose: null,
      subject: each("Bad"),
      preheader: each("Bad"),
      document: { schemaVersion: 1, locales: Object.fromEntries(LOCALES.map((l) => [l, [{ id: `bad-${l}`, type: "text", markdown: "Hello" }]])) } as never,
    });
    const p = await personWith(h.db);
    const { emailMessageId } = await sendTransactional(makeCtx(h.db), { template: slug, personId: p.id, locale: "en", data: {}, key: `fixw21:bad:${p.id}` });
    const error = await run(emailMessageId, slug).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(PermanentError);
    expect((error as Error).message).toMatch(/^invalid_document/);
    // Written durably: survives the rollback of the job transaction.
    expect(await messageOf(h.db, emailMessageId)).toMatchObject({ status: "failed", error: "invalid_document" });
    expect(fakes.resend.sent).toHaveLength(0);
  });
});

describe("cards of previews and publish (request email-P8)", () => {
  it("resolveCardsFor copies opensForCustomersAt from booking's session card", async () => {
    const session = await leadMagnet();
    const cards = await resolveCardsFor(h.db, "en")({ productIds: [], sessionIds: [session.id], webinarIds: [] });
    expect(cards.events[session.id]?.opensForCustomersAt).toEqual(session.leadWindowEndAt);
    await release(session.id);
    const after = await resolveCardsFor(h.db, "en")({ productIds: [], sessionIds: [session.id], webinarIds: [] });
    expect(after.events[session.id]?.opensForCustomersAt ?? null).toBeNull();
  });

  it("webinarCardsFor returns webinar's cards, and the preview renders the webinar block", async () => {
    const webinar = await makeWebinar(h.db, {}, { published: true });
    const cards = await webinarCardsFor(h.db)([webinar.id], "en");
    expect(cards.map((c) => c.id)).toEqual([webinar.id]);
    const document: BlockDocument = { schemaVersion: 1, locales: { en: [{ id: "wb00000001", type: "webinar", webinarId: webinar.id, ctaLabel: "Save my seat" }] } };
    const preview = await buildPreview(h.db, {
      template: { kind: "marketing", purpose: "events", slug: "fixw21-webinar" },
      version: { subject: { en: "Webinar" }, preheader: { en: "Webinar" }, document, reactComponent: null, copy: null } as never,
      locale: "en",
      recipient: samplePersona("lead"),
    });
    expect(preview.html).toContain("Save my seat");
    expect(preview.html).toContain(cards[0]!.landingUrl);
    expect(preview.warnings.map((w) => w.code)).not.toContain("webinar_unavailable");
  });
});

describe("send-time cards for lead-window event blocks (request email-P8, booking spec 4.9)", () => {
  async function eventTemplate(sessionId: string, showLeadWindow: boolean, kind: "transactional" | "marketing" = "transactional") {
    const slug = kind === "transactional" ? `fixwiring.event_${uniq()}` : `fixw21-event-${uniq()}`;
    const { templateId } = await seedTemplate(h.db as unknown as Tx, {
      slug,
      name: slug,
      kind,
      purpose: kind === "marketing" ? "newsletter" : null,
      subject: each("Vitality Evening"),
      preheader: each("Vitality Evening"),
      document: eventDoc(sessionId, showLeadWindow),
    });
    return { slug, templateId };
  }

  it("email.send compiles a lead-window document again: a customer sees the button once the window is released", async () => {
    const session = await leadMagnet();
    const { slug, templateId } = await eventTemplate(session.id, true);
    await freezeStale(await currentVersionId(templateId), ["lead_window:0", "lead_window:f"]);
    await release(session.id);
    const p = await personWith(h.db);
    const { emailMessageId } = await sendTransactional(makeCtx(h.db), { template: slug, personId: p.id, locale: "en", data: {}, key: `fixw21:live:${p.id}` });
    expect(await run(emailMessageId, slug)).toMatchObject({ status: "sent" });
    const [out] = sentTo(p.email!);
    expect(out?.html).not.toContain("STALE PRECOMPILED");
    expect(out?.html).toContain(CTA);
    expect(out?.html).not.toContain(OPENS);
  });

  it("while the window is open the live compile shows a non-lead the notice", async () => {
    const session = await leadMagnet();
    const { slug, templateId } = await eventTemplate(session.id, true);
    await freezeStale(await currentVersionId(templateId), ["lead_window:0", "lead_window:f"]);
    // A test send as the sample customer (a fresh contact would be a lead and see the button).
    const { to } = await sendTest(templateId, slug, { sample: "customer" }, ["email.write"], "nl-BE");
    const [out] = sentTo(to);
    expect(out?.html).not.toContain("STALE PRECOMPILED");
    expect(out?.html).toContain("Opent voor jou op");
    expect(out?.html).not.toContain(CTA);
  });

  it("a document without a lead-window block keeps using the html compiled at publish", async () => {
    const session = await leadMagnet();
    const { slug, templateId } = await eventTemplate(session.id, false);
    await freezeStale(await currentVersionId(templateId), ["default"]);
    const p = await personWith(h.db);
    const { emailMessageId } = await sendTransactional(makeCtx(h.db), { template: slug, personId: p.id, locale: "en", data: {}, key: `fixw21:frozen:${p.id}` });
    await run(emailMessageId, slug);
    expect(sentTo(p.email!)[0]?.html).toContain("STALE PRECOMPILED");
  });

  it("campaign.send_chunk compiles a lead-window document again with today's cards", async () => {
    const session = await leadMagnet();
    const { templateId } = await eventTemplate(session.id, true, "marketing");
    const user = await staff(h.db);
    const p = await personWith(h.db, { locale: "en" });
    await grant(h.db, [p.id], "newsletter");
    await h.db.insert(settings).values({ key: "warmup_schedule", value: { domain: "news.beam.be", start_on: "2026-01-05", daily_caps: [] } }).onConflictDoUpdate({
      target: settings.key,
      set: { value: { domain: "news.beam.be", start_on: "2026-01-05", daily_caps: [] } },
    });
    const segmentId = await staticSegment(h.db, `fixw21 segment ${uniq()}`, [p.id]);
    // Pinned two minutes ahead, so the test send below is newer than the content edits.
    const now = new Date(Date.now() + 2 * 60_000);
    const ctx = makeCtx(h.db, { actor: staffActor({ userId: user.id, roleKey: "marketing", permissions: ["email.write", "campaigns.send", "email.send"] }), now });
    const { campaignId } = await createCampaignRecord(ctx, { name: "Lead window campaign", purpose: "newsletter", templateId });
    await updateCampaignRecord(ctx, { campaignId, expectedVersion: 1, segmentId });
    await h.db.update(campaigns).set({ testSentAt: new Date(now.getTime() - 60_000) }).where(eq(campaigns.id, campaignId));
    await scheduleCampaignRecord(ctx, { campaignId, expectedVersion: 2, scheduledAt: "now", confirmOutsideWindow: true }).catch((e: { fields?: unknown }) => {
      throw new Error(JSON.stringify(e.fields));
    });
    await planCampaign(makeJobCtx(h.db, "campaign.plan", { now }), { campaignId, version: (await campaignOf(h.db, campaignId)).version });
    await dispatchDueCampaigns(makeJobCtx(h.db, "email.dispatch_due_campaigns", { now }));
    const campaign = await campaignOf(h.db, campaignId);
    expect(campaign.status).toBe("sending");
    await freezeStale(campaign.templateVersionId!, ["lead_window:0", "lead_window:f"]);
    await release(session.id);

    await sendChunk(makeJobCtx(h.db, "campaign.send_chunk", { integrations: fakes, now }), { campaignId, chunkNo: 0, runNo: 1 });
    const [out] = sentTo(p.email!);
    expect(out?.html).not.toContain("STALE PRECOMPILED");
    expect(out?.html).toContain(CTA);
  });
});

describe("test sends render for their persona (request email-P5, rule 60)", () => {
  const STATUS_DOC: BlockDocument = {
    schemaVersion: 1,
    locales: Object.fromEntries(
      LOCALES.map((l) => [
        l,
        [
          { id: "hd00000001", type: "heading", level: 1, text: "Hello {{first_name|friend}}" },
          {
            id: "dy00000001",
            type: "dynamic",
            variants: [{ when: { status: "member" }, blocks: [{ id: "tx00000002", type: "text", markdown: "Thank you for being a member." }] }],
            fallback: [{ id: "tx00000003", type: "text", markdown: "Become a member today." }],
          },
        ] satisfies Block[],
      ]),
    ),
  };

  async function marketingTemplate() {
    const slug = `fixw21-test-${uniq()}`;
    const { templateId } = await seedTemplate(h.db as unknown as Tx, {
      slug,
      name: slug,
      kind: "marketing",
      purpose: "newsletter",
      subject: each("Hello {{first_name|friend}}"),
      preheader: each("News"),
      document: STATUS_DOC,
    });
    return { slug, templateId };
  }

  it("a sample member gets the member variant, the sample's tokens and the marketing footer", async () => {
    const { slug, templateId } = await marketingTemplate();
    const { to, messageIds } = await sendTest(templateId, slug, { sample: "member" });
    const [out] = sentTo(to);
    expect(out?.subject).toContain("[TEST] Hello Mia");
    expect(out?.html).toContain("Hello Mia");
    expect(out?.html).toContain("Thank you for being a member.");
    expect(out?.html).not.toContain("Become a member today.");
    // Marketing footer: the unsubscribe link points at the preview preferences page, never at a real token.
    expect(out?.html).toContain("/preferences/preview");
    expect(out?.html).not.toContain("{{unsubscribe_url}}");
    expect((await messageOf(h.db, messageIds[0]!)).status).toBe("sent");
  });

  it("a sample lead gets the fallback variant", async () => {
    const { slug, templateId } = await marketingTemplate();
    const { to } = await sendTest(templateId, slug, { sample: "lead" });
    const [out] = sentTo(to);
    expect(out?.html).toContain("Hello Lena");
    expect(out?.html).toContain("Become a member today.");
  });

  it("a real contact gives that person's tokens", async () => {
    const { slug, templateId } = await marketingTemplate();
    const p = await personWith(h.db, { firstName: "Quinten" });
    const { to } = await sendTest(templateId, slug, { personId: p.id }, ["email.write", "persons.read"]);
    const [out] = sentTo(to);
    expect(out?.html).toContain("Hello Quinten");
    expect(out?.html).not.toContain("Hello friend");
  });
});
