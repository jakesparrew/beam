/** forms-P3: the submission pipeline (rules U1 to U11, ID1 to ID9, ID11, C1 to C5, A3, A5, A6, E1 to E4). */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { activityEvents, consentRecords, emailMessages, formSensitiveAnswers, formSubmissions, persons, tags, vFormLatestResults } from "@beam/db/schema";
import { createTestDb, makePerson } from "@beam/db/testing";
import { and, eq } from "@/lib/ctx";
import { resetRuntime } from "@/lib/testing";
import { assessment, ASSESSMENT_ANSWERS, createForm, later, lead, publicCtx, setupEnv } from "../forms-p3.fixtures";

const crm = vi.hoisted(() => ({ marketingOutcome: null as null | string, consentCalls: [] as { purpose: string; method: string; source: string }[] }));
vi.mock("@/modules/crm/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/modules/crm/api")>();
  return {
    ...real,
    recordConsent: vi.fn(async (tx: never, ctx: never, input: Parameters<typeof real.recordConsent>[2]) => {
      crm.consentCalls.push({ purpose: input.purpose, method: input.method, source: input.source });
      if (crm.marketingOutcome && ["newsletter", "events", "member_comms", "b2b"].includes(input.purpose)) {
        return { recordId: null, outcome: crm.marketingOutcome };
      }
      return real.recordConsent(tx, ctx, input);
    }),
  };
});

const { completeSubmission, markAbandoned, saveSection, startSubmission, FormClosedError, resumeSubmission } = await import("./submissions");
const { hasValidSubmission } = await import("./public-queries");
const { createIdentityToken } = await import("./tokens");
const { insertDraftVersion, publishFormVersion } = await import("./versions");

