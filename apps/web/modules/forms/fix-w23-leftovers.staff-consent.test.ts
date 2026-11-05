/** fix-w23-leftovers: staff-assisted entry (ID10) records its consents with method `staff`. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@beam/db";
import { consentRecords } from "@beam/db/schema";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import type { FormDefinition } from "@beam/core/forms";
import { eq } from "@/lib/ctx";
import { makeCtx, resetRuntime, staffActor } from "@/lib/testing";
import { createForm, intake, later, publicCtx, setupEnv } from "./forms-p3.fixtures";
import { completeSubmission, createStaffEntryUrl, startSubmission } from "./service/submissions";

let h: DbHandle;
beforeAll(async () => {
  setupEnv();
  h = await createTestDb();
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

const T0 = new Date("2026-11-04T09:00:00Z");

function healthAnswers(def: FormDefinition, email: string): Record<string, unknown> {
  const a: Record<string, unknown> = { email, first_name: "Guest", last_name: "Visitor", birth_on: "1990-05-05" };
  for (const f of Object.values(def.fields)) {
    if (f.type === "yes_no") a[f.key] = false;
    if (f.type === "acknowledgement") a[f.key] = true;
    if (f.type === "consent" && f.purpose === "sensitive_processing") a[f.key] = true;
  }
  return a;
}

describe("ID10 consents of a staff-assisted entry", () => {
  it("are recorded with method staff, source staff:<user_id> and the form wording version", async () => {
    const def = intake();
    const f = await createForm(h.db, def);
    const user = await makeUser(h.db, { roleKey: "reception" });
    const actor = staffActor({ userId: user.id, roleKey: "reception", permissions: ["persons.write"] });
    const p = await makePerson(h.db, { locale: "nl-BE" });
    const sctx = makeCtx(h.db, { actor, now: T0 });
    const pt = new URL((await createStaffEntryUrl(sctx.tx, sctx, { formId: f.formId, personId: p.id })).url).searchParams.get("pt")!;
    const ctx = publicCtx(h.db, later(T0, 5));
    const s = await startSubmission(ctx.tx, ctx, { slug: f.slug, locale: "nl-BE", url: `https://app.example.com/nl/f/${f.slug}?pt=x`, identityToken: pt, ip: "203.0.113.9" });
    const sub = publicCtx(h.db, later(T0, 600));
    await completeSubmission(sub.tx, sub, {
      submissionId: s.submissionId,
      proof: { identityToken: pt },
      answers: healthAnswers(def.definition, p.email!) as never,
      ip: "203.0.113.9",
      userAgent: "desk",
    });
    const consents = await h.db.select().from(consentRecords).where(eq(consentRecords.personId, p.id));
    expect(consents.length).toBeGreaterThan(0);
    for (const c of consents) {
      expect(c).toMatchObject({ status: "granted", method: "staff", source: `staff:${user.id}`, lawfulBasis: "consent", refType: "form_submission", refId: s.submissionId });
      expect(c.wordingVersion).toMatch(new RegExp(`^form:${f.slug}:v1:`));
    }
  });
});
