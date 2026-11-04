/**
 * forms schema (forms-P1): every check and unique index of section 2 refuses its bad row, the
 * defaults hold, and the three views answer on a fresh PGlite database built from the schema.
 */
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "../client";
import { IMMUTABLE_TABLES, SENSITIVE_COLUMNS } from "./_shared";
import { bookings } from "./booking";
import { orders } from "./commerce";
import { companies } from "./crm";
import {
  formImportEvents,
  formImportSources,
  formLinks,
  formSensitiveAnswers,
  formSubmissions,
  formVersions,
  formViewsDaily,
  forms,
  type NewFormSubmissionRow,
} from "./forms";
import { vFormConversions, vFormFunnelDaily, vFormLatestResults } from "./forms.views";
import { createTestDb, makePerson, makeSession, makeUser } from "../testing";

/** The Postgres error behind a failed Drizzle query (message, SQLSTATE and constraint). */
async function pgError(promise: Promise<unknown>): Promise<{ message: string; code?: string; constraint?: string }> {
  try {
    await promise;
  } catch (error) {
    const cause =
      (error as { cause?: { message?: string; code?: string; constraint?: string } }).cause ??
      (error as { message?: string; code?: string; constraint?: string });
    return { message: String(cause.message ?? error), code: cause.code, constraint: cause.constraint };
  }
  throw new Error("expected the query to fail");
}

async function rejectsWith(promise: Promise<unknown>, code: string, constraint: string) {
  const err = await pgError(promise);
  expect(err.code, err.message).toBe(code);
  expect(`${err.constraint ?? ""} ${err.message}`).toContain(constraint);
}
const rejectsCheck = (p: Promise<unknown>, c: string) => rejectsWith(p, "23514", c);
const rejectsUnique = (p: Promise<unknown>, c: string) => rejectsWith(p, "23505", c);

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
});
afterAll(() => h.close());

const DAY = 24 * 60 * 60 * 1000;
let counter = 0;
const slug = () => `test-form-${++counter}`;

/** A draft form with one version; `published` publishes the version and sets it current. */
async function makeForm(opts: { published?: boolean } = {}) {
  const [form] = await h.db
    .insert(forms)
    .values({ slug: slug(), kind: "assessment", name: { en: "Recovery check" } })
    .returning();
  const [version] = await h.db
    .insert(formVersions)
    .values({
      formId: form!.id,
      version: 1,
      definition: { title: { en: "Recovery check" } },
      definitionHash: "hash",
      publishedAt: opts.published ? new Date() : null,
    })
    .returning();
  if (opts.published) {
    await h.db.update(forms).set({ status: "published", currentVersionId: version!.id }).where(eq(forms.id, form!.id));
  }
  return { form: form!, version: version! };
}

/** A submission of `form` (status `started`, locale `nl-BE`, funnel `form:<slug>`). */
async function submission(
  ref: { form: { id: string; slug: string }; version: { id: string } },
  values: Partial<NewFormSubmissionRow> = {},
) {
  const [row] = await h.db
    .insert(formSubmissions)
    .values({
      formId: ref.form.id,
      formVersionId: ref.version.id,
      locale: "nl-BE",
      funnel: `form:${ref.form.slug}`,
      ...values,
    })
    .returning();
  return row!;
}

const completed = (at: Date, personId: string | null = null) => ({
  status: "completed" as const,
  completedAt: at,
  personId,
});

describe("forms", () => {
  it("slug check rejects `Bad Slug`, `result` and `import` and accepts kebab case", async () => {
    for (const bad of ["Bad Slug", "result", "import", "-lead", "a".repeat(65)]) {
      await rejectsCheck(
        h.db.insert(forms).values({ slug: bad, kind: "lead", name: { en: "x" } }),
        "forms_slug_ck",
      );
    }
    await h.db.insert(forms).values({ slug: "recovery-check-2", kind: "lead", name: { en: "x" } });
  });

  it("slug is unique", async () => {
    await h.db.insert(forms).values({ slug: "unique-slug", kind: "lead", name: { en: "x" } });
    await rejectsUnique(h.db.insert(forms).values({ slug: "unique-slug", kind: "survey", name: { en: "y" } }), "forms_slug_uq");
  });

  it("status `published` without current_version_id fails", async () => {
    await rejectsCheck(
      h.db.insert(forms).values({ slug: slug(), kind: "lead", name: { en: "x" }, status: "published" }),
      "forms_published_version_ck",
    );
  });

  it("cta_warnings defaults to [] and description, archived_at, created_by are optional", async () => {
    const [row] = await h.db.insert(forms).values({ slug: slug(), kind: "intake", name: { en: "x" } }).returning();
    expect(row!.ctaWarnings).toEqual([]);
    expect(row!.status).toBe("draft");
    expect(row!.createdByUserId).toBeNull();
  });

  it("current_version_id references form_versions and blocks deleting the served version", async () => {
    await rejectsWith(
      h.db.update(forms).set({ currentVersionId: randomUUID() }).where(eq(forms.slug, "unique-slug")),
      "23503",
      "forms_current_version_id",
    );
    const { version } = await makeForm({ published: true });
    // on delete restrict raises restrict_violation (23001).
    await rejectsWith(h.db.delete(formVersions).where(eq(formVersions.id, version.id)), "23001", "current_version_id");
  });
});

