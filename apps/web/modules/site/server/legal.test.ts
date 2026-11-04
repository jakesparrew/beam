import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { activityEvents, pageRoutes, pages, pageVersions, settings, termsAcceptances } from "@beam/db/schema";
import type { Locale } from "@beam/core/i18n";
import { paragraphDoc, type Block, type LegalKey } from "@beam/core/site";
import { eq, NotFoundError } from "@/lib/ctx";
import { makeCtx, resetRuntime } from "@/lib/testing";

vi.mock("next/cache", () => ({ unstable_cache: (fn: (...a: unknown[]) => unknown) => fn }));

const { setAppDb } = await import("@/lib/ctx");
const { getCurrentLegalVersion, getLegalLinks, hasAcceptedCurrentTerms, recordTermsAcceptance, blocksToPlainText } = await import("./legal");

let handle: DbHandle;
const customer = { kind: "customer" as const, userId: randomUUID(), personId: randomUUID() };

beforeAll(async () => {
  handle = await createTestDb();
  setAppDb(handle.db);
  await handle.db
    .insert(settings)
    .values({ key: "site", value: { canonical_origin: "https://www.beam.example.com" } })
    .onConflictDoUpdate({ target: settings.key, set: { value: { canonical_origin: "https://www.beam.example.com" } } });
});
afterAll(async () => {
  resetRuntime();
  await handle.close();
});

let clock = Date.parse("2026-01-01T09:00:00Z");
const tick = () => new Date((clock += 60_000));

const legalBlocks = (heading: string, body: string): Block[] => [
  { id: randomUUID(), type: "rich_text", doc: { type: "doc", content: [{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: heading }] }, ...paragraphDoc(body).content] } },
  { id: randomUUID(), type: "legal_meta" },
];

/** A legal page with no version yet. */
async function legalPage(key: LegalKey): Promise<string> {
  const [p] = await handle.db.insert(pages).values({ kind: "legal", legalKey: key, slug: `legal-${key.replace(/_/g, "-")}` }).returning();
  return p!.id;
}

/** Publishes a new version of a legal page (routes per locale) and returns the version id. */
async function publish(pageId: string, input: { version: number; material?: boolean; paths: Partial<Record<Locale, string>>; text?: string }): Promise<string> {
  const db = handle.db;
  const locales = Object.keys(input.paths) as Locale[];
  const at = tick();
  const blocks = Object.fromEntries(locales.map((l) => [l, legalBlocks(`Chapter ${l}`, input.text ?? `Body ${l} v${input.version}`)]));
  const [v] = await db
    .insert(pageVersions)
    .values({
      pageId,
      version: input.version,
      state: "published",
      publishedAt: at,
      title: Object.fromEntries(locales.map((l) => [l, `Legal ${l}`])),
      paths: input.paths,
      blocks,
      locales,
      isMaterialChange: input.material ?? false,
    })
    .returning();
  await db.update(pages).set({ status: "published", currentVersionId: v!.id }).where(eq(pages.id, pageId));
  await db.delete(pageRoutes).where(eq(pageRoutes.pageId, pageId));
  for (const l of locales) await db.insert(pageRoutes).values({ pageId, locale: l, path: input.paths[l]!, versionId: v!.id });
  return v!.id;
}

type AcceptInput = Parameters<typeof recordTermsAcceptance>[2];
/** Records through a context whose `tx` is the test database (statements autocommit). */
const accept = (input: AcceptInput) => {
  const ctx = makeCtx(handle.db, { actor: customer, now: tick(), ip: "198.51.100.7" });
  return recordTermsAcceptance(ctx.tx, ctx, input);
};

describe("getCurrentLegalVersion", () => {
  it("is null while the legal page is unpublished", async () => {
    await legalPage("privacy_notice");
    expect(await getCurrentLegalVersion(handle.db, "privacy_notice")).toBeNull();
    expect(await getCurrentLegalVersion(handle.db, "cookie_notice")).toBeNull();
  });

  it("returns the ordinal, the material flag, plain text per live locale and the URLs", async () => {
    const id = await legalPage("terms");
    const v1 = await publish(id, { version: 1, paths: { "nl-BE": "voorwaarden", en: "terms" } });
    const first = await getCurrentLegalVersion(handle.db, "terms");
    expect(first).toMatchObject({ versionId: v1, version: 1, requiresReacceptance: false });
    expect(first!.text).toEqual({ "nl-BE": "Chapter nl-BE\n\nBody nl-BE v1", en: "Chapter en\n\nBody en v1" });
    expect(first!.urlByLocale).toEqual({ "nl-BE": "https://www.beam.example.com/nl/voorwaarden", en: "https://www.beam.example.com/en/terms" });
    expect(first!.publishedAt).toBeInstanceOf(Date);

    // Version numbers are ordinals of published versions, not `page_versions.version`.
    const v2 = await publish(id, { version: 5, material: true, paths: { "nl-BE": "voorwaarden", "fr-BE": "conditions" } });
    const second = await getCurrentLegalVersion(handle.db, "terms");
    expect(second).toMatchObject({ versionId: v2, version: 2, requiresReacceptance: true });
    expect(Object.keys(second!.text).sort()).toEqual(["fr-BE", "nl-BE"]);
  });

  it("resolves guardian_consent like terms", async () => {
    const id = await legalPage("guardian_consent");
    const v1 = await publish(id, { version: 1, paths: { "nl-BE": "toestemming-voogd" }, text: "Ik geef toestemming." });
    const live = await getCurrentLegalVersion(handle.db, "guardian_consent");
    expect(live).toMatchObject({ versionId: v1, version: 1, requiresReacceptance: false });
    expect(live!.text["nl-BE"]).toContain("Ik geef toestemming.");
  });

  it("ignores an archived legal page", async () => {
    const id = await legalPage("accessibility_statement");
    await publish(id, { version: 1, paths: { en: "accessibility" } });
    await handle.db.update(pages).set({ status: "archived", archivedAt: new Date() }).where(eq(pages.id, id));
    expect(await getCurrentLegalVersion(handle.db, "accessibility_statement")).toBeNull();
    await handle.db.update(pages).set({ status: "published", archivedAt: null }).where(eq(pages.id, id));
  });
});

