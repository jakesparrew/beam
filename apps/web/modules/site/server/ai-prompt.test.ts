/**
 * site-P4 prompt and proposal validation (site rules 42-44, decision 22): the prompt sent to Claude
 * holds no email, phone or person name from the database; `fieldsSent` is exactly rule 42's list;
 * each reference list is capped at 200 items; `validateProposal` keeps ids, locales, kind and
 * references in line.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { users } from "@beam/db/schema";
import { createTestDb, makePerson, makeProduct } from "@beam/db/testing";
import { paragraphDoc, type Block, type VersionContent } from "@beam/core/site";

vi.mock("next/cache", () => ({ revalidateTag: () => undefined, unstable_cache: (fn: (...a: unknown[]) => unknown) => fn }));
vi.mock("next/server", () => ({ after: () => undefined }));
vi.mock("@/modules/forms/api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listPublishedForms: () => Promise.resolve([]),
}));

const { eq, setAppDb } = await import("@/lib/ctx");
const { createFakeIntegrations, makeJobCtx, resetRuntime } = await import("@/lib/testing");
const { buildProposalPrompt, buildRepairMessages, PROPOSAL_FIELDS_SENT, REF_LIST_CAP } = await import("./ai-prompt");
const { validateProposal } = await import("./proposal-validate");
const { proposePage } = await import("../jobs/propose");
const { pageWithRequest, validAnswer } = await import("../jobs/site-p4.fixtures");

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

const text = (id: string, t: string): Block => ({ id, type: "rich_text", doc: paragraphDoc(t) });
const base = (): VersionContent => ({
  title: { "nl-BE": "Over ons", en: "About us" },
  paths: { "nl-BE": "over-ons", en: "about-us" },
  blocks: { "nl-BE": [text("11111111-1111-4111-8111-111111111111", "Welkom.")], en: [text("11111111-1111-4111-8111-111111111111", "Welcome.")] },
  seo: {},
  excerpt: null,
  coverMediaId: null,
  locales: ["nl-BE", "en"],
});
const emptyRefs = { products: [], sessions: [], forms: [], pages: [] };
const page = { kind: "standard" as const, legalKey: null, sessionId: null, slug: "about" };

describe("buildProposalPrompt", () => {
  it("returns rule 42's fieldsSent exactly and a stable system prompt", () => {
    const a = buildProposalPrompt({ page, base: base(), instruction: "Shorter intro", locales: ["nl-BE", "en"], refs: emptyRefs, brandVoice: "Warm and clear." });
    const b = buildProposalPrompt({ page, base: null, instruction: "Another page", locales: ["fr-BE"], refs: emptyRefs, brandVoice: "" });
    expect(a.fieldsSent).toEqual(["page_content", "instruction", "catalogue_refs"]);
    expect(PROPOSAL_FIELDS_SENT).toEqual(["page_content", "instruction", "catalogue_refs"]);
    expect(a.system).toBe(b.system);
    expect(a.messages).toHaveLength(1);
    expect(a.messages[0]!.content).toContain("Shorter intro");
    expect(a.messages[0]!.content).toContain("Warm and clear.");
    expect(a.messages[0]!.content).toContain("Welkom.");
  });

  it("caps every reference list at 200 items", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => i);
    const refs = {
      products: many(250).map((i) => ({ id: randomUUID(), name: { en: `Product ${i}` } })),
      sessions: many(201).map((i) => ({ id: randomUUID(), title: `Event ${i}` })),
      forms: many(300).map((i) => ({ slug: `form-${i}`, name: `Form ${i}` })),
      pages: many(220).map((i) => ({ id: randomUUID(), title: `Page ${i}` })),
    };
    const prompt = buildProposalPrompt({ page, base: base(), instruction: "x x x", locales: ["en"], refs, brandVoice: "" });
    const payload = JSON.parse(prompt.messages[0]!.content.split("\n")[1]!) as { references: Record<string, unknown[]> };
    expect(REF_LIST_CAP).toBe(200);
    for (const k of ["products", "sessions", "forms", "pages"]) expect(payload.references[k]).toHaveLength(200);
    expect(JSON.stringify(payload)).not.toContain("Product 200");
  });

  it("the repair round carries the previous answer and the errors", () => {
    const first = buildProposalPrompt({ page, base: base(), instruction: "x x x", locales: ["en"], refs: emptyRefs, brandVoice: "" });
    const repair = buildRepairMessages(first.messages, '{"title":{}}', ["locales: the proposal removes en"]);
    expect(repair.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(repair[2]!.content).toContain("removes en");
    expect(buildRepairMessages(first.messages, null, ["schema"]).map((m) => m.role)).toEqual(["user", "user"]);
  });

  it("the prompt sent by the job holds no email, phone or person name from the database", async () => {
    const person = await makePerson(h.db, { firstName: "Griet", lastName: "Vermeulen", email: "griet.vermeulen@example.com", phone: "+32470123456" });
    await makeProduct(h.db, { name: { "nl-BE": "Tienbeurtenkaart", "fr-BE": "Carte de dix", en: "Ten-visit card" } });
    const f = await pageWithRequest(h.db);
    const integrations = createFakeIntegrations();
    integrations.anthropic.script("site.propose_page", validAnswer(f.base));
    const res = await proposePage(makeJobCtx(h.db, "site.propose_page", { integrations }), { editRequestId: f.requestId });
    expect(res).toMatchObject({ outcome: "proposed" });
    const call = integrations.anthropic.calls[0]!.input;
    const sent = call.system + call.messages.map((m) => m.content).join("\n");
    const [requester] = await h.db.select().from(users).where(eq(users.id, f.requesterId));
    for (const secret of [person.email, person.firstName!, person.lastName!, "+32470123456", requester!.name!, requester!.email, f.requesterId]) expect(sent).not.toContain(secret);
    expect(sent).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    expect(sent).toContain("Ten-visit card");
  });
});

describe("validateProposal", () => {
  const facts = { kind: "standard" as const, legalKey: null, sessionId: null };
  const answer = () => ({ title: base().title, paths: base().paths, blocks: base().blocks, seo: {}, changeSummary: "Same" });

  it("accepts a proposal that keeps the locales and returns its content", () => {
    const res = validateProposal(base(), answer(), facts);
    expect(res).toMatchObject({ ok: true, content: { locales: ["nl-BE", "en"], changeSummary: "Same" } });
  });

  it("refuses a kind, legal key or session change and a dropped locale", () => {
    expect(validateProposal(base(), { ...answer(), kind: "landing" }, facts)).toMatchObject({ ok: false });
    expect(validateProposal(base(), { ...answer(), legalKey: "terms" }, facts)).toMatchObject({ ok: false });
    expect(validateProposal(base(), { ...answer(), sessionId: randomUUID() }, facts)).toMatchObject({ ok: false });
    expect(validateProposal(base(), { ...answer(), kind: "standard" }, facts)).toMatchObject({ ok: true });
    const dropped = { ...answer(), title: { "nl-BE": "Over ons" }, blocks: { "nl-BE": base().blocks["nl-BE"] }, paths: { "nl-BE": "over-ons" } };
    const res = validateProposal(base(), dropped, facts);
    expect(res.ok).toBe(false);
    expect(!res.ok && res.errors.join()).toContain("removes en");
  });

  it("refuses a kept id reused for another block type, legal_meta off legal pages and a home path change", () => {
    const reused = { ...answer(), blocks: { ...base().blocks, en: [{ id: "11111111-1111-4111-8111-111111111111", type: "legal_meta" }] } };
    const res = validateProposal(base(), reused, facts);
    expect(!res.ok && res.errors.join("\n")).toMatch(/may not be reused[\s\S]*legal_meta is allowed only/);
    const home = validateProposal({ ...base(), paths: { "nl-BE": "", en: "" } }, { ...answer(), paths: { "nl-BE": "home", en: "" } }, { ...facts, kind: "home" });
    expect(!home.ok && home.errors.join()).toContain('home page path is ""');
  });

  it("refuses references outside the base and the given lists", () => {
    const productId = randomUUID();
    const withTable = { ...answer(), blocks: { ...base().blocks, en: [...base().blocks.en!, { id: randomUUID(), type: "pricing_table", productIds: [productId], showMemberPrice: false }] } };
    expect(validateProposal(base(), withTable, facts, { known: { productIds: [] } })).toMatchObject({ ok: false, errors: [expect.stringContaining(`unknown product ${productId}`)] });
    expect(validateProposal(base(), withTable, facts, { known: { productIds: [productId] } })).toMatchObject({ ok: true });
    const image = { ...answer(), blocks: { ...base().blocks, en: [...base().blocks.en!, { id: randomUUID(), type: "image", mediaId: randomUUID() }] } };
    expect(validateProposal(base(), image, facts, { known: {} })).toMatchObject({ ok: false });
  });

  it("without a base, every requested locale must be filled", () => {
    const res = validateProposal(null, answer(), facts, { targetLocales: ["nl-BE", "fr-BE"] });
    expect(!res.ok && res.errors.join()).toContain("does not fill fr-BE");
  });
});
