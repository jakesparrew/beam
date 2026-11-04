import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { cookieConsents, pageEditRequests, pages, pageVersions, termsAcceptances } from "@beam/db/schema";
import { isValidRetentionSeed } from "@beam/core/privacy";
import { eq, inArray, sql } from "@/lib/ctx";
import { resetRuntime } from "@/lib/testing";
import { rowsOf } from "@/lib/sensitive";

const merged = new Map<string, string[]>();
vi.mock("@/modules/crm/api", () => ({
  resolvePersonIds: vi.fn((_db: unknown, personId: string) => Promise.resolve([personId, ...(merged.get(personId) ?? [])])),
}));

const { noPiiTables, privacy, retention, sitePrivacy } = await import("./privacy");

let handle: DbHandle;
let termsVersionId: string;
beforeAll(async () => {
  handle = await createTestDb();
  const [page] = await handle.db.insert(pages).values({ kind: "legal", slug: "terms", legalKey: "terms" }).returning();
  const [v] = await handle.db
    .insert(pageVersions)
    .values({ pageId: page!.id, version: 1, state: "published", publishedAt: new Date("2026-01-01T00:00:00Z"), title: { en: "Terms" } })
    .returning();
  await handle.db.update(pages).set({ status: "published", currentVersionId: v!.id }).where(eq(pages.id, page!.id));
  termsVersionId = v!.id;
});
afterAll(async () => {
  resetRuntime();
  await handle.close();
});

const DAY = 86_400_000;

async function accept(personId: string, opts: { acceptedAt?: Date; ip?: string | null; context?: "checkout" | "portal_prompt" } = {}) {
  const context = opts.context ?? "portal_prompt";
  const [row] = await handle.db
    .insert(termsAcceptances)
    .values({
      personId,
      pageVersionId: termsVersionId,
      legalKey: "terms",
      context,
      ip: opts.ip === undefined ? "192.0.2.10" : opts.ip,
      idempotencyKey: `terms:${personId}:${termsVersionId}:${context}:${randomUUID()}`,
      ...(opts.acceptedAt ? { acceptedAt: opts.acceptedAt } : {}),
    })
    .returning();
  return row!;
}

async function consent(personId: string | null, recordedAt?: Date) {
  const [row] = await handle.db
    .insert(cookieConsents)
    .values({ consentKey: randomUUID(), personId, choices: { analytics: true, marketing: false }, bannerVersion: 1, action: "custom", locale: "nl-BE", ipHash: "a".repeat(32), ...(recordedAt ? { recordedAt } : {}) })
    .returning();
  return row!;
}

async function subject() {
  const person = await makePerson(handle.db);
  const loser = await makePerson(handle.db);
  merged.set(person.id, [loser.id]);
  await accept(person.id, { context: "checkout" });
  await accept(loser.id);
  await consent(person.id);
  await consent(loser.id);
  return { person, loser };
}

