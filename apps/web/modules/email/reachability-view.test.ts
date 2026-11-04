/**
 * email-P3: `v_marketing_reachability` equals `resolveReachability()` (email spec section 2,
 * rules 55 to 57) on fixtures built through crm's real consent functions. Acceptance "suppression
 * survives an import" (email side).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { consentRecords, persons, vConsentCurrent, vMarketingReachability, vSuppressionStatus } from "@beam/db/schema";
import { seed as crmDefaults } from "@beam/db/seed/crm";
import { MARKETING_PURPOSES, resolveReachability, type MarketingPurpose } from "@beam/core/email";
import { and, eq, sql, type Tx } from "@/lib/ctx";
import { makeCtx, resetRuntime } from "@/lib/testing";
import { addSuppression, unsubscribe } from "@/modules/crm/api";
import { getReachability } from "./api";
import { consent, personWith } from "./email-p3.fixtures";

vi.mock("@/modules/automation/api", async (orig) => ({
  ...(await orig<typeof import("@/modules/automation/api")>()),
  requestSuppressionExit: vi.fn(() => Promise.resolve({ jobId: null })),
}));

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
  await crmDefaults.run(h.db, {});
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

const later = (minutes: number) => new Date(Date.now() + minutes * 60_000);

/** The view row of a person and purpose, and what the pure function says for the same inputs. */
async function compare(personId: string, purpose: MarketingPurpose) {
  const [row] = await h.db.select().from(vMarketingReachability).where(and(eq(vMarketingReachability.personId, personId), eq(vMarketingReachability.purpose, purpose)));
  const [p] = await h.db.select().from(persons).where(eq(persons.id, personId));
  const [ss] = await h.db.select().from(vSuppressionStatus).where(and(eq(vSuppressionStatus.personId, personId), eq(vSuppressionStatus.purpose, purpose)));
  const [c] = await h.db.select().from(vConsentCurrent).where(and(eq(vConsentCurrent.personId, personId), sql`${vConsentCurrent.purpose}::text = ${purpose}`));
  const expected = ss
    ? resolveReachability({ erased: !!p!.erasedAt, hasEmail: !!p!.email, restricted: !!p!.processingRestrictedAt, isSuppressed: ss.isSuppressed, consentStatus: c?.status ?? null })
    : undefined;
  return { row, expected };
}

async function expectReason(personId: string, purpose: MarketingPurpose, reason: string | null) {
  const { row, expected } = await compare(personId, purpose);
  expect(row?.blockedReason ?? null).toBe(expected);
  expect(row?.blockedReason ?? null).toBe(reason);
  expect(row?.isReachable).toBe(reason === null);
  expect((await getReachability(h.db, personId, purpose)).blockedReason).toBe(reason);
}

describe("v_marketing_reachability", () => {
  it("granted is reachable; nothing recorded is no_consent; withdrawn is withdrawn (one row per purpose)", async () => {
    const p = await personWith(h.db);
    await consent(h.db, p.id, "newsletter", "granted");
    await consent(h.db, p.id, "member_comms", "granted");
    await consent(h.db, p.id, "member_comms", "withdrawn", "form", later(1));
    const rows = await h.db.select().from(vMarketingReachability).where(eq(vMarketingReachability.personId, p.id));
    expect(rows.map((r) => r.purpose).sort()).toEqual([...MARKETING_PURPOSES].sort());
    await expectReason(p.id, "newsletter", null);
    await expectReason(p.id, "events", "no_consent");
    // A withdrawal through crm also suppresses the scope (crm rule 3.16), which outranks `withdrawn`.
    await expectReason(p.id, "member_comms", "suppressed");
  });

  it("an unsubscribe is lifted by a later preference_centre or portal grant, never by an import grant", async () => {
    const viaCentre = await personWith(h.db);
    await consent(h.db, viaCentre.id, "newsletter", "granted");
    await unsubscribe(h.db as unknown as Tx, makeCtx(h.db), { personId: viaCentre.id, purpose: "newsletter", method: "unsubscribe_link", source: "test" });
    await expectReason(viaCentre.id, "newsletter", "suppressed");
    await consent(h.db, viaCentre.id, "newsletter", "granted", "preference_centre", later(2));
    await expectReason(viaCentre.id, "newsletter", null);

    const viaPortal = await personWith(h.db);
    await unsubscribe(h.db as unknown as Tx, makeCtx(h.db), { personId: viaPortal.id, purpose: "events", method: "unsubscribe_link", source: "test" });
    await consent(h.db, viaPortal.id, "events", "granted", "portal", later(2));
    await expectReason(viaPortal.id, "events", null);

    const viaImport = await personWith(h.db);
    await unsubscribe(h.db as unknown as Tx, makeCtx(h.db), { personId: viaImport.id, purpose: "newsletter", method: "unsubscribe_link", source: "test" });
    expect((await consent(h.db, viaImport.id, "newsletter", "granted", "import", later(2))).outcome).toBe("skipped_suppressed");
    await expectReason(viaImport.id, "newsletter", "suppressed");
    // Even an import grant written past crm's guard does not lift it in the view.
    await h.db.insert(consentRecords).values({
      personId: viaImport.id,
      purpose: "newsletter",
      status: "granted",
      lawfulBasis: "consent",
      method: "import",
      source: "test:raw-import",
      wordingVersion: "newsletter@1",
      recordedAt: later(3),
      actor: { kind: "system", id: null },
    });
    await expectReason(viaImport.id, "newsletter", "suppressed");
  });

  it("a hard bounce (scope all) is never lifted, not even by a later preference_centre grant", async () => {
    const p = await personWith(h.db);
    await consent(h.db, p.id, "newsletter", "granted");
    await addSuppression(h.db as unknown as Tx, makeCtx(h.db), { email: p.email!, scope: "all", reason: "hard_bounce", source: "resend:re_1", personId: p.id });
    expect((await consent(h.db, p.id, "newsletter", "granted", "preference_centre", later(2))).outcome).not.toBe("recorded");
    for (const purpose of MARKETING_PURPOSES) await expectReason(p.id, purpose, "suppressed");
  });

  it("restricted, erased and address-less persons are unreachable for their own reason; a merged person has no row", async () => {
    const restricted = await personWith(h.db);
    await consent(h.db, restricted.id, "newsletter", "granted");
    await h.db.update(persons).set({ processingRestrictedAt: new Date() }).where(eq(persons.id, restricted.id));
    await expectReason(restricted.id, "newsletter", "restricted");

    const erased = await personWith(h.db);
    await consent(h.db, erased.id, "newsletter", "granted");
    await h.db.update(persons).set({ erasedAt: new Date() }).where(eq(persons.id, erased.id));
    await expectReason(erased.id, "newsletter", "erased");

    const noEmail = await personWith(h.db, { email: null });
    await expectReason(noEmail.id, "events", "no_email");

    const winner = await personWith(h.db);
    const loser = await personWith(h.db);
    await consent(h.db, loser.id, "newsletter", "granted");
    await h.db.update(persons).set({ mergedIntoPersonId: winner.id }).where(eq(persons.id, loser.id));
    expect(await h.db.select().from(vMarketingReachability).where(eq(vMarketingReachability.personId, loser.id))).toHaveLength(0);
    expect(await getReachability(h.db, loser.id, "newsletter")).toMatchObject({ isReachable: false });
  });
});
