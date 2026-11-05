/**
 * fix-w21-crm-wiring (crm-P10 request): the crm demo seed adds support knowledge articles for the
 * inbox AI drafts, complete in the three locales, idempotent, never overwriting a staff edit.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, makeUser } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { supportKnowledgeArticles } from "@beam/db/schema";
import { LOCALES } from "@beam/core/i18n";
import { eq } from "@/lib/ctx";
import { DEMO_KNOWLEDGE_ARTICLES, seed, seedDemoKnowledgeArticles } from "./seed";

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
});
afterAll(() => h.close());

describe("crm demo knowledge articles", () => {
  it("every article has a valid key and a title and body in every locale, within the body limit", () => {
    expect(DEMO_KNOWLEDGE_ARTICLES.length).toBeGreaterThan(0);
    for (const a of DEMO_KNOWLEDGE_ARTICLES) {
      expect(a.key).toMatch(/^[a-z0-9_-]{2,64}$/);
      for (const l of LOCALES) {
        expect(a.title[l]?.trim(), `${a.key} title ${l}`).toBeTruthy();
        expect(a.body[l]?.trim(), `${a.key} body ${l}`).toBeTruthy();
        expect(a.body[l].length).toBeLessThanOrEqual(5_000);
        expect(a.body[l]).not.toMatch(/@/); // policy text, never an address
      }
    }
  });

  it("inserts the articles once and leaves an edited article alone", async () => {
    const first = await seedDemoKnowledgeArticles(h.db);
    expect(first).toEqual({ created: DEMO_KNOWLEDGE_ARTICLES.length, skipped: 0 });
    const key = DEMO_KNOWLEDGE_ARTICLES[0]!.key;
    const edited = { "nl-BE": "Aangepast", "fr-BE": "Modifié", en: "Edited" };
    await h.db.update(supportKnowledgeArticles).set({ body: edited }).where(eq(supportKnowledgeArticles.key, key));

    const second = await seedDemoKnowledgeArticles(h.db);
    expect(second).toEqual({ created: 0, skipped: DEMO_KNOWLEDGE_ARTICLES.length });
    const [row] = await h.db.select().from(supportKnowledgeArticles).where(eq(supportKnowledgeArticles.key, key));
    expect(row).toMatchObject({ body: edited, isActive: true });
  });

  it("the demo seed facade runs the articles with the rest of the crm demo data", async () => {
    const owner = await makeUser(h.db, { roleKey: "owner" });
    const ids = new Map<string, string>([["platform.user.owner", owner.id]]);
    await h.db.delete(supportKnowledgeArticles);
    const result = await seed.run({ db: h.db, now: new Date("2026-11-03T00:00:00Z"), ids } as Parameters<typeof seed.run>[0]);
    expect(result.created).toBeGreaterThanOrEqual(DEMO_KNOWLEDGE_ARTICLES.length);
    expect((await h.db.select().from(supportKnowledgeArticles)).map((r) => r.key).sort()).toEqual(DEMO_KNOWLEDGE_ARTICLES.map((a) => a.key).sort());
  });
});
