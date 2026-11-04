/**
 * crm-P2 staff search (rule 3.6): `C-000123`, `123`, an email, a phone number in any format and
 * a name prefix; merged and erased persons never appear. Also the admin list filters.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, makePerson } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { personTags, tags } from "@beam/db/schema";
import { formatCustomerNumber } from "@beam/core/crm";
import { listPersons, parseSearch, searchPersons } from "./queries";
import { searchPersons as apiSearchPersons } from "./api";

let h: DbHandle;
const surname = `Vermeulen${randomUUID().slice(0, 6)}`;

beforeAll(async () => {
  h = await createTestDb();
});
afterAll(() => h.close());

describe("searchPersons (3.6)", () => {
  it("3.6 parses customer numbers, emails, phones and name prefixes", () => {
    expect(parseSearch("C-000123")).toMatchObject({ customerNumber: 123 });
    expect(parseSearch("c123")).toMatchObject({ customerNumber: 123 });
    expect(parseSearch("123")).toMatchObject({ customerNumber: 123, phone: null });
    expect(parseSearch("0470 12 34 56")).toMatchObject({ phone: "+32470123456" });
    expect(parseSearch("Anna@Example.com")).toMatchObject({ email: "anna@example.com" });
    expect(parseSearch("jan ver")).toMatchObject({ tsQuery: "jan:* & ver:*", customerNumber: null });
    expect(parseSearch("  ")).toMatchObject({ customerNumber: null, email: null, phone: null, tsQuery: null });
  });

  it("3.6 finds a person by customer number in both forms", async () => {
    const p = await makePerson(h.db, { lastName: surname, firstName: "Number" });
    const formatted = formatCustomerNumber(p.customerNumber);
    expect((await searchPersons(h.db, formatted))[0]!.id).toBe(p.id);
    expect((await searchPersons(h.db, String(p.customerNumber)))[0]!.id).toBe(p.id);
  });

  it("3.6 finds a person by phone in any Belgian format", async () => {
    const p = await makePerson(h.db, { phone: "0471 22 33 44", phoneE164: "+32471223344" });
    for (const q of ["0471 22 33 44", "+32 471 22 33 44", "0032471223344", "0471/22.33.44"]) {
      expect((await searchPersons(h.db, q)).map((r) => r.id)).toContain(p.id);
    }
  });

  it("3.6 finds a person by email, exact or prefix", async () => {
    const email = `zoe.${randomUUID().slice(0, 6)}@example.com`;
    const p = await makePerson(h.db, { email });
    expect((await searchPersons(h.db, email.toUpperCase()))[0]!.id).toBe(p.id);
    expect((await searchPersons(h.db, email.slice(0, 8) + "@")).map((r) => r.id)).toEqual([]);
    expect((await searchPersons(h.db, email.split("@")[0]!)).map((r) => r.id)).toContain(p.id);
  });

  it("3.6 finds persons by a name prefix and never shows merged or erased persons", async () => {
    const a = await makePerson(h.db, { firstName: "Jana", lastName: surname });
    const b = await makePerson(h.db, { firstName: "Jonas", lastName: surname });
    const merged = await makePerson(h.db, { firstName: "Jana", lastName: surname, mergedIntoPersonId: a.id });
    const erased = await makePerson(h.db, { firstName: "Jana", lastName: surname, email: null, erasedAt: new Date() });
    const ids = (await searchPersons(h.db, `ja ${surname.slice(0, 6).toLowerCase()}`)).map((r) => r.id);
    expect(ids).toContain(a.id);
    expect(ids).not.toContain(b.id);
    expect(ids).not.toContain(merged.id);
    expect(ids).not.toContain(erased.id);
    const api = await apiSearchPersons(h.db, { q: surname, limit: 100 });
    expect(api.length).toBeLessThanOrEqual(50);
    expect(api.find((r) => r.personId === a.id)).toMatchObject({ name: `Jana ${surname}`, status: "lead", customerNumber: formatCustomerNumber(a.customerNumber) });
  });

  it("listPersons filters by query, tag, locale, source and tester and pages", async () => {
    const tagKey = `f-${randomUUID().slice(0, 6)}`;
    const [tag] = await h.db.insert(tags).values({ key: tagKey, name: { en: "F" } }).returning();
    const fr = await makePerson(h.db, { lastName: surname, locale: "fr-BE", isTester: false, acquisition: { source: "event" } });
    await h.db.insert(personTags).values({ personId: fr.id, tagId: tag!.id, source: "manual", addedBy: { kind: "system", id: null } });
    const base = { page: 1, pageSize: 100, sort: "last_name" as const };
    expect((await listPersons(h.db, { ...base, tagIds: [tag!.id] })).rows.map((r) => r.id)).toEqual([fr.id]);
    expect((await listPersons(h.db, { ...base, q: surname, locale: "fr-BE" })).rows.map((r) => r.id)).toEqual([fr.id]);
    expect((await listPersons(h.db, { ...base, q: surname, source: "event", isTester: false })).rows[0]).toMatchObject({ id: fr.id, tags: [tagKey], status: "lead" });
    const all = await listPersons(h.db, { ...base, q: surname });
    const paged = await listPersons(h.db, { q: surname, page: 2, pageSize: 1, sort: "created_at" });
    expect(paged.total).toBe(all.total);
    expect(paged.rows).toHaveLength(1);
  });
});
