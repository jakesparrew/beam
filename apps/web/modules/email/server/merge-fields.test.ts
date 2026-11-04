/**
 * email-P3: merge fields and tokens (email spec rules 13, 23, 24).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { personalise } from "@beam/email/blocks";
import { resetRuntime } from "@/lib/testing";
import { personWith } from "../email-p3.fixtures";
import { buildTokenValues, mergeFieldProblems, resolveMergeFields, type MergeFieldRegistry } from "./merge-fields";

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

describe("resolveMergeFields", () => {
  it("a resolver receives only tx, personId, the context ids and the locale", async () => {
    const title = vi.fn(() => Promise.resolve("Breathwork live"));
    const registry: MergeFieldRegistry = { "webinar.title": title };
    const out = await resolveMergeFields(
      h.db,
      { personId: "00000000-0000-4000-8000-000000000001", context: { registration_id: "reg-1", count: 3, nested: { a: 1 } }, locale: "en", names: ["webinar.title", "first_name"] },
      registry,
    );
    expect(out).toEqual({ "webinar.title": "Breathwork live" });
    const args = title.mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(Object.keys(args).sort()).toEqual(["context", "locale", "personId", "tx"]);
    expect(args.context).toEqual({ registration_id: "reg-1" });
    expect(args.locale).toBe("en");
  });

  it("an unknown name and a throwing resolver give null", async () => {
    const registry: MergeFieldRegistry = { "webinar.title": () => Promise.reject(new Error("boom")) };
    expect(await resolveMergeFields(h.db, { personId: null, context: {}, locale: "nl-BE", names: ["webinar.title", "webinar.unknown"] }, registry)).toEqual({
      "webinar.title": null,
      "webinar.unknown": null,
    });
  });
});

describe("mergeFieldProblems", () => {
  it("an unknown merge field (or token) blocks publishing; registered ones and tokens pass", () => {
    const registry: MergeFieldRegistry = { "webinar.title": () => Promise.resolve("x") };
    expect(mergeFieldProblems(["Hi {{first_name|there}}, join {{webinar.title}}"], registry)).toEqual([]);
    expect(mergeFieldProblems(["{{webinar.starts_at_local}} {{favourite_colour}}", "{{webinar.starts_at_local}}"], registry)).toEqual([
      "webinar.starts_at_local",
      "favourite_colour",
    ]);
  });
});

describe("buildTokenValues", () => {
  it("a resolver returning null renders the fallback; names and links come from the person and crm's URLs", async () => {
    const p = await personWith(h.db, { firstName: "Nele", lastName: "Peeters" });
    const registry: MergeFieldRegistry = { "webinar.title": () => Promise.resolve(null) };
    const values = await buildTokenValues(
      h.db,
      {
        personId: p.id,
        locale: "nl-BE",
        context: {},
        names: ["first_name", "full_name", "webinar.title", "preferences_url", "portal_url"],
        links: { preferencesUrl: "https://beam.be/nl/preferences/tok", unsubscribeUrl: "https://beam.be/nl/preferences/tok?confirm=unsubscribe" },
      },
      registry,
    );
    expect(values).toMatchObject({ first_name: "Nele", full_name: "Nele Peeters", "webinar.title": null, preferences_url: "https://beam.be/nl/preferences/tok" });
    expect(personalise("Hallo {{first_name}}, {{webinar.title|onze webinar}} ({{credits_remaining|0}})", values, { escape: true })).toBe("Hallo Nele, onze webinar (0)");
  });

  it("escapes values in HTML", async () => {
    const p = await personWith(h.db, { firstName: "<b>Jo</b>" });
    const values = await buildTokenValues(h.db, { personId: p.id, locale: "en", context: {}, names: ["first_name"], links: null }, {});
    expect(personalise("<p>{{first_name}}</p>", values, { escape: true })).toBe("<p>&lt;b&gt;Jo&lt;/b&gt;</p>");
  });
});
