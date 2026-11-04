/**
 * crm-P7 reception card (crm spec 4.8, rules 3.54 and 3.55, cross-module D15) on PGlite:
 * `getReceptionCard` builds `declarations = { termsAccepted, healthDeclarationValid,
 * guardianConsentValid }` from site, forms and crm, shows the minor flag and the emergency
 * contact, never sensitive values, follows merges, and reads a still-stubbed sibling as "not valid".
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { personDeclarations, personSensitiveFields, personTags, persons, tags } from "@beam/db/schema";
import { NotImplementedError } from "@beam/core/errors";

process.env.SENSITIVE_DATA_KEY_V1 ??= randomBytes(32).toString("base64");

const legal = vi.hoisted(() => ({ versionId: "", terms: new Set<string>(), health: new Map<string, boolean | "stub">() }));
vi.mock("@/modules/site/api", () => ({
  getCurrentLegalVersion: (_db: unknown, key: string) =>
    Promise.resolve(key === "guardian_consent" && legal.versionId ? { versionId: legal.versionId, version: 1, requiresReacceptance: true, text: {} } : null),
  hasAcceptedCurrentTerms: (_db: unknown, personId: string) => Promise.resolve(legal.terms.has(personId)),
}));
vi.mock("@/modules/forms/api", () => ({
  hasValidSubmission: (_db: unknown, input: { personId: string; formSlug: string }) => {
    const v = legal.health.get(input.personId);
    if (v === "stub") return Promise.reject(new NotImplementedError("forms.hasValidSubmission"));
    return Promise.resolve({ valid: input.formSlug === "health-declaration" && v === true, completedAt: null, expiresAt: null });
  },
}));

const { getReceptionCard } = await import("./api");
const { setAppDb, eq } = await import("@/lib/ctx");
const { encryptSensitive, sensitiveAad } = await import("@/lib/sensitive");
const { resetRuntime } = await import("@/lib/testing");

let h: DbHandle;
let staffId: string;
const NOW = new Date("2026-11-04T10:00:00Z");

beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
  staffId = (await makeUser(h.db, { roleKey: "owner" })).id;
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(() => {
  legal.versionId = randomUUID();
  legal.terms.clear();
  legal.health.clear();
});

async function guardianConsent(minorId: string, guardianId: string, versionId = legal.versionId) {
  await h.db.insert(personDeclarations).values({
    personId: minorId,
    kind: "guardian_consent",
    documentVersionId: versionId,
    documentVersion: 1,
    method: "reception",
    guardianPersonId: guardianId,
    actor: { kind: "staff", id: staffId },
  });
}

describe("getReceptionCard (rules 3.54, 3.55)", () => {
  it("3.54 builds the three declaration states from site, forms and crm", async () => {
    const adult = await makePerson(h.db, { firstName: "Ann", lastName: "Peeters", birthOn: "1990-03-01" });
    expect((await getReceptionCard(h.db, adult.id, NOW)).declarations).toEqual({ termsAccepted: false, healthDeclarationValid: false, guardianConsentValid: false });

    legal.terms.add(adult.id);
    legal.health.set(adult.id, true);
    const card = await getReceptionCard(h.db, adult.id, NOW);
    expect(card.declarations).toEqual({ termsAccepted: true, healthDeclarationValid: true, guardianConsentValid: false });
    expect(card.name).toBe("Ann Peeters");
    expect(card.customerNumber).toMatch(/^C-\d{6}$/);
    expect(card.isMinor).toBe(false);
    expect(card.status).toBe("lead");
    expect(card.isMember).toBe(false);
  });

  it("3.54 a minor with a current guardian consent is valid; a new version that needs re-acceptance is not", async () => {
    const guardian = await makePerson(h.db, { birthOn: "1980-01-01" });
    const minor = await makePerson(h.db, { birthOn: "2014-06-01" });
    let card = await getReceptionCard(h.db, minor.id, NOW);
    expect(card.isMinor).toBe(true);
    expect(card.declarations.guardianConsentValid).toBe(false);

    await guardianConsent(minor.id, guardian.id);
    card = await getReceptionCard(h.db, minor.id, NOW);
    expect(card.declarations.guardianConsentValid).toBe(true);

    legal.versionId = randomUUID();
    expect((await getReceptionCard(h.db, minor.id, NOW)).declarations.guardianConsentValid).toBe(false);
  });

  it("3.55 shows the emergency contact and tags, never sensitive values", async () => {
    const p = await makePerson(h.db, { emergencyContact: { name: "Bram", phone: "+32470123456", relation: "partner" } });
    const [tag] = await h.db.insert(tags).values({ key: `vip-${randomUUID().slice(0, 6)}`, name: { en: "VIP", "nl-BE": "VIP", "fr-BE": "VIP" } }).returning();
    await h.db.insert(personTags).values({ personId: p.id, tagId: tag!.id, source: "manual", addedBy: { kind: "staff", id: staffId } });
    const secret = `burn-out ${randomUUID().slice(0, 6)}`;
    const { valueEnc, keyVersion } = encryptSensitive(secret, sensitiveAad.personField(p.id, "medical"));
    await h.db.insert(personSensitiveFields).values({ personId: p.id, key: "medical", valueEnc, keyVersion });

    const card = await getReceptionCard(h.db, p.id, NOW);
    expect(card.emergencyContact).toEqual({ name: "Bram", phone: "+32470123456" });
    expect(card.tags).toEqual([tag!.key]);
    const json = JSON.stringify(card);
    expect(json).not.toContain(secret);
    expect(json).not.toContain("medical");
    expect(Object.keys(card).sort()).toEqual(["customerNumber", "declarations", "emergencyContact", "isMember", "isMinor", "name", "status", "tags"]);
  });

  it("follows a merge to the winner", async () => {
    const winner = await makePerson(h.db, { firstName: "Winner", lastName: "Person" });
    const loser = await makePerson(h.db);
    await h.db.update(persons).set({ mergedIntoPersonId: winner.id }).where(eq(persons.id, loser.id));
    legal.terms.add(winner.id);
    const card = await getReceptionCard(h.db, loser.id, NOW);
    expect(card.name).toBe("Winner Person");
    expect(card.declarations.termsAccepted).toBe(true);
  });

  it("reads a sibling that is still a stub as not valid", async () => {
    const p = await makePerson(h.db);
    legal.health.set(p.id, "stub");
    expect((await getReceptionCard(h.db, p.id, NOW)).declarations.healthDeclarationValid).toBe(false);
  });

  it("refuses an unknown person", async () => {
    await expect(getReceptionCard(h.db, randomUUID(), NOW)).rejects.toThrow();
  });
});
