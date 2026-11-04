/**
 * email-P5: template preview (email spec rules 18, 23, 24; `/admin/templates/[id]/preview`).
 * Preview as a real contact uses their status and latest assessment outcome; the Lead, Customer
 * and Member samples choose the matching dynamic variant; no sensitive field is read.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { EMAIL_TOKENS, newBlockId, type Block, type BlockDocument } from "@beam/core/email";
import { LOCALES, type Locale } from "@beam/core/i18n";
import { makeCtx, resetRuntime } from "@/lib/testing";

const outcomes = vi.hoisted(() => ({ byPerson: new Map<string, string>(), calls: [] as string[] }));
vi.mock("@/modules/forms/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/forms/api")>()),
  listLatestOutcomes: vi.fn(async (_tx: unknown, personIds: string[], formSlug: string) => {
    outcomes.calls.push(formSlug);
    return new Map(personIds.flatMap((id) => (outcomes.byPerson.has(id) ? [[id, outcomes.byPerson.get(id)!] as const] : [])));
  }),
}));
const sensitive = vi.hoisted(() => ({ reads: 0 }));
vi.mock("@/lib/sensitive", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sensitive")>();
  return {
    ...actual,
    readSensitive: vi.fn(async (...args: Parameters<typeof actual.readSensitive>) => {
      sensitive.reads += 1;
      return actual.readSensitive(...args);
    }),
  };
});

const { getPreview, samplePersona } = await import("../queries");
const { recipientTokenValues } = await import("./preview");
const { blockTemplate, completeCompany } = await import("../email-p3.fixtures");
const tpl = await import("./templates");
const { staffActor } = await import("@/lib/testing");
const { makeUser } = await import("@beam/db/testing");

let h: DbHandle;
let templateId: string;
const FORM = "stress-check";
const ids = { status: "dynStatus1", outcome: "dynOutcom1" };

const para = (markdown: string): Block => ({ id: newBlockId(), type: "text", markdown });
function document(): BlockDocument {
  const locales: Partial<Record<Locale, Block[]>> = {};
  for (const l of LOCALES) {
    locales[l] = [
      { id: newBlockId(), type: "heading", level: 1, text: `Hello {{first_name|friend}} (${l})` },
      {
        id: ids.status,
        type: "dynamic",
        variants: [
          { when: { status: "lead" }, blocks: [para(`LEAD-COPY ${l}`)] },
          { when: { status: "customer" }, blocks: [para(`CUSTOMER-COPY ${l}`)] },
          { when: { status: "member" }, blocks: [para(`MEMBER-COPY ${l}`)] },
        ],
        fallback: [para(`NOBODY-COPY ${l}`)],
      },
      {
        id: ids.outcome,
        type: "dynamic",
        variants: [{ when: { assessmentOutcome: { formSlug: FORM, outcomeKeys: ["high"] } }, blocks: [para(`HIGH-STRESS ${l}`)] }],
        fallback: [para(`NO-OUTCOME ${l}`)],
      },
    ];
  }
  return { schemaVersion: 1, locales };
}

beforeAll(async () => {
  h = await createTestDb();
  await completeCompany(h.db);
  const user = await makeUser(h.db, { roleKey: "marketing" });
  const ctx = makeCtx(h.db, staffActor({ userId: user.id, permissions: ["email.write", "email.send"] }));
  templateId = await blockTemplate(h.db, { slug: "p5-preview", kind: "marketing" });
  const detail = await (await import("../queries")).getTemplate(h.db, templateId);
  await tpl.saveTemplateDraftRecord(ctx, {
    templateId,
    draftUpdatedAt: detail!.draftUpdatedAt!,
    subject: Object.fromEntries(LOCALES.map((l) => [l, `News for {{first_name|you}} ${l}`])),
    preheader: Object.fromEntries(LOCALES.map((l) => [l, `Preheader ${l}`])),
    document: document(),
  });
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

const preview = (as: Parameters<typeof getPreview>[1]["as"], locale: Locale = "en", canReadPersons = true) =>
  getPreview(h.db, { templateId, use: "draft", locale, ...(as ? { as } : {}) }, { canReadPersons });

describe("getPreview", () => {
  it("as a real person uses their status (v_person_status) and their latest assessment outcome", async () => {
    const person = await makePerson(h.db, { firstName: "Noor", locale: "nl-BE", statusOverride: "member", statusOverrideReason: "test", statusOverrideAt: new Date() });
    outcomes.byPerson.set(person.id, "high");
    const p = await preview({ personId: person.id }, "nl-BE");
    expect(p!.html).toContain("MEMBER-COPY nl-BE");
    expect(p!.html).toContain("HIGH-STRESS nl-BE");
    expect(p!.html).not.toContain("LEAD-COPY");
    expect(p!.variant).toBe(`${ids.status}:2,${ids.outcome}:0`);
    expect(p!.subject).toBe("News for Noor nl-BE");
    expect(p!.html).toContain("Hello Noor (nl-BE)");
    expect(outcomes.calls).toContain(FORM);
    expect(p!.sizeBytes).toBe(Buffer.byteLength(p!.html, "utf8"));
    expect(p!.text).toContain("MEMBER-COPY nl-BE");
  });

  it("refuses a real contact without persons.read", async () => {
    const person = await makePerson(h.db, { firstName: "Ilse" });
    await expect(preview({ personId: person.id }, "en", false)).rejects.toMatchObject({ name: "ForbiddenError" });
  });

  it.each([
    ["lead", "LEAD-COPY"],
    ["customer", "CUSTOMER-COPY"],
    ["member", "MEMBER-COPY"],
  ] as const)("as the %s sample chooses the matching variant", async (sample, marker) => {
    const p = await preview({ sample }, "fr-BE");
    expect(p!.html).toContain(`${marker} fr-BE`);
    for (const other of ["LEAD-COPY", "CUSTOMER-COPY", "MEMBER-COPY", "NOBODY-COPY"].filter((m) => m !== marker)) expect(p!.html).not.toContain(other);
    expect(p!.html).toContain("NO-OUTCOME fr-BE");
    expect(p!.subject).toBe(`News for ${samplePersona(sample).values.first_name} fr-BE`);
  });

  it("a sample with an assessment outcome selects the outcome variant", async () => {
    const p = await preview({ sample: "lead", assessmentOutcome: "high" });
    expect(p!.html).toContain("HIGH-STRESS en");
    expect(p!.html).toContain("LEAD-COPY en");
    const other = await preview({ sample: "lead", assessmentOutcome: "low" });
    expect(other!.html).toContain("NO-OUTCOME en");
  });

  it("reads no sensitive field: no readSensitive call and only EMAIL_TOKENS values for a real person", async () => {
    sensitive.reads = 0;
    const person = await makePerson(h.db, { firstName: "Sara", lastName: "Peeters" });
    await preview({ personId: person.id }, "en");
    const values = await recipientTokenValues(h.db, { source: "person", personId: person.id, status: null, assessmentOutcome: null, outcomes: {}, values: {}, dates: { nextBookingAt: null, membershipPeriodEnd: null } }, "en", [...EMAIL_TOKENS]);
    expect(sensitive.reads).toBe(0);
    for (const key of Object.keys(values)) expect(EMAIL_TOKENS as readonly string[]).toContain(key);
    expect(values.full_name).toBe("Sara Peeters");
  });

  it("returns null for an unknown template and an empty preview with a warning for a locale without content", async () => {
    expect(await getPreview(h.db, { templateId: "00000000-0000-4000-8000-000000000000", use: "draft", locale: "en" }, { canReadPersons: true })).toBeNull();
    const { templateId: bare } = await tpl.createTemplateRecord(makeCtx(h.db, staffActor({ userId: (await makeUser(h.db)).id, permissions: ["email.write"] })), { name: "P5 bare", kind: "marketing", purpose: "events" });
    const p = await getPreview(h.db, { templateId: bare, use: "draft", locale: "en" }, { canReadPersons: true });
    expect(p!.html).toBe("");
    expect(p!.warnings.map((w) => w.code)).toContain("missing_translation");
  });
});
