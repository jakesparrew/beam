/**
 * The deferred FK memberships.mandate_id -> mandates.id (fix-w05-schema-1, credits-P1's request):
 * an unknown mandate is refused and deleting a mandate sets the membership's mandate_id null.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "../client";
import { mandates } from "./commerce";
import { memberships } from "./credits";
import { createTestDb, makePerson } from "../testing";
import { makeMembership } from "../testing/credits-factories";

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
});
afterAll(() => h.close());

async function makeMandate(personId: string) {
  const [row] = await h.db
    .insert(mandates)
    .values({
      personId,
      provider: "mollie",
      providerMandateId: `mdt_${randomUUID().slice(0, 10)}`,
      providerCustomerId: `cst_${randomUUID().slice(0, 10)}`,
      method: "directdebit",
      status: "valid",
    })
    .returning();
  return row!;
}

describe("memberships.mandate_id", () => {
  it("refuses a mandate that does not exist", async () => {
    const m = await makeMembership(h.db);
    const err = await h.db
      .update(memberships)
      .set({ mandateId: randomUUID() })
      .where(eq(memberships.id, m.id))
      .then(
        () => null,
        (e: unknown) => e as { cause?: { constraint?: string } },
      );
    expect(err?.cause?.constraint).toBe("memberships_mandate_id_mandates_id_fk");
  });

  it("accepts a real mandate and sets mandate_id null when the mandate is deleted", async () => {
    const person = await makePerson(h.db);
    const mandate = await makeMandate(person.id);
    const m = await makeMembership(h.db, { personId: person.id, mandateId: mandate.id });
    expect(m.mandateId).toBe(mandate.id);
    await h.db.delete(mandates).where(eq(mandates.id, mandate.id));
    const [after] = await h.db.select().from(memberships).where(eq(memberships.id, m.id));
    expect(after!.mandateId).toBeNull();
  });
});
