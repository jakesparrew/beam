/**
 * fix-w23-leftovers (webinar-P3 request): the registration form shows crm's published consent
 * wording and sends its version back; without a published wording it falls back to the catalogue
 * label as version 1.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle, Tx } from "@beam/db";
import { consentRecords, consentWordings } from "@beam/db/schema";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import { and, eq } from "@/lib/ctx";
import { makeCtx } from "@/lib/testing";
import { makeWebinar } from "./test/factories";
import { consentWordingVersion, registerPerson, registrationConsentWordings } from "./server/registration";
import { resolveConsentWording } from "./ui/registration-form";

let h: DbHandle;

beforeAll(async () => {
  h = await createTestDb();
}, 120_000);
afterAll(async () => {
  await h.close();
});

const tx = () => h.db as unknown as Tx;
const text = (en: string) => ({ "nl-BE": `${en} (nl)`, "fr-BE": `${en} (fr)`, en });

describe("consent wording of the webinar registration form", () => {
  it("falls back to version 1 of each purpose without a published wording", async () => {
    await h.db.delete(consentWordings).where(eq(consentWordings.purpose, "events"));
    await h.db.delete(consentWordings).where(eq(consentWordings.purpose, "newsletter"));
    const w = await registrationConsentWordings(tx(), "nl-BE");
    expect(w).toEqual({ wordingVersion: "events@1,newsletter@1", events: null, newsletter: null });
  });

  it("uses crm's latest published wording in the locale, ignoring drafts", async () => {
    await h.db.insert(consentWordings).values([
      { purpose: "events", version: 3, text: text("Events v3"), publishedAt: new Date("2026-10-01T08:00:00Z") },
      { purpose: "events", version: 4, text: text("Events draft"), publishedAt: null },
      { purpose: "newsletter", version: 2, text: text("Newsletter v2"), publishedAt: new Date("2026-10-01T08:00:00Z") },
    ]);
    const w = await registrationConsentWordings(tx(), "fr-BE");
    expect(w).toEqual({ wordingVersion: "events@3,newsletter@2", events: "Events v3 (fr)", newsletter: "Newsletter v2 (fr)" });
  });

  it("the form shows crm's text when given and the catalogue label otherwise", () => {
    const labels = { consentEvents: "Catalogue events", consentNewsletter: "Catalogue newsletter" };
    expect(resolveConsentWording("v1", labels, null)).toEqual({ wordingVersion: "v1", events: "Catalogue events", newsletter: "Catalogue newsletter" });
    expect(resolveConsentWording("v1", labels, { wordingVersion: "events@3,newsletter@1", events: "crm events", newsletter: null })).toEqual({
      wordingVersion: "events@3,newsletter@1",
      events: "crm events",
      newsletter: "Catalogue newsletter",
    });
  });

  it("a combined version gives each purpose its own; a single own version still works", () => {
    expect(consentWordingVersion("events", "events@3,newsletter@2")).toBe("events@3");
    expect(consentWordingVersion("newsletter", "events@3,newsletter@2")).toBe("newsletter@2");
    expect(consentWordingVersion("events", "events@5")).toBe("events@5");
    expect(consentWordingVersion("events", "v1")).toBe("events@1");
    expect(() => consentWordingVersion("events", "newsletter@2")).toThrow();
  });

  it("registering records the version the form showed", async () => {
    const owner = await makeUser(h.db);
    const webinar = await makeWebinar(h.db, { ownerUserId: owner.id }, { published: true });
    const p = await makePerson(h.db);
    const ctx = makeCtx(h.db, { actor: { kind: "public" } });
    const { wordingVersion } = await registrationConsentWordings(tx(), "en");
    await registerPerson(ctx.tx, ctx, { webinarId: webinar.id, personId: p.id, source: "site", locale: "en", utm: {}, consents: { events: true, newsletter: true }, wordingVersion });
    const rows = await h.db.select().from(consentRecords).where(and(eq(consentRecords.personId, p.id)));
    expect(Object.fromEntries(rows.map((r) => [r.purpose, r.wordingVersion]))).toEqual({ events: "events@3", newsletter: "newsletter@2" });
  });
});
