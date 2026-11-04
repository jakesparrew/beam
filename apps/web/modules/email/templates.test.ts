/**
 * email-P5: the template store (email spec rules 5, 9 to 15b, 21; actions `createTemplate`,
 * `saveTemplateDraft`, `publishTemplateVersion`, `archiveTemplate`, `duplicateTemplate`).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makeUser } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { auditLog, campaigns, emailTemplates, emailTemplateVersions, settings } from "@beam/db/schema";
import { newBlockId, type Block, type BlockDocument, type LeafBlock } from "@beam/core/email";
import { LOCALES, type Locale } from "@beam/core/i18n";
import { eq } from "@/lib/ctx";
import { createFakeIntegrations, makeCtx, makeJobCtx, resetRuntime, staffActor } from "@/lib/testing";
import type * as AutomationApi from "@/modules/automation/api";

const inUse = vi.hoisted(() => ({ slugs: new Set<string>() }));
vi.mock("@/modules/automation/api", async (importOriginal) => ({
  ...(await importOriginal<typeof AutomationApi>()),
  isTemplateInUse: vi.fn((_tx: unknown, slug: string) => Promise.resolve(inUse.slugs.has(slug))),
}));

const { sendTransactional } = await import("./api");
const { sendEmailMessage } = await import("./jobs");
const { blockTemplate, COMPANY, completeCompany, messageOf, resetEmailTables } = await import("./email-p3.fixtures");
const { ensureSystemTemplate } = await import("./server/templates-info");
const { getTemplate } = await import("./queries");
const tpl = await import("./server/templates");

let h: DbHandle;
let userId: string;
beforeAll(async () => {
  h = await createTestDb();
  await completeCompany(h.db);
  userId = (await makeUser(h.db, { roleKey: "marketing" })).id;
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(() => inUse.slugs.clear());

const staff = () => makeCtx(h.db, staffActor({ userId, permissions: ["email.write", "email.send"] }));
const all = (text: string) => Object.fromEntries(LOCALES.map((l) => [l, `${text} ${l}`])) as Record<Locale, string>;
const heading = (text: string): Block => ({ id: newBlockId(), type: "heading", level: 1, text });
const para = (markdown: string): LeafBlock => ({ id: newBlockId(), type: "text", markdown });
const docOf = (perLocale: (l: Locale) => Block[], locales: readonly Locale[] = LOCALES): BlockDocument => ({
  schemaVersion: 1,
  locales: Object.fromEntries(locales.map((l) => [l, perLocale(l)])),
});
const fullDoc = () => docOf((l) => [heading(`Hello {{first_name|friend}} ${l}`), para(`Read [the programme](https://beam.be/${l}/events) today, ${l}.`)]);

async function versionsOf(templateId: string) {
  return h.db.select().from(emailTemplateVersions).where(eq(emailTemplateVersions.templateId, templateId)).orderBy(emailTemplateVersions.version);
}

async function draftAt(templateId: string): Promise<Date> {
  const detail = await getTemplate(h.db, templateId);
  return detail!.draftUpdatedAt!;
}

/** A marketing template with a complete draft in every locale. */
async function completeMarketing(name: string, document: BlockDocument = fullDoc()) {
  const ctx = staff();
  const { templateId } = await tpl.createTemplateRecord(ctx, { name, kind: "marketing", purpose: "newsletter" });
  await tpl.saveTemplateDraftRecord(ctx, { templateId, draftUpdatedAt: await draftAt(templateId), subject: all("Subject"), preheader: all("Preheader"), document });
  return templateId;
}

async function publish(templateId: string) {
  return tpl.publishTemplateRecord(staff(), { templateId, draftUpdatedAt: await draftAt(templateId) });
}

async function validationOf(run: Promise<unknown>): Promise<{ message: string; fields: Record<string, string> }> {
  const error = (await run.then(
    () => null,
    (e: unknown) => e,
  )) as { code?: string; message: string; fields?: Record<string, string> } | null;
  expect(error?.code).toBe("validation");
  return { message: error!.message, fields: error!.fields ?? {} };
}