describe("form_versions", () => {
  it("a second draft per form violates form_versions_one_draft_uq", async () => {
    const { form } = await makeForm();
    await rejectsUnique(
      h.db.insert(formVersions).values({ formId: form.id, version: 2, definition: {}, definitionHash: "h2" }),
      "form_versions_one_draft_uq",
    );
  });

  it("a published version and a new draft coexist; (form_id, version) is unique", async () => {
    const { form } = await makeForm({ published: true });
    await h.db.insert(formVersions).values({ formId: form.id, version: 2, definition: {}, definitionHash: "h2" });
    await rejectsUnique(
      h.db.insert(formVersions).values({ formId: form.id, version: 2, definition: {}, definitionHash: "h3", publishedAt: new Date() }),
      "form_versions_form_version_uq",
    );
  });

  it("published_by_user_id needs published_at: a draft with a publisher fails, a seed-published row without one passes", async () => {
    const user = await makeUser(h.db);
    const { form } = await makeForm({ published: true });
    await rejectsCheck(
      h.db.insert(formVersions).values({ formId: form.id, version: 2, definition: {}, definitionHash: "h", publishedByUserId: user.id }),
      "form_versions_publisher_ck",
    );
    const [seeded] = await h.db
      .insert(formVersions)
      .values({ formId: form.id, version: 3, definition: {}, definitionHash: "h", publishedAt: new Date() })
      .returning();
    expect(seeded!.publishedByUserId).toBeNull();
  });

  it("version > 0, locales within nl-BE/fr-BE/en and not empty; defaults", async () => {
    const [form] = await h.db.insert(forms).values({ slug: slug(), kind: "survey", name: { en: "x" } }).returning();
    await rejectsCheck(
      h.db.insert(formVersions).values({ formId: form!.id, version: 0, definition: {}, definitionHash: "h" }),
      "form_versions_version_ck",
    );
    for (const locales of [[], ["de"], ["nl-BE", "nl"]]) {
      await rejectsCheck(
        h.db.insert(formVersions).values({ formId: form!.id, version: 1, definition: {}, definitionHash: "h", locales }),
        "form_versions_locales_ck",
      );
    }
    const [row] = await h.db
      .insert(formVersions)
      .values({ formId: form!.id, version: 1, definition: {}, definitionHash: "h" })
      .returning();
    expect(row!.locales).toEqual(["nl-BE"]);
    expect(row!.scoring).toEqual({});
    expect(row!.sensitiveFieldKeys).toEqual([]);
    expect(row!.consentPurposes).toEqual([]);
    expect(IMMUTABLE_TABLES).toContain("form_versions");
  });
});

