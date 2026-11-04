/** forms-P3: staff-assisted entry (rule ID10, edge case 27). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@beam/db";
import { consentRecords, formSubmissions, users } from "@beam/db/schema";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import type { FormDefinition } from "@beam/core/forms";
import { eq } from "@/lib/ctx";
import { makeCtx, resetRuntime, staffActor } from "@/lib/testing";
import { createForm, intake, later, lead, publicCtx, setupEnv } from "../forms-p3.fixtures";
import { completeSubmission, createStaffEntryUrl, startSubmission } from "./submissions";
import { signSubmissionId, verifyIdentityToken } from "./tokens";

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

async function staffSetup() {
  const user = await makeUser(h.db, { roleKey: "reception" });
  const actor = staffActor({ userId: user.id, roleKey: "reception", permissions: ["persons.write"] });
  const p = await makePerson(h.db, { locale: "fr-BE" });
  return { user, actor, p };
}

describe("ID10 staff-assisted entry", () => {
  it("returns the hosted URL with a 2-hour identity token that carries s, in the person's locale", async () => {
    const f = await createForm(h.db, intake());
    const { user, actor, p } = await staffSetup();
    const ctx = makeCtx(h.db, { actor, now: T0 });
    const { url } = await createStaffEntryUrl(ctx.tx, ctx, { formId: f.formId, personId: p.id });
    const u = new URL(url);
    expect(u.pathname).toBe(`/fr/f/${f.slug}`);
    const claims = verifyIdentityToken(u.searchParams.get("pt"), T0)!;
    expect(claims).toMatchObject({ personId: p.id, formSlug: f.slug, staffUserId: user.id });
    expect(claims.expiresAt.getTime() - T0.getTime()).toBe(2 * 3600 * 1000);
    expect(verifyIdentityToken(u.searchParams.get("pt"), later(T0, 2 * 3600 + 1))).toBeNull();
  });

  it("needs persons.write and a form with staffEntryAllowed", async () => {
    const f = await createForm(h.db, intake());
    const { p } = await staffSetup();
    const denied = makeCtx(h.db, { actor: staffActor({ permissions: ["forms.write"] }), now: T0 });
    await expect(createStaffEntryUrl(denied.tx, denied, { formId: f.formId, personId: p.id })).rejects.toThrow(/persons\.write/);
    const noStaff = await createForm(h.db, lead());
    const { actor } = await staffSetup();
    const ctx = makeCtx(h.db, { actor, now: T0 });
    await expect(createStaffEntryUrl(ctx.tx, ctx, { formId: noStaff.formId, personId: p.id })).rejects.toThrow(/staff_entry_not_allowed/);
  });

  it("submit: identified_by staff, source manual, entered_by_user_id, consents with source staff:<user_id>", async () => {
    const def = intake();
    const f = await createForm(h.db, def);
    const { user, actor, p } = await staffSetup();
    const sctx = makeCtx(h.db, { actor, now: T0 });
    const pt = new URL((await createStaffEntryUrl(sctx.tx, sctx, { formId: f.formId, personId: p.id, locale: "nl-BE" })).url).searchParams.get("pt")!;
    const ctx = publicCtx(h.db, later(T0, 5));
    const s = await startSubmission(ctx.tx, ctx, { slug: f.slug, locale: "nl-BE", url: `https://app.example.com/nl/f/${f.slug}?pt=x`, identityToken: pt, ip: "203.0.113.9" });
    expect(s.prefill).not.toBeNull();
    const sub = publicCtx(h.db, later(T0, 600));
    await completeSubmission(sub.tx, sub, { submissionId: s.submissionId, proof: { identityToken: pt }, answers: healthAnswers(def.definition, p.email!) as never, ip: "203.0.113.9", userAgent: "desk" });
    const [row] = await h.db.select().from(formSubmissions).where(eq(formSubmissions.id, s.submissionId));
    expect(row).toMatchObject({ status: "completed", identifiedBy: "staff", source: "manual", enteredByUserId: user.id, personId: p.id });
    const consents = await h.db.select().from(consentRecords).where(eq(consentRecords.personId, p.id));
    expect(consents.map((c) => c.purpose)).toEqual(["sensitive_processing"]);
    expect(consents[0]).toMatchObject({ source: `staff:${user.id}` });
  });

  it("a staff token is refused after 2 hours and for a disabled staff user", async () => {
    const def = intake();
    const f = await createForm(h.db, def);
    const { user, actor, p } = await staffSetup();
    const sctx = makeCtx(h.db, { actor, now: T0 });
    const pt = new URL((await createStaffEntryUrl(sctx.tx, sctx, { formId: f.formId, personId: p.id, locale: "nl-BE" })).url).searchParams.get("pt")!;
    const ctx = publicCtx(h.db, later(T0, 5));
    const s = await startSubmission(ctx.tx, ctx, { slug: f.slug, locale: "nl-BE", url: `https://app.example.com/nl/f/${f.slug}`, identityToken: pt, ip: "203.0.113.9" });
    const late = publicCtx(h.db, later(T0, 2 * 3600 + 60));
    await expect(
      completeSubmission(late.tx, late, { submissionId: s.submissionId, proof: { identityToken: pt, fsid: signSubmissionId(s.submissionId) }, answers: healthAnswers(def.definition, p.email!) as never, ip: "203.0.113.9", userAgent: "desk" }),
    ).rejects.toThrow(/staff_token_expired/);

    await h.db.update(users).set({ status: "disabled" }).where(eq(users.id, user.id));
    const again = publicCtx(h.db, later(T0, 60));
    await expect(
      startSubmission(again.tx, again, { slug: f.slug, locale: "nl-BE", url: `https://app.example.com/nl/f/${f.slug}`, identityToken: pt, ip: "203.0.113.9" }),
    ).rejects.toThrow(/staff_user_inactive/);
    const soon = publicCtx(h.db, later(T0, 600));
    await expect(
      completeSubmission(soon.tx, soon, { submissionId: s.submissionId, proof: { identityToken: pt }, answers: healthAnswers(def.definition, p.email!) as never, ip: "203.0.113.9", userAgent: "desk" }),
    ).rejects.toThrow(/staff_user_inactive/);
  });
});