describe("blocksToPlainText", () => {
  it("keeps headings and paragraphs, blank-line separated, and skips non-text blocks", () => {
    const text = blocksToPlainText([
      { id: randomUUID(), type: "hero", heading: "Terms", subheading: "Read carefully" },
      { id: randomUUID(), type: "legal_meta" },
      { id: randomUUID(), type: "rich_text", doc: paragraphDoc("First.", "Second.") },
    ]);
    expect(text).toBe("Terms\n\nRead carefully\n\nFirst.\n\nSecond.");
  });
});

describe("recordTermsAcceptance and hasAcceptedCurrentTerms", () => {
  it("is idempotent on its key and writes the event once", async () => {
    const person = await makePerson(handle.db);
    const terms = (await getCurrentLegalVersion(handle.db, "terms"))!;
    const input = { personId: person.id, versionId: terms.versionId, context: "checkout" as const, refType: "order" as const, refId: randomUUID(), ip: "203.0.113.5" };
    const first = await accept(input);
    const second = await accept(input);
    expect(first.created).toBe(true);
    expect(second).toEqual({ acceptanceId: first.acceptanceId, created: false });
    const rows = await handle.db.select().from(termsAcceptances).where(eq(termsAcceptances.personId, person.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ legalKey: "terms", context: "checkout", refType: "order", ip: "203.0.113.5", idempotencyKey: `terms:${person.id}:${terms.versionId}:checkout:${input.refId}` });
    const events = await handle.db.select().from(activityEvents).where(eq(activityEvents.personId, person.id));
    const accepted = events.filter((e) => e.kind === "site.terms_accepted");
    expect(accepted).toHaveLength(1);
    expect(accepted[0]!.data).toEqual({ legal_key: "terms", context: "checkout", version_ordinal: terms.version });
  });

  it("refuses an unknown or unpublished version", async () => {
    const person = await makePerson(handle.db);
    await expect(
      accept({ personId: person.id, versionId: randomUUID(), context: "signup" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("follows material changes: false after a material version, true again after accepting it, true across non-material versions", async () => {
    const person = await makePerson(handle.db);
    const termsPageId = (await handle.db.select({ id: pages.id }).from(pages).where(eq(pages.legalKey, "terms")))[0]!.id;
    expect(await hasAcceptedCurrentTerms(handle.db, person.id)).toBe(false);

    const current = (await getCurrentLegalVersion(handle.db, "terms"))!;
    await accept({ personId: person.id, versionId: current.versionId, context: "booking" });
    expect(await hasAcceptedCurrentTerms(handle.db, person.id)).toBe(true);

    await publish(termsPageId, { version: 6, material: false, paths: { "nl-BE": "voorwaarden" } });
    expect(await hasAcceptedCurrentTerms(handle.db, person.id)).toBe(true);

    const material = await publish(termsPageId, { version: 7, material: true, paths: { "nl-BE": "voorwaarden" } });
    expect(await hasAcceptedCurrentTerms(handle.db, person.id)).toBe(false);

    await accept({ personId: person.id, versionId: material, context: "portal_prompt" });
    expect(await hasAcceptedCurrentTerms(handle.db, person.id)).toBe(true);
  });

  it("counts an acceptance of a merged-away person for the winner", async () => {
    const winner = await makePerson(handle.db);
    const loser = await makePerson(handle.db, { mergedIntoPersonId: winner.id });
    const current = (await getCurrentLegalVersion(handle.db, "terms"))!;
    await accept({ personId: loser.id, versionId: current.versionId, context: "import" });
    expect(await hasAcceptedCurrentTerms(handle.db, winner.id)).toBe(true);
    expect(await hasAcceptedCurrentTerms(handle.db, loser.id)).toBe(true);
  });
});

describe("getLegalLinks", () => {
  it("gives absolute URLs of the live legal pages in the locale, including the accessibility statement", async () => {
    const cookies = await legalPage("cookie_notice");
    await publish(cookies, { version: 1, paths: { en: "cookies", "nl-BE": "cookies" } });
    const privacyId = (await handle.db.select({ id: pages.id }).from(pages).where(eq(pages.legalKey, "privacy_notice")))[0]!.id;
    await publish(privacyId, { version: 1, paths: { en: "privacy" } });
    const en = await getLegalLinks("en");
    expect(en).toEqual({
      privacy: "https://www.beam.example.com/en/privacy",
      terms: null,
      cookies: "https://www.beam.example.com/en/cookies",
      accessibility: "https://www.beam.example.com/en/accessibility",
    });
    const nl = await getLegalLinks("nl-BE");
    expect(nl.terms).toBe("https://www.beam.example.com/nl/voorwaarden");
    expect(nl.privacy).toBeNull();
    expect(nl.accessibility).toBeNull();
  });

  it("reads through the caller's transaction when one is passed (OD-15)", async () => {
    const links = await handle.db.transaction(async (tx) => getLegalLinks("en", tx));
    expect(links).toEqual({
      privacy: "https://www.beam.example.com/en/privacy",
      terms: null,
      cookies: "https://www.beam.example.com/en/cookies",
      accessibility: "https://www.beam.example.com/en/accessibility",
    });
  });
});