describe("form_submissions", () => {
  it("source check rejects `paid_social` and `guest` and accepts `paid_meta`", async () => {
    const ref = await makeForm({ published: true });
    await rejectsCheck(submission(ref, { source: "paid_social" as never }), "form_submissions_source_ck");
    await rejectsCheck(submission(ref, { source: "guest" as never }), "form_submissions_source_ck");
    const row = await submission(ref, { source: "paid_meta" });
    expect(row.source).toBe("paid_meta");
  });

  it("funnel is not null", async () => {
    const ref = await makeForm({ published: true });
    await rejectsWith(submission(ref, { funnel: null as never }), "23502", "funnel");
  });

  it("defaults: started, none, website, empty answers, path, tags, utm and consent snapshot", async () => {
    const row = await submission(await makeForm({ published: true }));
    expect(row).toMatchObject({
      status: "started",
      identifiedBy: "none",
      source: "website",
      answers: {},
      path: [],
      appliedTagKeys: [],
      utm: {},
      consentSnapshot: [],
      resultTokenVersion: 1,
      score: null,
    });
  });

  it("`completed` without completed_at fails, and completed_at needs `completed`", async () => {
    const ref = await makeForm({ published: true });
    await rejectsCheck(submission(ref, { status: "completed" }), "form_submissions_completed_ck");
    await rejectsCheck(submission(ref, { completedAt: new Date() }), "form_submissions_completed_ck");
    await submission(ref, completed(new Date()));
  });

  it("`abandoned` needs abandoned_at", async () => {
    const ref = await makeForm({ published: true });
    await rejectsCheck(submission(ref, { status: "abandoned" }), "form_submissions_abandoned_ck");
    await submission(ref, { status: "abandoned", abandonedAt: new Date() });
  });

  it("locale is nl-BE, fr-BE or en; referrer and landing path have length caps", async () => {
    const ref = await makeForm({ published: true });
    await rejectsCheck(submission(ref, { locale: "de" }), "form_submissions_locale_ck");
    await rejectsCheck(submission(ref, { referrerUrl: `https://example.com/${"a".repeat(500)}` }), "form_submissions_referrer_url_ck");
    await rejectsCheck(submission(ref, { landingPath: `/${"a".repeat(300)}` }), "form_submissions_landing_path_ck");
  });

  it("result and resume token hashes are unique; many nulls are fine", async () => {
    const ref = await makeForm({ published: true });
    await submission(ref, { resultTokenHash: "r-hash", resumeTokenHash: "s-hash" });
    await submission(ref);
    await submission(ref);
    await rejectsUnique(submission(ref, { resultTokenHash: "r-hash" }), "form_submissions_result_token_uq");
    await rejectsUnique(submission(ref, { resumeTokenHash: "s-hash" }), "form_submissions_resume_token_uq");
  });
});

describe("form_sensitive_answers", () => {
  it("value_enc is in SENSITIVE_COLUMNS with key_version", () => {
    expect(SENSITIVE_COLUMNS).toContainEqual({ table: "form_sensitive_answers", column: "value_enc", keyColumn: "key_version" });
  });

  it("one row per (submission, field) and rows cascade with their submission", async () => {
    const sub = await submission(await makeForm({ published: true }));
    const value = new Uint8Array([1, 2, 3]);
    await h.db.insert(formSensitiveAnswers).values({ submissionId: sub.id, fieldKey: "sleep_quality", valueEnc: value });
    await rejectsUnique(
      h.db.insert(formSensitiveAnswers).values({ submissionId: sub.id, fieldKey: "sleep_quality", valueEnc: value }),
      "form_sensitive_answers_uq",
    );
    const [stored] = await h.db.select().from(formSensitiveAnswers).where(eq(formSensitiveAnswers.submissionId, sub.id));
    expect(Array.from(stored!.valueEnc)).toEqual([1, 2, 3]);
    expect(stored!.keyVersion).toBe(1);
    await h.db.delete(formSubmissions).where(eq(formSubmissions.id, sub.id));
    expect(await h.db.select().from(formSensitiveAnswers).where(eq(formSensitiveAnswers.submissionId, sub.id))).toEqual([]);
  });
});