describe("site privacy registration", () => {
  it("registers the two person tables, the spec name and the no-PII tables", () => {
    expect(sitePrivacy).toBe(privacy);
    expect([...privacy.tables].sort()).toEqual(["cookie_consents", "terms_acceptances"]);
    expect(noPiiTables).toEqual(expect.arrayContaining(["pages", "page_versions", "page_edit_requests", "site_audit_reports"]));
    expect(noPiiTables.filter((t) => privacy.tables.includes(t))).toEqual([]);
  });

  it("export lists rows of the person and of a merged-away person id, without ip_hash or consent_key", async () => {
    const s = await subject();
    const data = (await handle.db.transaction((tx) => privacy.export(tx, s.person.id))) as Record<string, Record<string, unknown>[]>;
    const acceptances = data["site/terms_acceptances.json"]!;
    expect(acceptances).toHaveLength(2);
    expect(acceptances.map((r) => r.context).sort()).toEqual(["checkout", "portal_prompt"]);
    expect(acceptances[0]).toMatchObject({ legal_key: "terms", version_ordinal: 1, ip: "192.0.2.10" });
    const consents = data["site/cookie_consents.json"]!;
    expect(consents).toHaveLength(2);
    expect(consents[0]).toMatchObject({ action: "custom", banner_version: 1, locale: "nl-BE", choices: { analytics: true, marketing: false } });
    expect(consents[0]).not.toHaveProperty("ip_hash");
    expect(consents[0]).not.toHaveProperty("consent_key");
  });

  it("erase deletes consents and anonymises acceptances; no row keeps the IP; others are untouched", async () => {
    const s = await subject();
    const other = await makePerson(handle.db);
    await accept(other.id);
    await consent(other.id);
    const report = await handle.db.transaction((tx) => privacy.erase(tx, s.person.id));
    expect(report).toEqual([
      { table: "terms_acceptances", rows: 2, action: "anonymised" },
      { table: "cookie_consents", rows: 2, action: "deleted" },
    ]);
    const ids = [s.person.id, s.loser.id];
    const kept = await handle.db.select().from(termsAcceptances).where(inArray(termsAcceptances.personId, ids));
    expect(kept).toHaveLength(2);
    expect(kept.every((r) => r.ip === null)).toBe(true);
    expect(await handle.db.select().from(cookieConsents).where(inArray(cookieConsents.personId, ids))).toHaveLength(0);
    const [otherAcceptance] = await handle.db.select().from(termsAcceptances).where(eq(termsAcceptances.personId, other.id));
    expect(otherAcceptance!.ip).toBe("192.0.2.10");
    expect(await handle.db.select().from(cookieConsents).where(eq(cookieConsents.personId, other.id))).toHaveLength(1);
  });

  it("sweep has exactly one handler per seeded retention key", () => {
    expect(Object.keys(privacy.sweep!).sort()).toEqual(["site.cookie_consents", "site.page_edit_requests", "site.terms_acceptances"]);
    expect(retention.map((r) => r.key).sort()).toEqual(Object.keys(privacy.sweep!).sort());
    for (const r of retention) expect(isValidRetentionSeed(r), r.key).toBe(true);
    expect(Object.fromEntries(retention.map((r) => [r.key, [r.tableName, r.days, r.action]]))).toEqual({
      "site.cookie_consents": ["cookie_consents", 395, "delete"],
      "site.terms_acceptances": ["terms_acceptances", 3653, "delete"],
      "site.page_edit_requests": ["page_edit_requests", 730, "delete"],
    });
  });

  it("site.terms_acceptances at 3653 days leaves a 3652-day-old acceptance untouched", async () => {
    const now = new Date("2036-11-03T12:00:00Z");
    const person = await makePerson(handle.db);
    const young = await accept(person.id, { acceptedAt: new Date(now.getTime() - 3652 * DAY) });
    const old = await accept(person.id, { acceptedAt: new Date(now.getTime() - 3654 * DAY) });
    const cutoff = new Date(now.getTime() - 3653 * DAY);
    const n = await handle.db.transaction((tx) => privacy.sweep!["site.terms_acceptances"]!(tx, cutoff));
    expect(n).toBeGreaterThanOrEqual(1);
    const left = (await handle.db.select({ id: termsAcceptances.id }).from(termsAcceptances).where(eq(termsAcceptances.personId, person.id))).map((r) => r.id);
    expect(left).toContain(young.id);
    expect(left).not.toContain(old.id);
  });

  it("site.cookie_consents and site.page_edit_requests delete rows older than the cutoff", async () => {
    const now = new Date();
    const fresh = await consent(null, new Date(now.getTime() - 10 * DAY));
    const stale = await consent(null, new Date(now.getTime() - 400 * DAY));
    const removed = await handle.db.transaction((tx) => privacy.sweep!["site.cookie_consents"]!(tx, new Date(now.getTime() - 395 * DAY)));
    expect(removed).toBeGreaterThanOrEqual(1);
    const ids = (await handle.db.select({ id: cookieConsents.id }).from(cookieConsents)).map((r) => r.id);
    expect(ids).toContain(fresh.id);
    expect(ids).not.toContain(stale.id);

    const user = await makeUser(handle.db);
    const [page] = await handle.db.insert(pages).values({ kind: "standard", slug: `p-${randomUUID().slice(0, 8)}` }).returning();
    const [oldReq] = await handle.db
      .insert(pageEditRequests)
      .values({ pageId: page!.id, instruction: "Maak korter", locales: ["nl-BE"], requestedByUserId: user.id, status: "succeeded", createdAt: new Date(now.getTime() - 800 * DAY) })
      .returning();
    const [newReq] = await handle.db.insert(pageEditRequests).values({ pageId: page!.id, instruction: "Maak langer", locales: ["nl-BE"], requestedByUserId: user.id }).returning();
    await handle.db.insert(pageVersions).values({ pageId: page!.id, version: 1, state: "proposed", createdBy: "claude", editRequestId: oldReq!.id });
    const swept = await handle.db.transaction((tx) => privacy.sweep!["site.page_edit_requests"]!(tx, new Date(now.getTime() - 730 * DAY)));
    expect(swept).toBe(1);
    const left = rowsOf<{ id: string }>(await handle.db.execute(sql`select id::text as id from page_edit_requests where page_id = ${page!.id}`)).map((r) => r.id);
    expect(left).toEqual([newReq!.id]);
    const [v] = await handle.db.select().from(pageVersions).where(eq(pageVersions.pageId, page!.id));
    expect(v!.editRequestId).toBeNull();
  });
});