let h: DbHandle;
beforeAll(async () => {
  setupEnv();
  h = await createTestDb();
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(() => {
  crm.marketingOutcome = null;
  crm.consentCalls = [];
});

const T0 = new Date("2026-11-04T09:00:00Z");
const URL0 = "https://app.example.com/nl/f/x?utm_source=facebook&utm_medium=paid_social&utm_campaign=autumn";
let mail = 0;
const email = () => `visitor-${++mail}-${randomUUID().slice(0, 6)}@example.com`;

async function start(slug: string, o: { at?: Date; url?: string; identityToken?: string; actor?: Parameters<typeof publicCtx>[2]; locale?: "nl-BE" | "fr-BE" | "en" } = {}) {
  const ctx = publicCtx(h.db, o.at ?? T0, o.actor);
  return startSubmission(ctx.tx, ctx, { slug, locale: o.locale ?? "nl-BE", url: o.url ?? URL0, ip: "203.0.113.5", ...(o.identityToken ? { identityToken: o.identityToken } : {}) });
}

async function submit(submissionId: string, answers: Record<string, unknown>, o: { at?: Date; proof?: Record<string, string>; actor?: Parameters<typeof publicCtx>[2] } = {}) {
  const ctx = publicCtx(h.db, o.at ?? later(T0, 30), o.actor);
  return completeSubmission(ctx.tx, ctx, { submissionId, proof: o.proof ?? {}, answers: answers as never, ip: "203.0.113.5", userAgent: "vitest" });
}

const row = async (id: string) => (await h.db.select().from(formSubmissions).where(eq(formSubmissions.id, id)))[0]!;
const eventsOf = (id: string) => h.db.select().from(activityEvents).where(and(eq(activityEvents.refType, "form_submission"), eq(activityEvents.refId, id)));

/** Starts, gets the fsid-free proof via resume token (assessment has resume on) and submits. */
async function completeAssessment(slug: string, answers: Record<string, unknown>, at = later(T0, 30)) {
  const s = await start(slug);
  const r = await submit(s.submissionId, answers, { at, proof: { resumeToken: s.resumeToken! } });
  return { ...s, ...r };
}

describe("U11 status machine and U1 to U10", () => {
  it("U1: start inserts a started submission pinned to the current version, with A2 attribution", async () => {
    const f = await createForm(h.db, assessment());
    const s = await start(f.slug);
    const r = await row(s.submissionId);
    expect(r).toMatchObject({ status: "started", formVersionId: f.versionId, personId: null, identifiedBy: "none", source: "paid_meta", campaign: "autumn", funnel: "recovery-assessment" });
    expect(r.utm).toEqual({ source: "facebook", medium: "paid_social", campaign: "autumn" });
    expect(r.ipHash).toMatch(/^[0-9a-f]{64}$/);
    expect(s.resumeToken).toBeTruthy();
    expect(await eventsOf(s.submissionId)).toHaveLength(0); // E1: no person, no event
  });

  it("start refuses a draft form, an archived form (form_closed) and a locale outside the version", async () => {
    const draft = await createForm(h.db, { ...lead(), status: "draft" });
    await expect(start(draft.slug)).rejects.toThrow(/form_not_found/);
    const archived = await createForm(h.db, { ...lead(), status: "archived" });
    await expect(start(archived.slug)).rejects.toBeInstanceOf(FormClosedError);
    const nl = await createForm(h.db, { ...lead(), locales: ["nl-BE"] });
    await expect(start(nl.slug, { locale: "fr-BE" })).rejects.toThrow(/unavailable_locale/);
  });

  it("U2: started -> partial on save; the path grows; proof is required", async () => {
    const f = await createForm(h.db, assessment());
    const s = await start(f.slug);
    const ctx = publicCtx(h.db, later(T0, 10));
    await expect(saveSection(ctx.tx, ctx, { submissionId: s.submissionId, proof: {}, sectionKey: "about", answers: {} })).rejects.toThrow(/submission_not_found/);
    const r = await saveSection(ctx.tx, ctx, {
      submissionId: s.submissionId,
      proof: { resumeToken: s.resumeToken! },
      sectionKey: "about",
      answers: { email: email(), first_name: "An", sensitive_consent: true },
    });
    expect(r).toEqual({ next: { sectionKey: "sleep_stress" } });
    const after = await row(s.submissionId);
    expect(after).toMatchObject({ status: "partial", path: ["about"], currentSectionKey: "sleep_stress" });
    expect(after.answers).toMatchObject({ first_name: "An", sensitive_consent: true });
  });

  it("U9: a section with an invalid email fails validation with the field key", async () => {
    const f = await createForm(h.db, assessment());
    const s = await start(f.slug);
    const ctx = publicCtx(h.db, later(T0, 10));
    await expect(
      saveSection(ctx.tx, ctx, { submissionId: s.submissionId, proof: { resumeToken: s.resumeToken! }, sectionKey: "about", answers: { email: "nope", first_name: "An", sensitive_consent: true } }),
    ).rejects.toMatchObject({ code: "validation", fields: { email: "invalid_email" } });
  });

  it("U3, C3, C4, E1 to E4: submit completes, records events and queues the transactional result email", async () => {
    const f = await createForm(h.db, assessment());
    const mailAddr = email();
    const r = await completeAssessment(f.slug, { ...ASSESSMENT_ANSWERS, email: mailAddr });
    expect(r.resultUrl).toMatch(new RegExp(`^https://app.example.com/nl/f/${f.slug}/r/[A-Za-z0-9_-]{43}$`));
    expect(r.endingKey).toBe("result_reset");
    const sub = await row(r.submissionId);
    expect(sub).toMatchObject({ status: "completed", identifiedBy: "email", outcomeKey: "reset_now", endingKey: "result_reset", path: ["about", "sleep_stress", "habits"] });
    expect(Object.keys(sub.score!.dimensions)).toEqual(["habits"]);
    expect(sub.answers).not.toHaveProperty("sleep_hours");
    expect(sub.resultTokenExpiresAt!.getTime() - sub.completedAt!.getTime()).toBe(180 * 86_400_000);

    const consents = await h.db.select().from(consentRecords).where(eq(consentRecords.personId, sub.personId!));
    expect(consents.map((c) => c.purpose).sort()).toEqual(["assessment_result", "sensitive_processing"]); // C3: no newsletter
    expect(consents.find((c) => c.purpose === "assessment_result")).toMatchObject({ method: "form", source: `form:${f.slug}`, wordingVersion: `form:${f.slug}:v1:submit` });

    const [msg] = await h.db.select().from(emailMessages).where(eq(emailMessages.idempotencyKey, `form_result:${r.submissionId}:email`));
    expect(msg).toMatchObject({ kind: "transactional", purpose: null, personId: sub.personId, locale: "nl-BE" });
    expect(sub.resultEmailMessageId).toBe(msg!.id);

    const ev = await eventsOf(r.submissionId);
    expect(ev.map((e) => e.kind).sort()).toEqual(["assessment.result_generated", "form.completed", "form.started"]);
    for (const e of ev) {
      expect(e.isSensitive).toBe(false);
      expect(e.personId).toBe(sub.personId);
      const json = JSON.stringify(e.data);
      for (const v of ["5_6", "gt5", "Lotte", mailAddr]) expect(json).not.toContain(v);
    }
    const started = ev.find((e) => e.kind === "form.started")!;
    expect(started.occurredAt.getTime()).toBe(T0.getTime());
    expect(started.dedupeKey).toBe(`form:${r.submissionId}:started`);
    const result = ev.find((e) => e.kind === "assessment.result_generated")!;
    expect(result.data).toMatchObject({ form_slug: f.slug, outcome_key: "reset_now", result_email: "queued", form_kind: "assessment" });
    const completed = ev.find((e) => e.kind === "form.completed")!;
    expect(Object.keys(completed.data as object).sort()).toEqual(
      ["applied_tag_keys", "campaign", "dimensions", "ending_key", "entered_by_staff", "form_id", "form_kind", "form_slug", "form_version_id", "funnel", "link_key", "outcome_key", "profile_conflicts", "score", "source", "submission_id", "utm", "version", "via_import"].sort(),
    );
  });

  it("U7: a second submit returns the same result and changes nothing; save on completed is conflict", async () => {
    const f = await createForm(h.db, assessment());
    const r = await completeAssessment(f.slug, { ...ASSESSMENT_ANSWERS, email: email() });
    const before = await row(r.submissionId);
    const again = await submit(r.submissionId, { ...ASSESSMENT_ANSWERS, movement: "daily" }, { at: later(T0, 90), proof: { resumeToken: r.resumeToken! } });
    expect(again.resultUrl).toBe(r.resultUrl);
    expect(await row(r.submissionId)).toEqual(before);
    const ctx = publicCtx(h.db, later(T0, 100));
    await expect(saveSection(ctx.tx, ctx, { submissionId: r.submissionId, proof: { resumeToken: r.resumeToken! }, sectionKey: "habits", answers: {} })).rejects.toMatchObject({ code: "conflict" });
  });

  it("U4: idle open submissions become abandoned; form.abandoned only with a person; never form.completed", async () => {
    const f = await createForm(h.db, lead({ capturePartialLeads: true }));
    const anon = await start(f.slug, { at: new Date("2026-10-01T08:00:00Z") });
    const p = await makePerson(h.db);
    const known = await start(f.slug, { at: new Date("2026-10-01T08:00:00Z"), identityToken: createIdentityToken({ personId: p.id, ttlSeconds: 3600, now: new Date("2026-10-01T08:00:00Z") }) });
    const ctx = publicCtx(h.db, new Date("2026-10-02T08:00:01Z"), { kind: "system", jobId: "" });
    expect(await markAbandoned(ctx.tx, ctx, 1000)).toBeGreaterThanOrEqual(2);
    expect((await row(anon.submissionId)).status).toBe("abandoned");
    expect((await eventsOf(anon.submissionId)).length).toBe(0);
    const kinds = (await eventsOf(known.submissionId)).map((e) => e.kind).sort();
    expect(kinds).toEqual(["form.abandoned", "form.started"]);
    expect(await markAbandoned(ctx.tx, ctx, 1000)).toBe(0);
  });

  it("abandoned -> partial on save within 24 hours of abandoned_at (resume off), conflict later", async () => {
    const f = await createForm(h.db, lead());
    const s1 = await start(f.slug, { at: new Date("2026-09-01T08:00:00Z") });
    const s2 = await start(f.slug, { at: new Date("2026-09-01T08:00:00Z") });
    const job = publicCtx(h.db, new Date("2026-09-02T09:00:00Z"), { kind: "system", jobId: "" });
    await markAbandoned(job.tx, job, 1000);
    const { signSubmissionId } = await import("./tokens");
    const ok = publicCtx(h.db, new Date("2026-09-02T10:00:00Z"));
    await saveSection(ok.tx, ok, { submissionId: s1.submissionId, proof: { fsid: signSubmissionId(s1.submissionId) }, sectionKey: "contact", answers: { email: email(), first_name: "Jo" } });
    expect((await row(s1.submissionId)).status).toBe("partial");
    const late = publicCtx(h.db, new Date("2026-09-03T10:00:00Z"));
    await expect(
      saveSection(late.tx, late, { submissionId: s2.submissionId, proof: { fsid: signSubmissionId(s2.submissionId) }, sectionKey: "contact", answers: { email: email(), first_name: "Jo" } }),
    ).rejects.toThrow(/submission_expired/);
  });

  it("edge case 26: a submit after the abandon job won completes (abandoned -> partial -> completed), both events stay", async () => {
    const f = await createForm(h.db, assessment());
    const p = await makePerson(h.db, { email: email() });
    const at = new Date("2026-08-01T08:00:00Z");
    const s = await start(f.slug, { at, identityToken: createIdentityToken({ personId: p.id, ttlSeconds: 86_400 * 30, now: at }) });
    await h.db.transaction(async (tx) => {
      const job = publicCtx(h.db, new Date("2026-08-02T08:00:01Z"), { kind: "system", jobId: "" });
      await markAbandoned(tx, Object.assign(job, { tx }), 1000);
    });
    const r = await h.db.transaction(async (tx) => {
      const ctx = Object.assign(publicCtx(h.db, new Date("2026-08-02T09:00:00Z")), { tx });
      return completeSubmission(tx, ctx, { submissionId: s.submissionId, proof: { resumeToken: s.resumeToken! }, answers: { ...ASSESSMENT_ANSWERS, email: p.email! } as never, ip: "203.0.113.5", userAgent: "vitest" });
    });
    expect(r.endingKey).toBe("result_reset");
    expect((await row(s.submissionId)).status).toBe("completed");
    const kinds = (await eventsOf(s.submissionId)).map((e) => e.kind).sort();
    expect(kinds).toEqual(["assessment.result_generated", "form.abandoned", "form.completed", "form.started"]);
  });

  it("U6: a submission completes on its pinned version after a newer one is published; archived forms cannot complete", async () => {
    const a = assessment();
    const f = await createForm(h.db, a);
    const s = await start(f.slug);
    const v2 = { ...a, definition: { ...a.definition, title: { ...a.definition.title, en: "Recovery check v2" } } };
    const d = await insertDraftVersion(h.db, { formId: f.formId, ...v2, createdByUserId: null });
    await publishFormVersion(h.db, { formId: f.formId, versionId: d.versionId, publishedByUserId: null }, { skipDpiaCheck: "demo_seed" });
    await submit(s.submissionId, { ...ASSESSMENT_ANSWERS, email: email() }, { proof: { resumeToken: s.resumeToken! } });
    expect((await row(s.submissionId)).formVersionId).toBe(f.versionId);

    const g = await createForm(h.db, assessment());
    const s2 = await start(g.slug);
    const { forms } = await import("@beam/db/schema");
    await h.db.update(forms).set({ status: "archived", archivedAt: new Date() }).where(eq(forms.id, g.formId));
    await expect(submit(s2.submissionId, { ...ASSESSMENT_ANSWERS, email: email() }, { proof: { resumeToken: s2.resumeToken! } })).rejects.toBeInstanceOf(FormClosedError);
  });

  it("U10: the same person completes twice; v_form_latest_results shows the latest", async () => {
    const f = await createForm(h.db, assessment());
    const addr = email();
    await completeAssessment(f.slug, { ...ASSESSMENT_ANSWERS, email: addr });
    const second = await completeAssessment(f.slug, { ...ASSESSMENT_ANSWERS, email: addr, movement: "daily", cold_exposure: true }, later(T0, 600));
    const sub = await row(second.submissionId);
    const subs = await h.db.select().from(formSubmissions).where(and(eq(formSubmissions.formId, f.formId), eq(formSubmissions.personId, sub.personId!)));
    expect(subs).toHaveLength(2);
    const [latest] = await h.db.select().from(vFormLatestResults).where(and(eq(vFormLatestResults.personId, sub.personId!), eq(vFormLatestResults.formId, f.formId)));
    expect(latest!.submissionId).toBe(second.submissionId);
    expect(latest!.outcomeKey).toBe("keep_going");
  });

  it("U5: a resume token returns the open submission's non-sensitive answers", async () => {
    const f = await createForm(h.db, assessment());
    const s = await start(f.slug);
    const ctx = publicCtx(h.db, later(T0, 10));
    await saveSection(ctx.tx, ctx, { submissionId: s.submissionId, proof: { resumeToken: s.resumeToken! }, sectionKey: "about", answers: { email: email(), first_name: "An", sensitive_consent: true } });
    const r = await resumeSubmission(ctx.tx, ctx, { slug: f.slug, token: s.resumeToken! });
    expect(r).toMatchObject({ submissionId: s.submissionId, currentSectionKey: "sleep_stress" });
    expect(await resumeSubmission(ctx.tx, ctx, { slug: f.slug, token: "unknown" })).toBeNull();
  });
});

const person = async (id: string) => (await h.db.select().from(persons).where(eq(persons.id, id)))[0]!;
const completedEvent = async (submissionId: string) => (await eventsOf(submissionId)).find((e) => e.kind === "form.completed")!;

describe("ID1 to ID9 identity, prefill and profile", () => {
  it("ID1: a customer session identifies the submission (session > token)", async () => {
    const f = await createForm(h.db, lead());
    const p = await makePerson(h.db);
    const other = await makePerson(h.db);
    const s = await start(f.slug, {
      actor: { kind: "customer", userId: randomUUID(), personId: p.id },
      identityToken: createIdentityToken({ personId: other.id, ttlSeconds: 3600, now: T0 }),
    });
    expect(await row(s.submissionId)).toMatchObject({ personId: p.id, identifiedBy: "session" });
    expect((await eventsOf(s.submissionId)).map((e) => e.kind)).toEqual(["form.started"]);
  });

  it("ID2: a token start returns the prefill with first name, masked email and the known fields", async () => {
    const f = await createForm(h.db, lead());
    const p = await makePerson(h.db, { email: "jana.peeters@example.com", firstName: "Jana", phone: "+32470000001" });
    const s = await start(f.slug, { identityToken: createIdentityToken({ personId: p.id, formSlug: f.slug, ttlSeconds: 3600, now: T0 }) });
    expect(s.prefill).toMatchObject({ firstName: "Jana", maskedEmail: "j•••@example.com" });
    expect(s.prefill!.known).toEqual(expect.arrayContaining(["email", "first_name", "phone"]));
    expect(await row(s.submissionId)).toMatchObject({ personId: p.id, identifiedBy: "token" });
    const wrongForm = await start(f.slug, { identityToken: createIdentityToken({ personId: p.id, formSlug: "another-form", ttlSeconds: 3600, now: T0 }) });
    expect(wrongForm.prefill).toBeNull();
  });

  it("ID3, A3: a new person gets the submission locale and the acquisition once, in crm's shape", async () => {
    const f = await createForm(h.db, lead());
    const addr = email();
    const s = await start(f.slug, { locale: "fr-BE" });
    // lead has resume off: ownership is proven with the signed fsid cookie
    const { signSubmissionId } = await import("./tokens");
    await submit(s.submissionId, { email: addr, first_name: "Elise" }, { proof: { fsid: signSubmissionId(s.submissionId) } });
    const sub = await row(s.submissionId);
    const p = await person(sub.personId!);
    expect(p.locale).toBe("fr-BE");
    expect(p.acquisition).toMatchObject({ source: "paid_meta", campaign: "autumn", medium: "paid_social", funnel: "contact", form_slug: f.slug, utm: { source: "facebook" } });
    const g = await createForm(h.db, assessment());
    await completeAssessment(g.slug, { ...ASSESSMENT_ANSWERS, email: addr });
    expect((await person(sub.personId!)).acquisition).toMatchObject({ form_slug: f.slug, funnel: "contact" }); // A3: written once
  });

  it("ID4: email identification fills only empty fields and lists the conflicts; token identification overwrites", async () => {
    const f = await createForm(h.db, lead());
    const { signSubmissionId } = await import("./tokens");
    const addr = email();
    const p = await makePerson(h.db, { email: addr, firstName: "Bram", lastName: null, phone: "+32470000001" });
    const s = await start(f.slug);
    await submit(s.submissionId, { email: addr, first_name: "Bram", last_name: "Claes", phone: "+32 470 99 99 99" }, { proof: { fsid: signSubmissionId(s.submissionId) } });
    expect(await person(p.id)).toMatchObject({ phone: "+32470000001", lastName: "Claes" });
    expect((await completedEvent(s.submissionId)).data).toMatchObject({ profile_conflicts: ["phone"] });
    expect((await row(s.submissionId)).answers).toMatchObject({ phone: "+32470999999" });

    const t = await start(f.slug, { identityToken: createIdentityToken({ personId: p.id, formSlug: f.slug, ttlSeconds: 3600, now: T0 }) });
    await submit(t.submissionId, { email: addr, first_name: "Bram", phone: "+32 470 99 99 99" }, { proof: { fsid: signSubmissionId(t.submissionId) } });
    expect((await person(p.id)).phone).toBe("+32470999999");
    expect((await row(t.submissionId)).identifiedBy).toBe("token");
  });

  it("ID2, edge case 7: with a token, a changed email drops the token and links by the typed email", async () => {
    const f = await createForm(h.db, lead());
    const { signSubmissionId } = await import("./tokens");
    const p = await makePerson(h.db, { email: email() });
    const s = await start(f.slug, { identityToken: createIdentityToken({ personId: p.id, formSlug: f.slug, ttlSeconds: 3600, now: T0 }) });
    const typed = email();
    await submit(s.submissionId, { email: typed, first_name: "Someone" }, { proof: { fsid: signSubmissionId(s.submissionId) } });
    const sub = await row(s.submissionId);
    expect(sub.identifiedBy).toBe("email");
    expect((await person(sub.personId!)).email).toBe(typed);
  });

  it("ID9: capturePartialLeads links at the save with an email; off leaves no person", async () => {
    const { signSubmissionId } = await import("./tokens");
    for (const capture of [true, false]) {
      const f = await createForm(h.db, lead({ capturePartialLeads: capture }));
      const s = await start(f.slug);
      const ctx = publicCtx(h.db, later(T0, 10));
      await saveSection(ctx.tx, ctx, { submissionId: s.submissionId, proof: { fsid: signSubmissionId(s.submissionId) }, sectionKey: "contact", answers: { email: email(), first_name: "Kim" } });
      const sub = await row(s.submissionId);
      if (capture) {
        expect(sub).toMatchObject({ identifiedBy: "email", status: "partial" });
        expect((await eventsOf(s.submissionId)).map((e) => e.kind)).toEqual(["form.started"]);
      } else {
        expect(sub.personId).toBeNull();
      }
    }
  });
});

describe("ID11 health declaration validity", () => {
  it("valid on day 364, expired on day 366, any version counts", async () => {
    const f = await createForm(h.db, lead({ validityDays: 365 }));
    const { signSubmissionId } = await import("./tokens");
    const addr = email();
    const s = await start(f.slug);
    await submit(s.submissionId, { email: addr, first_name: "Vera" }, { proof: { fsid: signSubmissionId(s.submissionId) } });
    const { personId, completedAt } = await row(s.submissionId);
    const d = await insertDraftVersion(h.db, { formId: f.formId, ...lead({ validityDays: 365 }), createdByUserId: null });
    await publishFormVersion(h.db, { formId: f.formId, versionId: d.versionId, publishedByUserId: null });
    const day = (n: number) => new Date(completedAt!.getTime() + n * 86_400_000);
    expect(await hasValidSubmission(h.db, { personId: personId!, formSlug: f.slug }, day(364))).toMatchObject({ valid: true, completedAt });
    const expired = await hasValidSubmission(h.db, { personId: personId!, formSlug: f.slug }, day(366));
    expect(expired).toMatchObject({ valid: false, expiresAt: day(365) });
    expect(await hasValidSubmission(h.db, { personId: randomUUID(), formSlug: f.slug })).toEqual({ valid: false, completedAt: null, expiresAt: null });
  });
});

describe("C1 to C5 consent, A5 tags", () => {
  const leadSubmit = async (answers: Record<string, unknown>, over: Partial<Parameters<typeof lead>[0]> = {}) => {
    const f = await createForm(h.db, lead(over));
    const { signSubmissionId } = await import("./tokens");
    const s = await start(f.slug);
    const r = await submit(s.submissionId, { email: email(), first_name: "Noor", ...answers }, { proof: { fsid: signSubmissionId(s.submissionId) } });
    return { f, s, r, sub: await row(s.submissionId) };
  };

  it("C1: a ticked newsletter box records consent with the form wording version; unticked records nothing", async () => {
    const { f, sub } = await leadSubmit({ newsletter: true });
    const rows = await h.db.select().from(consentRecords).where(eq(consentRecords.personId, sub.personId!));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ purpose: "newsletter", status: "granted", method: "form", source: `form:${f.slug}`, wordingVersion: `form:${f.slug}:v1:newsletter`, refType: "form_submission", refId: sub.id });
    const none = await leadSubmit({ newsletter: false });
    expect(await h.db.select().from(consentRecords).where(eq(consentRecords.personId, none.sub.personId!))).toHaveLength(0);
  });

  it("C1: needs_confirmation is stored as pendingConfirmation and returned; skipped_minor from crm completes with skippedMinor", async () => {
    crm.marketingOutcome = "needs_confirmation";
    const a = await leadSubmit({ newsletter: true });
    expect(a.r.pendingConfirmation).toBe(true);
    expect(a.sub.consentSnapshot).toEqual([expect.objectContaining({ purpose: "newsletter", granted: false, pendingConfirmation: true })]);
    crm.marketingOutcome = "skipped_minor";
    const b = await leadSubmit({ newsletter: true });
    expect(b.sub.status).toBe("completed");
    expect(b.sub.consentSnapshot).toEqual([expect.objectContaining({ purpose: "newsletter", granted: false, skippedMinor: true })]);
  });

  it("C5: a submitted birth date under 13 makes no marketing recordConsent call; a 14-year-old's newsletter is recorded", async () => {
    const kid = await leadSubmit({ newsletter: true, birth_on: "2014-06-01" });
    expect(crm.consentCalls.filter((c) => c.purpose === "newsletter")).toHaveLength(0);
    expect(kid.sub.consentSnapshot).toEqual([expect.objectContaining({ purpose: "newsletter", skippedMinor: true })]);
    expect((await person(kid.sub.personId!)).birthOn).toBe("2014-06-01");
    const teen = await leadSubmit({ newsletter: true, birth_on: "2012-06-01" });
    expect(crm.consentCalls.filter((c) => c.purpose === "newsletter")).toHaveLength(1);
    expect(await h.db.select().from(consentRecords).where(and(eq(consentRecords.personId, teen.sub.personId!), eq(consentRecords.purpose, "newsletter")))).toHaveLength(1);
  });

  it("C5: a 14-year-old's sensitive_processing consent is refused with the guardian error", async () => {
    const f = await createForm(h.db, assessment());
    const s = await start(f.slug);
    await expect(
      submit(s.submissionId, { ...ASSESSMENT_ANSWERS, email: email(), birth_on: "2012-06-01" }, { proof: { resumeToken: s.resumeToken! } }),
    ).rejects.toMatchObject({ code: "validation", fields: { sensitive_consent: "guardian_required" } });
    expect(await h.db.select().from(formSensitiveAnswers).where(eq(formSensitiveAnswers.submissionId, s.submissionId))).toHaveLength(0);
  });

  it("A5, A6: outcome tags that exist are applied and stored; the funnel comes from the settings", async () => {
    await h.db.insert(tags).values({ key: "interest:sleep", name: { en: "Sleep" } }).onConflictDoNothing();
    const f = await createForm(h.db, assessment());
    const r = await completeAssessment(f.slug, { ...ASSESSMENT_ANSWERS, email: email() });
    const sub = await row(r.submissionId);
    expect(sub.appliedTagKeys).toEqual(["interest:sleep"]);
    expect(sub.funnel).toBe("recovery-assessment");
    expect((await completedEvent(r.submissionId)).data).toMatchObject({ applied_tag_keys: ["interest:sleep"], funnel: "recovery-assessment" });
  });
});