describe("form_links, form_views_daily and imports", () => {
  it("link keys are 8 chars [a-z0-9] and unique; channel defaults to `link`", async () => {
    const { form } = await makeForm({ published: true });
    const user = await makeUser(h.db);
    const base = { formId: form.id, name: "Flyer Ghent station", createdByUserId: user.id };
    const [row] = await h.db.insert(formLinks).values({ ...base, key: "flyer001" }).returning();
    expect(row).toMatchObject({ channel: "link", isActive: true, utm: {} });
    await rejectsUnique(h.db.insert(formLinks).values({ ...base, key: "flyer001" }), "form_links_key_uq");
    await rejectsCheck(h.db.insert(formLinks).values({ ...base, key: "Flyer-01" }), "form_links_key_ck");
  });

  it("partner_company_id references companies and is nulled when the company is deleted", async () => {
    const { form } = await makeForm({ published: true });
    const user = await makeUser(h.db);
    const base = { formId: form.id, name: "Partner flyer", createdByUserId: user.id };
    await rejectsWith(
      h.db.insert(formLinks).values({ ...base, key: "partnr01", partnerCompanyId: randomUUID() }),
      "23503",
      "form_links_partner_company_id_companies_id_fk",
    );
    const [company] = await h.db.insert(companies).values({ name: "Partner Gym", isPartner: true }).returning();
    const [link] = await h.db
      .insert(formLinks)
      .values({ ...base, key: "partnr02", partnerCompanyId: company!.id })
      .returning();
    await h.db.delete(companies).where(eq(companies.id, company!.id));
    const [after] = await h.db.select().from(formLinks).where(eq(formLinks.id, link!.id));
    expect(after!.partnerCompanyId).toBeNull();
  });

  it("views are counted with insert ... on conflict do update and never negative", async () => {
    const { form } = await makeForm({ published: true });
    const bump = () =>
      h.db
        .insert(formViewsDaily)
        .values({ formId: form.id, dayOn: "2026-11-03", locale: "nl-BE", views: 1 })
        .onConflictDoUpdate({
          target: [formViewsDaily.formId, formViewsDaily.dayOn, formViewsDaily.linkKey, formViewsDaily.locale],
          set: { views: sql`${formViewsDaily.views} + 1` },
        });
    await bump();
    await bump();
    const rows = await h.db.select().from(formViewsDaily).where(eq(formViewsDaily.formId, form.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ views: 2, linkKey: "" });
    await rejectsCheck(
      h.db.insert(formViewsDaily).values({ formId: form.id, dayOn: "2026-11-04", locale: "en", views: -1 }),
      "form_views_daily_views_ck",
    );
  });

  it("a duplicate import event (source_id, external_id) is ignored with on conflict do nothing", async () => {
    const { form } = await makeForm({ published: true });
    const user = await makeUser(h.db);
    const [source] = await h.db
      .insert(formImportSources)
      .values({ key: "scoreapp0001", provider: "scoreapp", name: "ScoreApp recovery", formId: form.id, tokenHash: "t", mapping: {}, createdByUserId: user.id })
      .returning();
    const event = { sourceId: source!.id, externalId: "resp-1", payload: { email: "visitor@example.com" } };
    const first = await h.db.insert(formImportEvents).values(event).onConflictDoNothing().returning();
    const second = await h.db.insert(formImportEvents).values(event).onConflictDoNothing().returning();
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
    expect(first[0]!.status).toBe("received");
    await rejectsUnique(h.db.insert(formImportEvents).values(event), "form_import_events_uq");
    await rejectsCheck(
      h.db.insert(formImportSources).values({ key: "short", provider: "typeform", name: "x", formId: form.id, tokenHash: "t", mapping: {}, createdByUserId: user.id }),
      "form_import_sources_key_ck",
    );
  });

  it("one submission per import event; deleting the submission clears the event's link", async () => {
    const ref = await makeForm({ published: true });
    const user = await makeUser(h.db);
    const [source] = await h.db
      .insert(formImportSources)
      .values({ key: "typeform0001", provider: "typeform", name: "Typeform", formId: ref.form.id, tokenHash: "t", mapping: {}, createdByUserId: user.id })
      .returning();
    const [event] = await h.db.insert(formImportEvents).values({ sourceId: source!.id, externalId: "ev-1", payload: {} }).returning();
    const sub = await submission(ref, { importEventId: event!.id, identifiedBy: "import", source: "import" });
    await rejectsUnique(submission(ref, { importEventId: event!.id }), "form_submissions_import_uq");
    await h.db.update(formImportEvents).set({ submissionId: sub.id, status: "processed" }).where(eq(formImportEvents.id, event!.id));
    await h.db.delete(formSubmissions).where(eq(formSubmissions.id, sub.id));
    const [after] = await h.db.select().from(formImportEvents).where(eq(formImportEvents.id, event!.id));
    expect(after!.submissionId).toBeNull();
  });
});