describe("drafts and immutability (rules 9 to 11)", () => {
  it("creates a draft (version max + 1, copied from the current version) on the first edit of a published template", async () => {
    const templateId = await blockTemplate(h.db, { slug: "p5-first-edit", kind: "marketing" });
    const [v1] = await versionsOf(templateId);
    expect(v1!.publishedAt).not.toBeNull();
    const saved = await tpl.saveTemplateDraftRecord(staff(), {
      templateId,
      draftUpdatedAt: await draftAt(templateId),
      subject: { ...v1!.subject, en: "Edited subject en" },
      preheader: v1!.preheader,
    });
    const rows = await versionsOf(templateId);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ id: saved.draftVersionId, version: 2, publishedAt: null });
    expect(rows[1]!.subject.en).toBe("Edited subject en");
    expect(rows[1]!.document).toEqual(v1!.document);
    const [template] = await h.db.select().from(emailTemplates).where(eq(emailTemplates.id, templateId));
    expect(template!.currentVersionId).toBe(v1!.id);
  });

  it("never updates a published row: saves after publishing open a new draft and leave every published version as it was", async () => {
    const templateId = await completeMarketing("P5 immutable");
    await publish(templateId);
    const [v1before] = await versionsOf(templateId);
    await tpl.saveTemplateDraftRecord(staff(), { templateId, draftUpdatedAt: await draftAt(templateId), subject: all("Second"), preheader: all("Preheader") });
    await publish(templateId);
    await tpl.saveTemplateDraftRecord(staff(), { templateId, draftUpdatedAt: await draftAt(templateId), subject: all("Third"), preheader: all("Preheader") });
    const rows = await versionsOf(templateId);
    expect(rows.map((r) => [r.version, r.publishedAt !== null])).toEqual([
      [1, true],
      [2, true],
      [3, false],
    ]);
    expect(rows[0]).toEqual(v1before);
    expect(rows[1]!.subject.en).toBe("Second en");
    const [template] = await h.db.select().from(emailTemplates).where(eq(emailTemplates.id, templateId));
    expect(template).toMatchObject({ status: "published", currentVersionId: rows[1]!.id });
  });

  it("answers conflict for a stale draftUpdatedAt (two staff edit the same draft)", async () => {
    const templateId = await completeMarketing("P5 conflict");
    const stale = await draftAt(templateId);
    await tpl.saveTemplateDraftRecord(staff(), { templateId, draftUpdatedAt: stale, subject: all("A"), preheader: all("P") });
    await expect(tpl.saveTemplateDraftRecord(staff(), { templateId, draftUpdatedAt: stale, subject: all("B"), preheader: all("P") })).rejects.toMatchObject({ code: "conflict" });
    await expect(tpl.publishTemplateRecord(staff(), { templateId, draftUpdatedAt: stale })).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("publishTemplateVersion (rules 5, 10, 12, 13, 15b)", () => {
  it("refuses incomplete locales with the exact missing list", async () => {
    const ctx = staff();
    const { templateId } = await tpl.createTemplateRecord(ctx, { name: "P5 incomplete", kind: "marketing", purpose: "events" });
    const button: Block = { id: newBlockId(), type: "button", label: " ", href: "https://beam.be/nl", style: "primary" };
    await tpl.saveTemplateDraftRecord(ctx, {
      templateId,
      draftUpdatedAt: await draftAt(templateId),
      subject: { "nl-BE": "Onderwerp", en: "Subject" },
      preheader: { "nl-BE": "Voorkop" },
      document: { schemaVersion: 1, locales: { "nl-BE": [heading("Hallo"), button], en: [heading("Hello")] } },
    });
    const { message, fields } = await validationOf(publish(templateId));
    expect(message).toBe("template_incomplete");
    expect(Object.keys(fields)).toEqual([`nl-BE:blocks.${button.id}.label`, "fr-BE:subject", "fr-BE:preheader", "fr-BE:document", "en:preheader"]);
    const [draft] = await versionsOf(templateId);
    expect(draft!.publishedAt).toBeNull();
  });

  it("refuses an unknown token and an unregistered merge field", async () => {
    const templateId = await completeMarketing("P5 tokens", docOf((l) => [heading(`Hi {{favourite_colour}} ${l}`), para(`See {{webinar.no_such_field}} ${l}`)]));
    const { message, fields } = await validationOf(publish(templateId));
    expect(message).toBe("unknown_token");
    expect(Object.keys(fields)).toEqual(["token:favourite_colour", "token:webinar.no_such_field"]);
  });

  it("refuses a marketing template while the legal footer data is incomplete (rule 5)", async () => {
    const templateId = await completeMarketing("P5 footer");
    await h.db.update(settings).set({ value: { ...COMPANY, address: { ...COMPANY.address, street: "", city: "" } } }).where(eq(settings.key, "company"));
    try {
      const { message, fields } = await validationOf(publish(templateId));
      expect(message).toBe("footer_incomplete");
      expect(Object.keys(fields)).toEqual(["footer:company.address"]);
    } finally {
      await completeCompany(h.db);
    }
    await expect(publish(templateId)).resolves.toMatchObject({ version: 1 });
  });

  it("stores the MJML compile per locale and per dynamic variant", async () => {
    const dynamic = (l: Locale): Block => ({
      id: `dyn${l.replace("-", "").padEnd(7, "x")}`.slice(0, 10),
      type: "dynamic",
      variants: [
        { when: { status: "lead" }, blocks: [para(`Lead offer ${l}`)] },
        { when: { status: "member" }, blocks: [para(`Member news ${l}`)] },
      ],
      fallback: [para(`Everyone else ${l}`)],
    });
    const templateId = await completeMarketing("P5 compile", docOf((l) => [heading(`Newsletter ${l}`), dynamic(l)]));
    const { versionId } = await publish(templateId);
    const [v] = await h.db.select().from(emailTemplateVersions).where(eq(emailTemplateVersions.id, versionId));
    expect(v!.locales).toEqual([...LOCALES]);
    expect(Object.keys(v!.htmlByLocale!).sort()).toEqual([...LOCALES].sort());
    for (const l of LOCALES) {
      const id = dynamic(l).id;
      expect(Object.keys(v!.htmlByLocale![l]!).sort()).toEqual([`${id}:0`, `${id}:1`, `${id}:f`]);
      expect(Object.keys(v!.textByLocale![l]!).sort()).toEqual([`${id}:0`, `${id}:1`, `${id}:f`]);
      expect(v!.htmlByLocale![l]![`${id}:0`]).toContain(`Lead offer ${l}`);
      expect(v!.htmlByLocale![l]![`${id}:1`]).toContain(`Member news ${l}`);
      expect(v!.textByLocale![l]![`${id}:f`]).toContain(`Everyone else ${l}`);
      expect(v!.htmlByLocale![l]![`${id}:f`]).toContain(`lang="${l}"`);
    }
    const audits = await h.db.select().from(auditLog).where(eq(auditLog.entityId, templateId));
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(["email.template_create", "email.template_publish"]));
  });

  it("returns accessibility warnings and still publishes", async () => {
    const vague: Block = { id: newBlockId(), type: "button", label: "Click here", href: "https://beam.be/en/events", style: "primary" };
    const templateId = await completeMarketing("P5 a11y", docOf((l) => [heading(`Events ${l}`), { ...vague, id: newBlockId() }]));
    const result = await publish(templateId);
    expect(result.version).toBe(1);
    expect(result.warnings.map((w) => w.code)).toContain("vague_link_text");
    const [template] = await h.db.select().from(emailTemplates).where(eq(emailTemplates.id, templateId));
    expect(template!.status).toBe("published");
  });

  it("publishes a block-backed transactional template that then sends without tracking and without List-Unsubscribe", async () => {
    vi.stubEnv("APP_ENV", "local");
    vi.stubEnv("EMAIL_SINK", "");
    vi.stubEnv("APP_URL", "https://beam.be");
    try {
      await resetEmailTables(h.db);
      const templateId = await blockTemplate(h.db, { slug: "automation.p5_notice", kind: "transactional" });
      const [v1] = await versionsOf(templateId);
      await tpl.saveTemplateDraftRecord(staff(), { templateId, draftUpdatedAt: await draftAt(templateId), subject: all("Notice"), preheader: v1!.preheader, document: fullDoc() });
      const published = await publish(templateId);
      expect(published.version).toBe(2);
      const ctx = makeCtx(h.db);
      const { emailMessageId } = await sendTransactional(ctx, { template: "automation.p5_notice", to: "notice@example.com", locale: "fr-BE", data: {}, key: "p5:transactional-blocks" });
      const fakes = createFakeIntegrations();
      const result = await sendEmailMessage(makeJobCtx(h.db, "email.send", { integrations: fakes }), { emailMessageId, template: "automation.p5_notice" });
      expect(result.status).toBe("sent");
      const m = await messageOf(h.db, emailMessageId);
      expect(m).toMatchObject({ templateVersionId: published.versionId, fromDomain: "mail.beam.be", links: null });
      const sent = fakes.resend.sent.at(-1)!;
      expect(sent.subject).toBe("Notice fr-BE");
      expect(Object.keys(sent.headers ?? {}).map((k) => k.toLowerCase())).not.toContain("list-unsubscribe");
      expect(sent.html).not.toContain("/api/public/track/");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("archiveTemplate and duplicateTemplate (rules 14, 15)", () => {
  it("refuses to archive a system template", async () => {
    const seeded = await ensureSystemTemplate(h.db, "platform.magic_link");
    const { message } = await validationOf(tpl.archiveTemplateRecord(staff(), { templateId: seeded!.templateId }));
    expect(message).toBe("system_template");
  });

  it("refuses to archive while a scheduled campaign or an active automation references the template", async () => {
    const templateId = await completeMarketing("P5 archive");
    await publish(templateId);
    const [campaign] = await h.db
      .insert(campaigns)
      .values({ name: "P5 scheduled", templateId, purpose: "newsletter", status: "scheduled", scheduledAt: new Date(Date.now() + 86_400_000), createdByUserId: userId })
      .returning();
    expect((await validationOf(tpl.archiveTemplateRecord(staff(), { templateId }))).message).toBe("template_in_use");
    await h.db.update(campaigns).set({ status: "cancelled", cancelledAt: new Date() }).where(eq(campaigns.id, campaign!.id));
    const [row] = await h.db.select().from(emailTemplates).where(eq(emailTemplates.id, templateId));
    inUse.slugs.add(row!.slug);
    expect((await validationOf(tpl.archiveTemplateRecord(staff(), { templateId }))).fields).toEqual({ automations: "in_use" });
    inUse.slugs.clear();
    await expect(tpl.archiveTemplateRecord(staff(), { templateId })).resolves.toEqual({ ok: true });
    const [archived] = await h.db.select().from(emailTemplates).where(eq(emailTemplates.id, templateId));
    expect(archived!.status).toBe("archived");
    expect((await validationOf(tpl.saveTemplateDraftRecord(staff(), { templateId, draftUpdatedAt: await draftAt(templateId), subject: all("x"), preheader: all("y") }))).message).toBe("template_archived");
  });

  it("duplicates a marketing template into a new draft with the same content and a fresh slug", async () => {
    const templateId = await completeMarketing("P5 original");
    const { templateId: copyId } = await tpl.duplicateTemplateRecord(staff(), { templateId, name: "P5 original" });
    const [source] = await versionsOf(templateId);
    const [copy] = await versionsOf(copyId);
    expect(copy).toMatchObject({ version: 1, publishedAt: null, subject: source!.subject, document: source!.document });
    const [t] = await h.db.select().from(emailTemplates).where(eq(emailTemplates.id, copyId));
    expect(t).toMatchObject({ kind: "marketing", purpose: "newsletter", status: "draft", slug: "p5-original-2" });
    const seeded = await ensureSystemTemplate(h.db, "platform.magic_link");
    expect((await validationOf(tpl.duplicateTemplateRecord(staff(), { templateId: seeded!.templateId, name: "Copy" }))).message).toBe("not_duplicable");
  });
});

describe("code-backed transactional templates", () => {
  it("edits copy slots in a new draft and publishes with catalogue defaults filling untouched slots", async () => {
    const seeded = await ensureSystemTemplate(h.db, "platform.magic_link");
    const templateId = seeded!.templateId;
    const detail = await getTemplate(h.db, templateId);
    expect(detail!.slots.length).toBeGreaterThan(0);
    const slot = detail!.slots.find((s) => s !== "subject" && s !== "preheader")!;
    const current = detail!.current!;
    await tpl.saveTemplateDraftRecord(staff(), {
      templateId,
      draftUpdatedAt: detail!.draftUpdatedAt!,
      subject: Object.keys(current.subject).length === 3 ? current.subject : all("Sign in"),
      preheader: all("Your sign-in link"),
      copy: { [slot]: { "nl-BE": "Aangepast", "fr-BE": "Modifié", en: "Edited" } },
    });
    const result = await publish(templateId);
    const [v] = await h.db.select().from(emailTemplateVersions).where(eq(emailTemplateVersions.id, result.versionId));
    expect(v).toMatchObject({ reactComponent: "platform.magic_link", htmlByLocale: null, locales: [...LOCALES] });
    expect(v!.copy![slot]).toEqual({ "nl-BE": "Aangepast", "fr-BE": "Modifié", en: "Edited" });
    await expect(
      tpl.saveTemplateDraftRecord(staff(), { templateId, draftUpdatedAt: await draftAt(templateId), subject: all("x"), preheader: all("y"), copy: { no_such_slot: all("z") } }),
    ).rejects.toMatchObject({ code: "validation", message: "unknown_slot" });
  });
});