describe("views", () => {
  it("v_form_funnel_daily counts views and statuses on the Brussels day (23:30 UTC is the next day)", async () => {
    const ref = await makeForm({ published: true });
    // 2026-11-03 23:30 UTC is 2026-11-04 00:30 in Brussels (CET, UTC+1).
    const late = new Date("2026-11-03T23:30:00Z");
    const early = new Date("2026-11-03T10:00:00Z");
    await submission(ref, { startedAt: late });
    await submission(ref, { startedAt: late, status: "partial", path: ["intro"] });
    await submission(ref, { startedAt: late, ...completed(late) });
    await submission(ref, { startedAt: early, status: "abandoned", abandonedAt: early });
    await submission(ref, { startedAt: early, path: ["intro"] });
    await h.db.insert(formViewsDaily).values([
      { formId: ref.form.id, dayOn: "2026-11-04", locale: "nl-BE", views: 7 },
      { formId: ref.form.id, dayOn: "2026-11-04", linkKey: "flyer001", locale: "fr-BE", views: 3 },
      { formId: ref.form.id, dayOn: "2026-11-02", locale: "en", views: 4 },
    ]);
    const rows = await h.db.select().from(vFormFunnelDaily).where(eq(vFormFunnelDaily.formId, ref.form.id)).orderBy(vFormFunnelDaily.dayOn);
    expect(rows).toEqual([
      { formId: ref.form.id, dayOn: "2026-11-02", views: 4, started: 0, engaged: 0, completed: 0, abandoned: 0 },
      { formId: ref.form.id, dayOn: "2026-11-03", views: 0, started: 2, engaged: 1, completed: 0, abandoned: 1 },
      { formId: ref.form.id, dayOn: "2026-11-04", views: 10, started: 3, engaged: 2, completed: 1, abandoned: 0 },
    ]);
  });

  it("v_form_conversions sees a booking on day 29 and ignores day 31; revenue counts paid orders in 30 days", async () => {
    const ref = await makeForm({ published: true });
    const person = await makePerson(h.db);
    const other = await makePerson(h.db);
    const at = new Date("2026-09-01T10:00:00Z");
    const sub = await submission(ref, completed(at, person.id));
    const sub2 = await submission(ref, completed(at, other.id));
    await submission(ref, completed(at)); // anonymous: not in the view
    const session = await makeSession(h.db);
    const book = (personId: string, days: number, status: "confirmed" | "cancelled" = "confirmed") =>
      h.db.insert(bookings).values({
        sessionId: session.id,
        personId,
        status,
        paidWith: "free",
        source: "portal",
        createdAt: new Date(at.getTime() + days * DAY),
        // bookings_cancelled_ck: a cancelled booking carries cancelled_at and a reason code.
        ...(status === "cancelled" ? { cancelledAt: new Date(at.getTime() + days * DAY), cancelReasonCode: "customer" as const } : {}),
      });
    await book(person.id, 29);
    await book(other.id, 31);
    await book(other.id, 2, "cancelled");
    const order = (personId: string, days: number, totalCents: number) =>
      h.db.insert(orders).values({
        personId,
        channel: "portal",
        status: "paid",
        subtotalCents: totalCents,
        vatCents: 0,
        totalCents,
        locale: "nl-BE",
        clientKey: randomUUID(),
        paidAt: new Date(at.getTime() + days * DAY),
      });
    await order(person.id, 3, 4500);
    await order(person.id, 10, 2000);
    await order(person.id, 31, 9900);
    const rows = await h.db.select().from(vFormConversions).where(eq(vFormConversions.formId, ref.form.id));
    expect(rows).toHaveLength(2);
    const mine = rows.find((r) => r.submissionId === sub.id)!;
    expect(mine.firstBookingAt).toEqual(new Date(at.getTime() + 29 * DAY));
    expect(mine.firstPaidAt).toEqual(new Date(at.getTime() + 3 * DAY));
    expect(mine.revenue30dCents).toBe(6500);
    expect(mine).toMatchObject({ personId: person.id, source: "website", formVersionId: ref.version.id });
    const theirs = rows.find((r) => r.submissionId === sub2.id)!;
    expect(theirs).toMatchObject({ firstBookingAt: null, firstPaidAt: null, revenue30dCents: 0 });
  });

  it("v_form_latest_results returns the newest completion per person and form", async () => {
    const ref = await makeForm({ published: true });
    const person = await makePerson(h.db);
    const t0 = new Date("2026-10-01T09:00:00Z");
    await submission(ref, { ...completed(t0, person.id), outcomeKey: "low", score: { total: 10, totalRangeKey: "low", dimensions: {} } });
    const newest = await submission(ref, {
      ...completed(new Date(t0.getTime() + 5 * DAY), person.id),
      outcomeKey: "high",
      score: { total: 42.5, totalRangeKey: "high", dimensions: {} },
    });
    await submission(ref, { personId: person.id, startedAt: new Date(t0.getTime() + 9 * DAY) }); // still open
    const rows = await h.db.select().from(vFormLatestResults).where(eq(vFormLatestResults.personId, person.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      formId: ref.form.id,
      formSlug: ref.form.slug,
      submissionId: newest.id,
      outcomeKey: "high",
      totalRangeKey: "high",
    });
    expect(Number(rows[0]!.totalScore)).toBe(42.5);
  });
});
